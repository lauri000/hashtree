/**
 * hashtree-cc Service Worker
 *
 * Handles /htree/{nhash}/{filename} requests by streaming bytes from the
 * hashtree worker via a registered MessagePort.
 */

/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<unknown>;
};

const isTestMode = !!import.meta.env.VITE_TEST_MODE;
const PORT_TIMEOUT_MS = 60_000;

if (!isTestMode) {
  precacheAndRoute(self.__WB_MANIFEST);
}

if (isTestMode) {
  self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })());
  });
}

interface HtreeFileRequest {
  type: 'hashtree-file';
  requestId: string;
  nhash: string;
  path: string;
  start: number;
  end?: number;
  mimeType: string;
  download?: boolean;
  head?: boolean;
}

interface WorkerHeadersMessage {
  type: 'headers';
  requestId: string;
  status?: number;
  headers?: Record<string, string>;
}

interface WorkerChunkMessage {
  type: 'chunk';
  requestId: string;
  data: Uint8Array;
}

interface WorkerDoneMessage {
  type: 'done';
  requestId: string;
}

interface WorkerErrorMessage {
  type: 'error';
  requestId: string;
  message?: string;
}

type WorkerMessage = WorkerHeadersMessage | WorkerChunkMessage | WorkerDoneMessage | WorkerErrorMessage;

interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  head: boolean;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

const workerPorts = new Map<string, MessagePort>();
const workerPortsByClientKey = new Map<string, MessagePort>();
let defaultWorkerPort: MessagePort | null = null;

const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;

function guessMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogg: 'video/ogg',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    opus: 'audio/opus',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
  };
  return map[ext] || 'application/octet-stream';
}

function parseRange(rangeHeader: string | null): { start: number; end?: number } {
  if (!rangeHeader) return { start: 0 };
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return { start: 0 };
  return {
    start: match[1] ? Number.parseInt(match[1], 10) : 0,
    end: match[2] ? Number.parseInt(match[2], 10) : undefined,
  };
}

function addCORSHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getPort(clientId?: string | null, clientKey?: string | null): MessagePort | null {
  if (clientKey && workerPortsByClientKey.has(clientKey)) {
    return workerPortsByClientKey.get(clientKey) || null;
  }
  if (clientId && workerPorts.has(clientId)) {
    return workerPorts.get(clientId) || null;
  }
  return defaultWorkerPort;
}

function clearPending(requestId: string): PendingRequest | undefined {
  const pending = pendingRequests.get(requestId);
  if (!pending) return undefined;
  clearTimeout(pending.timeoutId);
  pendingRequests.delete(requestId);
  return pending;
}

function handleWorkerMessage(event: MessageEvent<WorkerMessage>): void {
  const message = event.data;
  const pending = pendingRequests.get(message.requestId);
  if (!pending) return;

  switch (message.type) {
    case 'headers': {
      const headers = new Headers(message.headers || {});
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

      if (pending.head) {
        clearPending(message.requestId);
        pending.resolve(new Response(null, {
          status: message.status || 200,
          headers,
        }));
        return;
      }

      const { readable, writable } = new TransformStream<Uint8Array>();
      pending.writer = writable.getWriter();
      pending.resolve(new Response(readable, {
        status: message.status || 200,
        headers,
      }));
      return;
    }

    case 'chunk': {
      if (!pending.writer) return;
      pending.writer.write(new Uint8Array(message.data)).catch(() => {});
      return;
    }

    case 'done': {
      pending.writer?.close().catch(() => {});
      clearPending(message.requestId);
      return;
    }

    case 'error': {
      pending.writer?.abort(message.message || 'Worker stream error').catch(() => {});
      clearPending(message.requestId);
      pending.reject(new Error(message.message || 'Worker stream error'));
      return;
    }
  }
}

function serveViaWorker(request: HtreeFileRequest, port: MessagePort): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      clearPending(request.requestId);
      reject(new Error('Timeout waiting for worker response'));
    }, PORT_TIMEOUT_MS);

    pendingRequests.set(request.requestId, {
      resolve,
      reject,
      timeoutId,
      head: !!request.head,
    });

    port.postMessage(request);
  });
}

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'PING_WORKER_PORT') {
    const source = event.source as Client | null;
    const requestId = event.data?.requestId as string | undefined;
    const clientId = source?.id ?? event.data?.clientId;
    const clientKey = event.data?.clientKey as string | undefined;
    const hasPort = !!(getPort(clientId, clientKey));
    if (requestId && source?.postMessage) {
      source.postMessage({ type: 'WORKER_PORT_PONG', requestId, ok: hasPort });
    }
    return;
  }

  if (event.data?.type === 'REGISTER_WORKER_PORT') {
    const port = (event.data?.port as MessagePort | undefined) ?? event.ports?.[0];
    if (!port) return;

    const source = event.source as Client | null;
    const clientId = source?.id ?? event.data?.clientId;
    const clientKey = event.data?.clientKey as string | undefined;

    if (clientId) {
      workerPorts.set(clientId, port);
    } else {
      defaultWorkerPort = port;
    }
    if (clientKey) {
      workerPortsByClientKey.set(clientKey, port);
    }

    port.onmessage = handleWorkerMessage;
    port.start?.();

    const requestId = event.data?.requestId as string | undefined;
    if (requestId && source?.postMessage) {
      source.postMessage({ type: 'WORKER_PORT_READY', requestId });
    }
  }
});

async function createNhashResponse(
  nhash: string,
  filePath: string,
  request: Request,
  clientId?: string | null
): Promise<Response> {
  const clientKey = new URL(request.url).searchParams.get('htree_c');
  const port = getPort(clientId, clientKey);
  if (!port) {
    return new Response('Worker port not available', { status: 503 });
  }

  const range = parseRange(request.headers.get('Range'));
  const message: HtreeFileRequest = {
    type: 'hashtree-file',
    requestId: `file_${++requestCounter}`,
    nhash,
    path: filePath,
    start: range.start,
    end: range.end,
    mimeType: guessMimeType(filePath),
    download: new URL(request.url).searchParams.get('download') === '1',
    head: request.method === 'HEAD',
  };

  try {
    return await serveViaWorker(message, port);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Streaming failed';
    return new Response(message, { status: 500 });
  }
}

self.addEventListener('fetch', (event: FetchEvent) => {
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;

  const url = new URL(event.request.url);
  const pathMatch = url.href.match(/^[^:]+:\/\/[^/]+(.*)$/);
  const rawPath = pathMatch ? pathMatch[1].split('?')[0] : url.pathname;
  const parts = rawPath.slice(1).split('/');
  if (parts[0] !== 'htree') return;

  if (parts.length >= 2 && parts[1].startsWith('nhash1')) {
    const nhash = parts[1];
    const filePath = parts.slice(2).join('/') || 'file';
    event.respondWith(
      createNhashResponse(nhash, filePath, event.request, event.clientId).then(addCORSHeaders)
    );
    return;
  }

  if (parts.length >= 3 && parts[1].startsWith('npub1')) {
    event.respondWith(new Response('npub routes are not available in hashtree-cc', { status: 501 }));
    return;
  }
});

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});
