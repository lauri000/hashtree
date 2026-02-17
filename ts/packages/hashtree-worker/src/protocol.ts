export interface BlossomServerConfig {
  url: string;
  read?: boolean;
  write?: boolean;
}

export interface WorkerConfig {
  storeName?: string;
  blossomServers?: BlossomServerConfig[];
  storageMaxBytes?: number;
  connectivityProbeIntervalMs?: number;
}

export interface ConnectivityState {
  online: boolean;
  reachableReadServers: number;
  totalReadServers: number;
  reachableWriteServers: number;
  totalWriteServers: number;
  updatedAt: number;
}

export type BlobSource = 'idb' | 'blossom';

export interface UploadProgressState {
  hashHex: string;
  nhash: string;
  totalServers: number;
  processedServers: number;
  uploadedServers: number;
  skippedServers: number;
  failedServers: number;
  complete: boolean;
  error?: string;
}

export type WorkerRequest =
  | { type: 'init'; id: string; config: WorkerConfig }
  | { type: 'close'; id: string }
  | { type: 'putBlob'; id: string; data: Uint8Array; mimeType?: string; upload?: boolean }
  | { type: 'getBlob'; id: string; hashHex: string }
  | { type: 'registerMediaPort'; id: string; port: MessagePort }
  | { type: 'setBlossomServers'; id: string; servers: BlossomServerConfig[] }
  | { type: 'setStorageMaxBytes'; id: string; maxBytes: number }
  | { type: 'getStorageStats'; id: string }
  | { type: 'probeConnectivity'; id: string };

export type WorkerResponse =
  | { type: 'ready'; id: string }
  | { type: 'error'; id?: string; error: string }
  | { type: 'blobStored'; id: string; hashHex: string; nhash: string }
  | { type: 'blob'; id: string; data?: Uint8Array; source?: BlobSource; error?: string }
  | { type: 'void'; id: string; error?: string }
  | { type: 'storageStats'; id: string; items: number; bytes: number; maxBytes: number; error?: string }
  | { type: 'connectivity'; id: string; state?: ConnectivityState; error?: string }
  | { type: 'connectivityUpdate'; state: ConnectivityState }
  | { type: 'uploadProgress'; progress: UploadProgressState };
