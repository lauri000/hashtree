import type { WorkerFactory } from './client.js';
import type {
  TreeRootInfo,
  WorkerConfig as RelayWorkerConfig,
  WorkerRequest as RelayWorkerRequest,
  WorkerResponse as RelayWorkerResponse,
} from './relay/protocol.js';

const REQUEST_TIMEOUT_MS = 30_000;

type PendingRequest = {
  resolve: (message: RelayWorkerResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type RelayWorkerRequestPayload = RelayWorkerRequest extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;

export interface TreeRootUpdate extends TreeRootInfo {
  npub: string;
  treeName: string;
}

export type {
  TreeRootInfo,
  RelayWorkerConfig,
  RelayWorkerRequest,
  RelayWorkerResponse,
};

export class RelayWorkerClient {
  private readonly workerFactory: WorkerFactory;
  private readonly config: RelayWorkerConfig;
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private initPending:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        timeoutId: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private treeRootListeners = new Set<(update: TreeRootUpdate) => void>();

  constructor(workerFactory: WorkerFactory, config: RelayWorkerConfig) {
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

      const timeoutId = setTimeout(() => {
        this.initPending = null;
        this.initPromise = null;
        reject(new Error('Worker init timed out'));
      }, REQUEST_TIMEOUT_MS);

      this.initPending = {
        resolve,
        reject,
        timeoutId,
      };

      this.worker.postMessage({
        type: 'init',
        id: this.nextRequestId('worker_init'),
        config: this.config,
      } as RelayWorkerRequest);
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

    this.worker.onmessage = (event: MessageEvent<RelayWorkerResponse>) => {
      const message = event.data;

      if (message.type === 'ready') {
        if (this.initPending) {
          clearTimeout(this.initPending.timeoutId);
          this.initPending.resolve();
          this.initPending = null;
        }
        return;
      }

      if (message.type === 'treeRootUpdate') {
        for (const listener of this.treeRootListeners) {
          const { type: _type, ...update } = message;
          listener(update);
        }
        return;
      }

      if (message.type === 'error' && message.id) {
        const errorMessage = typeof message.error === 'string' ? message.error : 'Worker error';
        this.rejectPending(message.id, new Error(errorMessage));
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

  private nextRequestId(prefix: string): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  }

  private resolvePending(id: string, message: RelayWorkerResponse): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pending.resolve(message);
    this.pendingRequests.delete(id);
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pending.reject(error);
    this.pendingRequests.delete(id);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }

    if (this.initPending) {
      clearTimeout(this.initPending.timeoutId);
      this.initPending.reject(error);
      this.initPending = null;
    }

    this.initPromise = null;
  }

  private async request(
    payload: RelayWorkerRequestPayload,
    timeoutMs = REQUEST_TIMEOUT_MS,
    transfer: Transferable[] = [],
  ): Promise<RelayWorkerResponse> {
    await this.init();
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    const id = this.nextRequestId(payload.type);
    const message = { ...payload, id } as RelayWorkerRequest;

    return new Promise<RelayWorkerResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Worker request timed out: ${payload.type}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });
      this.worker?.postMessage(message, transfer);
    });
  }

  async registerMediaPort(port: MessagePort, debug?: boolean): Promise<void> {
    await this.init();
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    this.worker.postMessage({ type: 'registerMediaPort', port, debug } as RelayWorkerRequest, [port]);
  }

  async getTreeRootInfo(npub: string, treeName: string): Promise<TreeRootInfo | null> {
    const res = await this.request({ type: 'getTreeRootInfo', npub, treeName });
    if (res.type !== 'treeRootInfo') {
      throw new Error('Unexpected tree root response');
    }
    if (res.error) {
      throw new Error(res.error);
    }
    return res.record ?? null;
  }

  async subscribeTreeRoots(pubkey: string): Promise<void> {
    const res = await this.request({ type: 'subscribeTreeRoots', pubkey });
    if (res.type !== 'void') {
      throw new Error('Unexpected tree root subscribe response');
    }
    if (res.error) {
      throw new Error(res.error);
    }
  }

  async unsubscribeTreeRoots(pubkey: string): Promise<void> {
    const res = await this.request({ type: 'unsubscribeTreeRoots', pubkey });
    if (res.type !== 'void') {
      throw new Error('Unexpected tree root unsubscribe response');
    }
    if (res.error) {
      throw new Error(res.error);
    }
  }

  onTreeRootUpdate(listener: (update: TreeRootUpdate) => void): () => void {
    this.treeRootListeners.add(listener);
    return () => {
      this.treeRootListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    try {
      const res = await this.request({ type: 'close' });
      if (res.type !== 'void' && res.type !== 'error') {
        throw new Error('Unexpected response for close');
      }
    } catch {
      // Ignore close errors and always terminate locally.
    }

    this.treeRootListeners.clear();
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    this.initPending = null;
    this.rejectAllPending(new Error('Worker closed'));
  }
}
