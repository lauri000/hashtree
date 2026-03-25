/**
 * Media Streaming Handler for Hashtree Worker
 *
 * Handles media requests from the service worker via MessagePort.
 * Supports both direct CID-based requests and path-based requests with live streaming.
 */

import type { HashTree, CID } from '@hashtree/core';
import type { MediaRequestByCid, MediaRequestByPath, MediaResponse } from './protocol';
import { getCachedRoot } from './treeRootCache';
import { subscribeToTreeRoots } from './treeRootSubscription';
import { getErrorMessage } from '../utils/errorMessage';
import { nhashDecode } from '@hashtree/core';
import { nip19 } from 'nostr-tools';
import { parseHttpByteRange } from '../lib/httpRange';
import { isPlayableMediaFileName } from '../lib/playableMedia';

// Thumbnail filename patterns to look for (in priority order)
const THUMBNAIL_PATTERNS = ['thumbnail.jpg', 'thumbnail.webp', 'thumbnail.png', 'thumbnail.jpeg'];

/**
 * SW FileRequest format (from service worker)
 */
interface SwFileRequest {
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
}

/**
 * Extended response with HTTP headers for SW
 */
interface SwFileResponse {
  type: 'headers' | 'chunk' | 'done' | 'error';
  requestId: string;
  status?: number;
  headers?: Record<string, string>;
  totalSize?: number;
  data?: Uint8Array;
  message?: string;
}

interface ResolvedRootEntry {
  cid: CID;
  size?: number;
}

// Timeout for considering a stream "done" (no updates)
const LIVE_STREAM_TIMEOUT = 10000; // 10 seconds
const ROOT_WAIT_TIMEOUT_MS = 15000;
const ROOT_WAIT_INTERVAL_MS = 200;
const NHASH_HINT_DIRECTORY_TIMEOUT_MS = 250;

// Chunk size for streaming to media port
const MEDIA_CHUNK_SIZE = 256 * 1024; // 256KB chunks - matches videoChunker's firstChunkSize

// Active media streams (for live streaming - can receive updates)
interface ActiveStream {
  requestId: string;
  npub: string;
  path: string;
  offset: number;
  cancelled: boolean;
}

const activeMediaStreams = new Map<string, ActiveStream>();

let mediaPort: MessagePort | null = null;
let tree: HashTree | null = null;
let mediaDebugEnabled = false;

function logMediaDebug(event: string, data?: Record<string, unknown>): void {
  if (!mediaDebugEnabled) return;
  if (data) {
    console.log(`[WorkerMedia] ${event}`, data);
  } else {
    console.log(`[WorkerMedia] ${event}`);
  }
}

/**
 * Initialize the media handler with the HashTree instance
 */
export function initMediaHandler(hashTree: HashTree): void {
  tree = hashTree;
}

/**
 * Register a MessagePort from the service worker for media streaming
 */
export function registerMediaPort(port: MessagePort, debug?: boolean): void {
  mediaPort = port;
  mediaDebugEnabled = !!debug;
  port.start?.();

  port.onmessage = async (e: MessageEvent) => {
    const req = e.data;

    if (req.type === 'hashtree-file') {
      // SW file request format (direct from service worker)
      await handleSwFileRequest(req);
    } else if (req.type === 'media') {
      await handleMediaRequestByCid(req);
    } else if (req.type === 'mediaByPath') {
      await handleMediaRequestByPath(req);
    } else if (req.type === 'cancelMedia') {
      // Cancel an active stream
      const stream = activeMediaStreams.get(req.requestId);
      if (stream) {
        stream.cancelled = true;
        activeMediaStreams.delete(req.requestId);
      }
    }
  };

  console.log('[Worker] Media port registered');
  logMediaDebug('port:registered', { debug: mediaDebugEnabled });
}

/**
 * Handle direct CID-based media request
 */
