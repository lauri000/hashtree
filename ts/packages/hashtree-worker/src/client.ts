import { generateRequestId } from '@hashtree/core';
import type {
  BlossomServerConfig,
  BlobSource,
  ConnectivityState,
  UploadProgressState,
  WorkerConfig,
  WorkerRequest,
  WorkerResponse,
} from './protocol.js';

type PendingRequest = {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export type WorkerFactory = URL | string | (new () => Worker);

const REQUEST_TIMEOUT_MS = 30_000;
type WorkerRequestPayload = WorkerRequest extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;

export class HashtreeWorkerClient {
  private readonly workerFactory: WorkerFactory;
  private readonly config: WorkerConfig;
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private connectivityListeners = new Set<(state: ConnectivityState) => void>();
  private uploadProgressListeners = new Set<(progress: UploadProgressState) => void>();

  constructor(workerFactory: WorkerFactory, config: WorkerConfig = {}) {
    this.workerFactory = workerFactory;
    this.config = config;
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    try {
      this.spawnWorker();
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.initPromise = new Promise<void>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Failed to create worker'));
        return;
      }

      const id = generateRequestId();
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Worker init timed out'));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (message) => {
          if (message.type === 'ready') {
            resolve();
            return;
          }
          reject(new Error('Unexpected init response'));
        },
        reject: (error) => reject(error),
        timeoutId,
      });

      this.worker.postMessage({
        type: 'init',
        id,
        config: this.config,
      } as WorkerRequest);
    });

    return this.initPromise;
  }

  private spawnWorker(): void {
    if (this.workerFactory instanceof URL) {
      this.worker = new Worker(this.workerFactory, { type: 'module' });
    } else if (typeof this.workerFactory === 'string') {
      this.worker = new Worker(this.workerFactory, { type: 'module' });
    } else {
      this.worker = new this.workerFactory();
    }

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.type === 'connectivityUpdate') {
        this.connectivityListeners.forEach(listener => listener(message.state));
        return;
      }

      if (message.type === 'uploadProgress') {
        this.uploadProgressListeners.forEach(listener => listener(message.progress));
        return;
      }

      if (message.type === 'error' && message.id) {
        this.rejectPending(message.id, new Error(message.error));
        return;
      }

      if ('id' in message && typeof message.id === 'string') {
        this.resolvePending(message.id, message);
      }
    };

    this.worker.onerror = (event) => {
      const errorMessage = event instanceof ErrorEvent ? event.message : 'Worker error';
      this.rejectAllPending(new Error(errorMessage));
    };
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private resolvePending(id: string, message: WorkerResponse): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pending.resolve(message);
    this.pending.delete(id);
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pending.reject(error);
    this.pending.delete(id);
  }

  private async request(
    payload: WorkerRequestPayload,
    timeoutMs = REQUEST_TIMEOUT_MS,
    transfer: Transferable[] = []
  ): Promise<WorkerResponse> {
    await this.initIfNeeded();
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    const id = generateRequestId();
    const message = { ...payload, id } as WorkerRequest;

    return new Promise<WorkerResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worker request timed out: ${payload.type}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeoutId });
      this.worker?.postMessage(message, transfer);
    });
  }

  private async initIfNeeded(): Promise<void> {
    if (!this.initPromise) {
      await this.init();
      return;
    }
    await this.initPromise;
  }

  async putBlob(data: Uint8Array, mimeType?: string, upload = true): Promise<{ hashHex: string; nhash: string }> {
    const res = await this.request({ type: 'putBlob', data, mimeType, upload });
    if (res.type !== 'blobStored') {
      throw new Error('Unexpected response for putBlob');
    }
    if (!res.hashHex || !res.nhash) {
      throw new Error('Failed to store blob');
    }
    return { hashHex: res.hashHex, nhash: res.nhash };
  }

  async getBlob(hashHex: string): Promise<{ data: Uint8Array; source: BlobSource }> {
    const res = await this.request({ type: 'getBlob', hashHex });
    if (res.type !== 'blob') {
      throw new Error('Unexpected response for getBlob');
    }
    if (res.error || !res.data || !res.source) {
      throw new Error(res.error || 'Blob not found');
    }
    return { data: res.data, source: res.source };
  }

  async setBlossomServers(servers: BlossomServerConfig[]): Promise<void> {
    const res = await this.request({ type: 'setBlossomServers', servers });
    if (res.type !== 'void') {
      throw new Error('Unexpected response for setBlossomServers');
    }
    if (res.error) {
      throw new Error(res.error);
    }
  }

  async registerMediaPort(port: MessagePort): Promise<void> {
    const res = await this.request({ type: 'registerMediaPort', port }, REQUEST_TIMEOUT_MS, [port]);
    if (res.type !== 'void') {
      throw new Error('Unexpected response for registerMediaPort');
    }
    if (res.error) {
      throw new Error(res.error);
    }
  }

  async setStorageMaxBytes(maxBytes: number): Promise<void> {
    const res = await this.request({ type: 'setStorageMaxBytes', maxBytes });
    if (res.type !== 'void') {
      throw new Error('Unexpected response for setStorageMaxBytes');
    }
    if (res.error) {
      throw new Error(res.error);
    }
  }

  async getStorageStats(): Promise<{ items: number; bytes: number; maxBytes: number }> {
    const res = await this.request({ type: 'getStorageStats' });
    if (res.type !== 'storageStats') {
      throw new Error('Unexpected response for getStorageStats');
    }
    if (res.error) {
      throw new Error(res.error);
    }
    return {
      items: res.items,
      bytes: res.bytes,
      maxBytes: res.maxBytes,
    };
  }

  async probeConnectivity(): Promise<ConnectivityState> {
    const res = await this.request({ type: 'probeConnectivity' });
    if (res.type !== 'connectivity') {
      throw new Error('Unexpected response for probeConnectivity');
    }
    if (res.error || !res.state) {
      throw new Error(res.error || 'Connectivity probe failed');
    }
    return res.state;
  }

  onConnectivityUpdate(listener: (state: ConnectivityState) => void): () => void {
    this.connectivityListeners.add(listener);
    return () => {
      this.connectivityListeners.delete(listener);
    };
  }

  onUploadProgress(listener: (progress: UploadProgressState) => void): () => void {
    this.uploadProgressListeners.add(listener);
    return () => {
      this.uploadProgressListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    try {
      await this.request({ type: 'close' });
    } catch {
      // Ignore close errors.
    }
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    this.rejectAllPending(new Error('Worker closed'));
  }
}
