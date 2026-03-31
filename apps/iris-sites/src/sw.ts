/**
 * iris sites service worker
 *
 * Handles /htree/{nhash}/{filename} requests by streaming bytes from the
 * shared hashtree worker via a registered MessagePort.
 */

/// <reference lib="webworker" />
import { getRawHtreePath, parseImmutableHtreePath, parseMutableHtreePath } from '@hashtree/worker/htree-path';
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
  npub?: string;
  nhash?: string;
  treeName?: string;
  path: string;
  start: number;
  end?: number;
  rangeHeader?: string | null;
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
  head: boolean;
  timer: ReturnType<typeof setTimeout>;
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
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    mjs: 'application/javascript',
    json: 'application/json',
    txt: 'text/plain',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    ico: 'image/x-icon',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
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
  clearTimeout(pending.timer);
  pendingRequests.delete(requestId);
  return pending;
}

function decodePathSegments(parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join('/');
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
      const finished = clearPending(message.requestId);
      finished?.writer?.close().catch(() => {});
      return;
    }

    case 'error': {
      const failed = clearPending(message.requestId);
      failed?.writer?.abort(message.message || 'Worker error').catch(() => {});
      failed?.reject(new Error(message.message || 'Worker error'));
      return;
    }
  }
}

self.addEventListener('message', (event) => {
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
    }
    // Isolated site origins only host one runtime at a time, so keep a default
    // port for iframe documents and subresource fetches whose client ids differ
    // from the top-level launcher page that performed registration.
    defaultWorkerPort = port;
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

async function serveViaWorker(request: HtreeFileRequest, port: MessagePort): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearPending(request.requestId);
      reject(new Error('Timed out waiting for worker response'));
    }, PORT_TIMEOUT_MS);

    pendingRequests.set(request.requestId, {
      resolve,
      reject,
      head: !!request.head,
      timer,
    });

    port.postMessage(request);
  });
}

async function createNhashResponse(
  target: { nhash?: string; npub?: string; treeName?: string },
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
    npub: target.npub,
    nhash: target.nhash ?? '',
    treeName: target.treeName,
    path: filePath,
    start: range.start,
    end: range.end,
    rangeHeader: request.headers.get('Range'),
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
  const rawPath = getRawHtreePath(url);
  if (!rawPath.startsWith('/htree/')) return;

  const immutablePath = parseImmutableHtreePath(rawPath);
  if (immutablePath) {
    const { nhash, filePath } = immutablePath;
    event.respondWith(
      createNhashResponse({ nhash }, filePath || 'file', event.request, event.clientId).then(addCORSHeaders)
    );
    return;
  }

  const mutablePath = parseMutableHtreePath(rawPath);
  if (mutablePath) {
    const { npub, treeName, filePath } = mutablePath;
    event.respondWith(
      createNhashResponse({ npub, treeName }, filePath || 'file', event.request, event.clientId).then(addCORSHeaders)
    );
    return;
  }
});

self.addEventListener('install', () => {
  // Waiting service workers are activated by the page reload path.
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});