async function handleMediaRequestByCid(req: MediaRequestByCid): Promise<void> {
  if (!tree || !mediaPort) return;

  const { requestId, cid: cidHex, start, end, mimeType } = req;

  try {
    // Convert hex CID to proper CID object
    const hash = new Uint8Array(cidHex.length / 2);
    for (let i = 0; i < hash.length; i++) {
      hash[i] = parseInt(cidHex.substr(i * 2, 2), 16);
    }
    const cid = { hash };

    // Get file size first
    const totalSize = await tree.getSize(hash);

    // Send headers
    mediaPort.postMessage({
      type: 'headers',
      requestId,
      totalSize,
      mimeType: mimeType || 'application/octet-stream',
      isLive: false,
    } as MediaResponse);

    // Read range and stream chunks
    const data = await tree.readFileRange(cid, start, end);
    if (data) {
      await streamChunksToPort(requestId, data);
    } else {
      mediaPort.postMessage({
        type: 'error',
        requestId,
        message: 'File not found',
      } as MediaResponse);
    }
  } catch (err) {
    mediaPort.postMessage({
      type: 'error',
      requestId,
      message: getErrorMessage(err),
    } as MediaResponse);
  }
}

/**
 * Handle npub/path-based media request (supports live streaming)
 */
async function handleMediaRequestByPath(req: MediaRequestByPath): Promise<void> {
  if (!tree || !mediaPort) return;

  const { requestId, npub, path, start, mimeType } = req;

  try {
    // Parse path to get tree name
    const pathParts = path.split('/').filter(Boolean);
    const treeName = pathParts[0] || 'public';
    const filePath = pathParts.slice(1).join('/');

    // Resolve npub to current CID
    let cid = await waitForCachedRoot(npub, treeName);
    if (!cid) {
      mediaPort.postMessage({
        type: 'error',
        requestId,
        message: `Tree root not found for ${npub}/${treeName}`,
      } as MediaResponse);
      return;
    }

    // Navigate to file within tree if path specified
    if (filePath) {
      const resolved = await tree.resolvePath(cid, filePath);
      if (!resolved) {
        mediaPort.postMessage({
          type: 'error',
          requestId,
          message: `File not found: ${filePath}`,
        } as MediaResponse);
        return;
      }
      cid = resolved.cid;
    }

    // Get file size
    const totalSize = await tree.getSize(cid.hash);

    // Send headers (isLive will be determined by watching for updates)
    mediaPort.postMessage({
      type: 'headers',
      requestId,
      totalSize,
      mimeType: mimeType || 'application/octet-stream',
      isLive: false, // Will update if we detect changes
    } as MediaResponse);

    // Stream initial content
    const data = await tree.readFileRange(cid, start);
    let offset = start;

    if (data) {
      await streamChunksToPort(requestId, data, false); // Don't close yet
      offset += data.length;
    }

    // Register for live updates
    const streamInfo: ActiveStream = {
      requestId,
      npub,
      path,
      offset,
      cancelled: false,
    };
    activeMediaStreams.set(requestId, streamInfo);

    // Set up tree root watcher for this npub
    // When root changes, we'll check if this file has new data
    watchTreeRootForStream(npub, treeName, filePath, streamInfo);
  } catch (err) {
    mediaPort.postMessage({
      type: 'error',
      requestId,
      message: getErrorMessage(err),
    } as MediaResponse);
  }
}

/**
 * Stream data chunks to media port
 */
async function streamChunksToPort(
  requestId: string,
  data: Uint8Array,
  sendDone = true
): Promise<void> {
  if (!mediaPort) return;

  for (let offset = 0; offset < data.length; offset += MEDIA_CHUNK_SIZE) {
    const chunk = data.slice(offset, offset + MEDIA_CHUNK_SIZE);
    mediaPort.postMessage(
      { type: 'chunk', requestId, data: chunk } as MediaResponse,
      [chunk.buffer]
    );
  }

  if (sendDone) {
    mediaPort.postMessage({ type: 'done', requestId } as MediaResponse);
  }
}

/**
 * Watch for tree root updates and push new data to stream
 */
function watchTreeRootForStream(
  npub: string,
  treeName: string,
  filePath: string,
  streamInfo: ActiveStream
): void {
  let lastActivity = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const checkForUpdates = async () => {
    if (streamInfo.cancelled || !tree || !mediaPort) {
      cleanup();
      return;
    }

    // Check if stream timed out
    if (Date.now() - lastActivity > LIVE_STREAM_TIMEOUT) {
      // No updates for a while, close the stream
      mediaPort.postMessage({
        type: 'done',
        requestId: streamInfo.requestId,
      } as MediaResponse);
      cleanup();
      return;
    }

    try {
      // Get current root
      const cid = await getCachedRoot(npub, treeName);
      if (!cid) {
        scheduleNext();
        return;
      }

      // Navigate to file
      let fileCid: CID = cid;
      if (filePath) {
        const resolved = await tree.resolvePath(cid, filePath);
        if (!resolved) {
          scheduleNext();
          return;
        }
        fileCid = resolved.cid;
      }

      // Check for new data
      const totalSize = await tree.getSize(fileCid.hash);
      if (totalSize > streamInfo.offset) {
        // New data available!
        lastActivity = Date.now();
        const newData = await tree.readFileRange(fileCid, streamInfo.offset);
        if (newData && newData.length > 0) {
          await streamChunksToPort(streamInfo.requestId, newData, false);
          streamInfo.offset += newData.length;
        }
      }
    } catch {
      // Ignore errors, just try again
    }

    scheduleNext();
  };

  const scheduleNext = () => {
    if (!streamInfo.cancelled) {
      timeoutId = setTimeout(checkForUpdates, 1000); // Check every second
    }
  };

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    activeMediaStreams.delete(streamInfo.requestId);
  };

  // Start watching
  scheduleNext();
}

/**
 * Handle file request from service worker (hashtree-file format)
 * This is the main entry point for direct SW → Worker communication
 */
async function handleSwFileRequest(req: SwFileRequest): Promise<void> {
  if (!tree || !mediaPort) return;

  const { requestId, npub, nhash, treeName, path, start, end, rangeHeader, mimeType, download } = req;
  logMediaDebug('sw:request', {
    requestId,
    npub: npub ?? null,
    nhash: nhash ?? null,
    treeName: treeName ?? null,
    path,
    start,
    end: end ?? null,
    rangeHeader: rangeHeader ?? null,
    mimeType,
    download: !!download,
  });

  try {
    let resolvedEntry: ResolvedRootEntry | null = null;

    if (nhash) {
      // Direct nhash request - decode to CID
      const rootCid = nhashDecode(nhash);
      resolvedEntry = await resolveEntryWithinRoot(rootCid, path || '', {
        allowSingleSegmentRootFallback: true,
      });
      if (!resolvedEntry) {
        sendSwError(requestId, 404, `File not found: ${path}`);
        return;
      }
    } else if (npub && treeName) {
      // Npub-based request - resolve through cached root
      const rootCid = await waitForCachedRoot(npub, treeName);
      if (!rootCid) {
        sendSwError(requestId, 404, 'Tree not found');
        return;
      }
      resolvedEntry = await resolveEntryWithinRoot(rootCid, path || '', {
        allowSingleSegmentRootFallback: false,
      });
      if (!resolvedEntry) {
        sendSwError(requestId, 404, 'File not found');
        return;
      }
    }

    if (!resolvedEntry?.cid) {
      sendSwError(requestId, 400, 'Invalid request');
      return;
    }

    // Get file size
    const totalSize = resolvedEntry.size ?? await getFileSize(resolvedEntry.cid);
    if (totalSize === null) {
      sendSwError(requestId, 404, 'File data not found');
      return;
    }

    // Stream the content
    await streamSwResponse(requestId, resolvedEntry.cid, totalSize, {
      npub,
      path,
      start,
      end,
      rangeHeader,
      mimeType,
      download,
    });
  } catch (err) {
    sendSwError(requestId, 500, getErrorMessage(err));
  }
}

async function resolveEntryWithinRoot(
  rootCid: CID,
  path: string,
  options?: { allowSingleSegmentRootFallback?: boolean }
): Promise<ResolvedRootEntry | null> {
  if (!tree) return null;

  const resolvedPath = await normalizeAliasPath(rootCid, path);
  if (!resolvedPath) {
    return { cid: rootCid };
  }

  if (
    options?.allowSingleSegmentRootFallback &&
    canFallbackToRootBlob(resolvedPath, path)
  ) {
    const isDirectory = await canListDirectory(rootCid);
    if (!isDirectory) {
      return { cid: rootCid };
    }
  }

  if (isThumbnailAliasPath(path) && resolvedPath === path) {
    return null;
  }

  const parts = resolvedPath.split('/').filter(Boolean);
  const entryName = parts.pop();
  const parentPath = parts.join('/');

  if (entryName) {
    const parentCid = parentPath
      ? (await tree.resolvePath(rootCid, parentPath))?.cid ?? null
      : rootCid;

    if (parentCid) {
      const entries = await listDirectoryWithTimeout(parentCid);
      const directEntry = entries?.find((entry) => entry.name === entryName);
      if (directEntry?.cid) {
        return { cid: directEntry.cid, size: directEntry.size };
      }
    }
  }

  const entry = await tree.resolvePath(rootCid, resolvedPath);
  if (entry) {
    return { cid: entry.cid };
  }

  if (
    options?.allowSingleSegmentRootFallback &&
    canFallbackToRootBlob(resolvedPath, path)
  ) {
    return { cid: rootCid };
  }

  return null;
}

async function resolveCidWithinRoot(
  rootCid: CID,
  path: string,
  options?: { allowSingleSegmentRootFallback?: boolean }
): Promise<CID | null> {
  return (await resolveEntryWithinRoot(rootCid, path, options))?.cid ?? null;
}

function canFallbackToRootBlob(resolvedPath: string, originalPath: string): boolean {
  if (resolvedPath !== originalPath) return false;
  if (resolvedPath.includes('/')) return false;
  return /\.[A-Za-z0-9]{1,16}$/.test(resolvedPath);
}

function isThumbnailAliasPath(path: string): boolean {
  return path === 'thumbnail' || path.endsWith('/thumbnail');
}

async function normalizeAliasPath(rootCid: CID, path: string): Promise<string> {
  if (!path) return '';
  if (path.endsWith('/thumbnail') || path === 'thumbnail') {
    const dirPath = path.endsWith('/thumbnail')
      ? path.slice(0, -'/thumbnail'.length)
      : '';
    const actualPath = await findThumbnailInDir(rootCid, dirPath);
    if (actualPath) {
      return actualPath;
    }
  }
  return path;
}

async function canListDirectory(rootCid: CID): Promise<boolean> {
  if (!tree) return false;
  try {
    const entries = await listDirectoryWithTimeout(rootCid);
    return Array.isArray(entries);
  } catch {
    return false;
  }
}

export const __test__ = {
  resolveCidWithinRoot,
  normalizeAliasPath,
  canListDirectory,
};

async function listDirectoryWithTimeout(cid: CID): Promise<Awaited<ReturnType<HashTree['listDirectory']>> | null> {
  if (!tree) return null;
  return Promise.race([
    tree.listDirectory(cid),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), NHASH_HINT_DIRECTORY_TIMEOUT_MS)),
  ]);
}

async function waitForCachedRoot(npub: string, treeName: string): Promise<CID | null> {
  let cached = await getCachedRoot(npub, treeName);
  if (cached) return cached;

  const pubkey = decodeNpubToPubkey(npub);
  if (pubkey) {
    subscribeToTreeRoots(pubkey);
  }

  const deadline = Date.now() + ROOT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ROOT_WAIT_INTERVAL_MS));
    cached = await getCachedRoot(npub, treeName);
    if (cached) return cached;
  }

  logMediaDebug('root:timeout', { npub, treeName });
  return null;
}

function decodeNpubToPubkey(npub: string): string | null {
  if (!npub.startsWith('npub1')) return null;
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') return null;
    return decoded.data as string;
  } catch {
    return null;
  }
}

/**
 * Send error response to SW
 */
function sendSwError(requestId: string, status: number, message: string): void {
  if (!mediaPort) return;
  logMediaDebug('sw:error', { requestId, status, message });
  mediaPort.postMessage({
    type: 'error',
    requestId,
    status,
    message,
  } as SwFileResponse);
}

/**
 * Get file size from CID (handles both chunked and single blob files)
 */
async function getFileSize(cid: CID): Promise<number | null> {
  if (!tree) return null;

  const treeNode = await tree.getTreeNode(cid);
  if (treeNode) {
    // Chunked file - sum link sizes from decrypted tree node
    return treeNode.links.reduce((sum, l) => sum + l.size, 0);
  }

  // Single blob - fetch to check existence and get size
  const blob = await tree.getBlob(cid.hash);
  if (!blob) return null;

  // For encrypted blobs, decrypted size = encrypted size - 16 (nonce overhead)
  return cid.key ? Math.max(0, blob.length - 16) : blob.length;
}

/**
 * Find actual thumbnail file in a directory
 */
async function findThumbnailInDir(rootCid: CID, dirPath: string): Promise<string | null> {
  if (!tree) return null;

  try {
    // Get directory CID
    const dirEntry = dirPath
      ? await tree.resolvePath(rootCid, dirPath)
      : { cid: rootCid };
    if (!dirEntry) return null;

    // List directory contents
    const entries = await listDirectoryWithTimeout(dirEntry.cid);
    if (!entries) return null;

    // Find first matching thumbnail pattern
    for (const pattern of THUMBNAIL_PATTERNS) {
      if (entries.some(e => e.name === pattern)) {
        return dirPath ? `${dirPath}/${pattern}` : pattern;
      }
    }

    const hasPlayableMediaFile = entries.some((entry) => isPlayableMediaFileName(entry.name));
    if (!hasPlayableMediaFile && entries.length > 0) {
      const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sortedEntries.slice(0, 3)) {
        if (entry.name.endsWith('.json') || entry.name.endsWith('.txt')) {
          continue;
        }

        try {
          const subEntries = await listDirectoryWithTimeout(entry.cid);
          if (!subEntries) {
            continue;
          }

          for (const pattern of THUMBNAIL_PATTERNS) {
            if (subEntries.some((candidate) => candidate.name === pattern)) {
              const prefix = dirPath ? `${dirPath}/${entry.name}` : entry.name;
              return `${prefix}/${pattern}`;
            }
          }
        } catch {
          continue;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Stream response to SW with proper HTTP headers
 */
async function streamSwResponse(
  requestId: string,
  cid: CID,
  totalSize: number,
  options: {
    npub?: string;
    path?: string;
    start?: number;
    end?: number;
    rangeHeader?: string | null;
    mimeType?: string;
    download?: boolean;
  }
): Promise<void> {
  if (!tree || !mediaPort) return;

  const { npub, path, start = 0, end, rangeHeader, mimeType = 'application/octet-stream', download } = options;

  let rangeStart = start;
  let rangeEnd = end !== undefined ? Math.min(end, totalSize - 1) : totalSize - 1;
  if (rangeHeader) {
    const parsedRange = parseHttpByteRange(rangeHeader, totalSize);
    if (parsedRange.kind === 'range') {
      rangeStart = parsedRange.range.start;
      rangeEnd = parsedRange.range.endInclusive;
    } else if (parsedRange.kind === 'unsatisfiable') {
      sendSwError(requestId, 416, `Range not satisfiable for ${totalSize} byte file`);
      return;
    }
  }
  const contentLength = rangeEnd - rangeStart + 1;

  // Build cache control header
  const isNpubRequest = !!npub;
  const isImage = mimeType.startsWith('image/');
  let cacheControl: string;
  if (!isNpubRequest) {
    cacheControl = 'public, max-age=31536000, immutable'; // nhash: immutable
  } else if (isImage) {
    cacheControl = 'public, max-age=60, stale-while-revalidate=86400';
  } else {
    cacheControl = 'no-cache, no-store, must-revalidate';
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'Content-Length': String(contentLength),
  };

  if (download) {
    const filename = path || 'file';
    headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  }

  // Determine status (206 for range requests)
  const isRangeRequest = !!rangeHeader || end !== undefined || start > 0;
  const status = isRangeRequest ? 206 : 200;
  if (isRangeRequest) {
    headers['Content-Range'] = `bytes ${rangeStart}-${rangeEnd}/${totalSize}`;
  }

  logMediaDebug('sw:response', {
    requestId,
    status,
    totalSize,
    rangeStart,
    rangeEnd,
  });

  // Send headers
  mediaPort.postMessage({
    type: 'headers',
    requestId,
    status,
    headers,
    totalSize,
  } as SwFileResponse);

  // Stream chunks
  let offset = rangeStart;
  while (offset <= rangeEnd) {
    const chunkEnd = Math.min(offset + MEDIA_CHUNK_SIZE - 1, rangeEnd);
    const chunk = await tree.readFileRange(cid, offset, chunkEnd + 1);

    if (!chunk) break;

    mediaPort.postMessage(
      { type: 'chunk', requestId, data: chunk } as SwFileResponse,
      [chunk.buffer]
    );

    offset = chunkEnd + 1;
  }

  // Signal done
  mediaPort.postMessage({ type: 'done', requestId } as SwFileResponse);
}
