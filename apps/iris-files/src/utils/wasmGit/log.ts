/**
 * Git log and history operations
 */
import type { CID } from '@hashtree/core';
import { LinkType, toHex } from '@hashtree/core';
import { getTree } from '../../store';
import { withWasmGitLock, loadWasmGit, copyGitDirToWasmFS, rmRf, createRepoPath } from './core';
import { collectLooseRefs, isFullSha, readPackedRefs, readRefSha } from './refs';

/**
 * Get current HEAD commit SHA
 * Reads .git/HEAD and resolves refs directly from hashtree - no wasm needed
 */
export async function getHead(
  rootCid: CID
): Promise<string | null> {
  const tree = getTree();

  // Check for .git directory
  const gitDirResult = await tree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return null;
  }

  const fallbackHead = async (): Promise<string | null> => {
    const preferredBranches = ['main', 'master'];
    for (const branch of preferredBranches) {
      const sha = await readRefSha(tree, gitDirResult.cid, `refs/heads/${branch}`);
      if (sha) {
        return sha;
      }
    }

    const looseHeads = await collectLooseRefs(tree, gitDirResult.cid, 'refs/heads');
    for (const name of Array.from(looseHeads.keys()).sort()) {
      const sha = looseHeads.get(name);
      if (sha) {
        return sha;
      }
    }

    const packedRefs = await readPackedRefs(tree, gitDirResult.cid);
    for (const ref of ['refs/heads/main', 'refs/heads/master']) {
      const entry = packedRefs.get(ref);
      if (entry?.sha) {
        return entry.sha;
      }
    }
    for (const [ref, entry] of packedRefs.entries()) {
      if (ref.startsWith('refs/heads/') && entry.sha) {
        return entry.sha;
      }
    }

    return null;
  };

  try {
    // Read HEAD file
    const headResult = await tree.resolvePath(gitDirResult.cid, 'HEAD');
    if (!headResult || headResult.type === LinkType.Dir) {
      return await fallbackHead();
    }

    const headData = await tree.readFile(headResult.cid);
    if (!headData) {
      return await fallbackHead();
    }

    const headContent = new TextDecoder().decode(headData).trim();

    // Check if HEAD is a direct SHA (detached)
    if (isFullSha(headContent)) {
      return headContent.toLowerCase();
    }

    // HEAD is a ref like "ref: refs/heads/master"
    const refMatch = headContent.match(/^ref: (.+)$/);
    if (!refMatch) {
      return await fallbackHead();
    }

    // Resolve the ref to get commit SHA
    const refPath = refMatch[1]; // e.g., "refs/heads/master"
    const sha = await readRefSha(tree, gitDirResult.cid, refPath);
    if (sha) {
      return sha;
    }

    const packedRefs = await readPackedRefs(tree, gitDirResult.cid);
    const packedSha = packedRefs.get(refPath)?.sha ?? null;
    if (packedSha) {
      return packedSha;
    }

    return await fallbackHead();
  } catch (err) {
    console.error('[git] getHead failed:', err);
    return await fallbackHead();
  }
}

export interface CommitInfo {
  oid: string;
  message: string;
  author: string;
  email: string;
  timestamp: number;
  parent: string[];
}

interface GitObject {
  type: string;
  content: Uint8Array;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  email: string;
  timestamp: number;
  message: string;
}

interface ParsedTag {
  object: string;
  type: string;
}

export interface CommitDetails extends CommitInfo {
  tree: string;
}

export interface CommitTreeEntry {
  name: string;
  data: Uint8Array;
  isDir: boolean;
}

/**
 * Get commit log using wasm-git
 */
/**
 * Decompress zlib data using browser's DecompressionStream
 */
async function decompressZlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function gitDirCacheKey(gitDirCid: CID): string {
  return gitDirCid.key ? `${toHex(gitDirCid.hash)}:${toHex(gitDirCid.key)}` : toHex(gitDirCid.hash);
}

interface PackIndexData {
  shas: string[];
  offsets: number[];
  sortedOffsets: number[];
  shaToOffset: Map<string, number>;
}

// Cache for pack indexes and pack data per git dir CID
const packIndexCache = new Map<string, Map<string, PackIndexData>>();
const packDataCache = new Map<string, Map<string, Uint8Array>>();
const gitObjectCache = new Map<string, Map<string, Promise<GitObject | null>>>();
const parsedCommitCache = new Map<string, ParsedCommit | null>();

/**
 * Load pack index file (.idx) and return the SHA -> offset mapping
 */
async function loadPackIndex(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  idxName: string
): Promise<PackIndexData | null> {
  // Check cache first
  const cacheKey = gitDirCacheKey(gitDirCid);
  let dirCache = packIndexCache.get(cacheKey);
  if (dirCache?.has(idxName)) {
    return dirCache.get(idxName)!;
  }
  try {
    const idxResult = await tree.resolvePath(gitDirCid, `objects/pack/${idxName}`);
    if (!idxResult || idxResult.type === LinkType.Dir) {
      return null;
    }

    const idxData = await tree.readFile(idxResult.cid);
    if (!idxData) return null;

    const view = new DataView(idxData.buffer, idxData.byteOffset, idxData.byteLength);

    // Check magic number (0xff744f63 for v2)
    if (view.getUint32(0) !== 0xff744f63) {
      
      return null;
    }

    // Version should be 2
    if (view.getUint32(4) !== 2) {
      
      return null;
    }

    // Total object count is the last entry in the fanout table.
    const numObjects = view.getUint32(8 + 255 * 4);

    // SHA table starts after fanout (offset 8 + 256*4 = 1032)
    const shaOffset = 8 + 256 * 4;
    const shas: string[] = [];
    for (let i = 0; i < numObjects; i++) {
      const sha = Array.from(idxData.slice(shaOffset + i * 20, shaOffset + (i + 1) * 20))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      shas.push(sha);
    }

    // CRC table (skip it) - numObjects * 4 bytes
    const crcOffset = shaOffset + numObjects * 20;

    // Offset table starts after CRC
    const offsetOffset = crcOffset + numObjects * 4;
    const offsets: number[] = [];
    const largeOffsetEntries: Array<{ index: number; largeIndex: number }> = [];
    for (let i = 0; i < numObjects; i++) {
      const rawOffset = view.getUint32(offsetOffset + i * 4);
      if (rawOffset & 0x80000000) {
        offsets.push(0);
        largeOffsetEntries.push({ index: i, largeIndex: rawOffset & 0x7fffffff });
      } else {
        offsets.push(rawOffset);
      }
    }

    if (largeOffsetEntries.length > 0) {
      const largeOffsetTableOffset = offsetOffset + numObjects * 4;
      for (const { index, largeIndex } of largeOffsetEntries) {
        const entryOffset = largeOffsetTableOffset + largeIndex * 8;
        if (entryOffset + 8 > idxData.byteLength) {
          return null;
        }
        const high = view.getUint32(entryOffset);
        const low = view.getUint32(entryOffset + 4);
        const fullOffset = (BigInt(high) << 32n) | BigInt(low);
        if (fullOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
          return null;
        }
        offsets[index] = Number(fullOffset);
      }
    }

    // Build SHA -> offset map for fast lookups
    const shaToOffset = new Map<string, number>();
    for (let i = 0; i < shas.length; i++) {
      shaToOffset.set(shas[i], offsets[i]);
    }

    const sortedOffsets = [...offsets].sort((a, b) => a - b);

    // Cache the result
    if (!dirCache) {
      dirCache = new Map();
      packIndexCache.set(cacheKey, dirCache);
    }
    dirCache.set(idxName, { shas, offsets, sortedOffsets, shaToOffset });

    return { shas, offsets, sortedOffsets, shaToOffset };
  } catch {
    return null;
  }
}

/**
 * Load pack file data with caching
 */
async function loadPackData(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  packName: string
): Promise<Uint8Array | null> {
  const cacheKey = gitDirCacheKey(gitDirCid);
  let dirCache = packDataCache.get(cacheKey);
  if (dirCache?.has(packName)) {
    return dirCache.get(packName)!;
  }

  const packResult = await tree.resolvePath(gitDirCid, `objects/pack/${packName}`);
  if (!packResult || packResult.type === LinkType.Dir) return null;

  const packData = await tree.readFile(packResult.cid);
  if (!packData) return null;

  // Cache the result
  if (!dirCache) {
    dirCache = new Map();
    packDataCache.set(cacheKey, dirCache);
  }
  dirCache.set(packName, packData);

  return packData;
}

// Cache for pack directory listings
const packDirCache = new Map<string, string[]>();

/**
 * Find object in pack files
 */
async function findInPack(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  sha: string
): Promise<{ packName: string; offset: number } | null> {
  const cacheKey = gitDirCacheKey(gitDirCid);

  // Get cached list of idx files or load it
  let idxFileNames = packDirCache.get(cacheKey);
  if (!idxFileNames) {
    const packDirResult = await tree.resolvePath(gitDirCid, 'objects/pack');
    if (!packDirResult || packDirResult.type !== LinkType.Dir) {
      return null;
    }
    const entries = await tree.listDirectory(packDirResult.cid);
    idxFileNames = entries.filter(e => e.name.endsWith('.idx')).map(e => e.name);
    packDirCache.set(cacheKey, idxFileNames);
  }

  for (const idxName of idxFileNames) {
    const idx = await loadPackIndex(tree, gitDirCid, idxName);
    if (!idx) continue;

    // Use the shaToOffset map for O(1) lookup instead of O(n) indexOf
    const offset = idx.shaToOffset.get(sha);
    if (offset !== undefined) {
      const packName = idxName.replace('.idx', '.pack');
      return { packName, offset };
    }
  }

  return null;
}

/**
 * Apply git delta instructions to a base object
 */
function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;

  // Skip base size (variable length encoded, not needed for our purposes)
  let shift = 0;
  while (pos < delta.length) {
    const byte = delta[pos++];
    shift += 7;
    if (!(byte & 0x80)) break;
  }

  // Read result size (variable length)
  let resultSize = 0;
  shift = 0;
  while (pos < delta.length) {
    const byte = delta[pos++];
    resultSize |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }

  const result = new Uint8Array(resultSize);
  let resultPos = 0;

  while (pos < delta.length && resultPos < resultSize) {
    const cmd = delta[pos++];

    if (cmd & 0x80) {
      // Copy from base
      let copyOffset = 0;
      let copySize = 0;

      if (cmd & 0x01) copyOffset = delta[pos++];
      if (cmd & 0x02) copyOffset |= delta[pos++] << 8;
      if (cmd & 0x04) copyOffset |= delta[pos++] << 16;
      if (cmd & 0x08) copyOffset |= delta[pos++] << 24;

      if (cmd & 0x10) copySize = delta[pos++];
      if (cmd & 0x20) copySize |= delta[pos++] << 8;
      if (cmd & 0x40) copySize |= delta[pos++] << 16;

      if (copySize === 0) copySize = 0x10000;

      result.set(base.subarray(copyOffset, copyOffset + copySize), resultPos);
      resultPos += copySize;
    } else if (cmd > 0) {
      // Insert new data
      result.set(delta.subarray(pos, pos + cmd), resultPos);
      pos += cmd;
      resultPos += cmd;
    }
  }

  return result;
}

/**
 * Read object from pack file at given offset (with delta resolution)
 */
async function readFromPack(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  packName: string,
  offset: number,
  depth = 0
): Promise<{ type: string; content: Uint8Array } | null> {
  // Prevent infinite recursion
  if (depth > 50) return null;

  try {
    const packData = await loadPackData(tree, gitDirCid, packName);
    if (!packData) return null;
    const idx = await loadPackIndex(tree, gitDirCid, packName.replace('.pack', '.idx'));
    if (!idx) return null;
    return await readPackObjectAtOffset(packData, offset, idx, tree, gitDirCid, packName, depth);
  } catch {
    return null;
  }
}

function getPackObjectEnd(packData: Uint8Array, sortedOffsets: number[], offset: number): number {
  const packTrailerLength = 20;
  const packEnd = Math.max(12, packData.length - packTrailerLength);

  let lo = 0;
  let hi = sortedOffsets.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedOffsets[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo < sortedOffsets.length ? Math.min(sortedOffsets[lo], packEnd) : packEnd;
}

async function readPackObjectAtOffset(
  packData: Uint8Array,
  offset: number,
  idx: PackIndexData,
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  packName: string,
  depth = 0
): Promise<{ type: string; content: Uint8Array } | null> {
  if (depth > 50) return null;

  let pos = offset;
  let byte = packData[pos++];
  const type = (byte >> 4) & 7;
  let size = byte & 15;
  let shift = 4;

  while (byte & 0x80) {
    byte = packData[pos++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }

  const typeNames = ['', 'commit', 'tree', 'blob', 'tag', '', 'ofs_delta', 'ref_delta'];
  const objectEnd = getPackObjectEnd(packData, idx.sortedOffsets, offset);

  if (objectEnd <= pos) {
    return null;
  }

  if (type === 6) {
    let negOffset = 0;
    byte = packData[pos++];
    negOffset = byte & 0x7f;
    while (byte & 0x80) {
      byte = packData[pos++];
      negOffset = ((negOffset + 1) << 7) | (byte & 0x7f);
    }
    const baseOffset = offset - negOffset;

    const compressedDelta = packData.subarray(pos, objectEnd);
    const deltaData = await decompressZlib(compressedDelta);
    const baseObj = await readPackObjectAtOffset(packData, baseOffset, idx, tree, gitDirCid, packName, depth + 1);
    if (!baseObj) return null;

    const content = applyDelta(baseObj.content, deltaData);
    return { type: baseObj.type, content };
  }

  if (type === 7) {
    const baseShaBytes = packData.subarray(pos, pos + 20);
    pos += 20;
    const baseSha = Array.from(baseShaBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const compressedDelta = packData.subarray(pos, objectEnd);
    const deltaData = await decompressZlib(compressedDelta);

    const baseOffset = idx.shaToOffset.get(baseSha);
    let baseObj: { type: string; content: Uint8Array } | null = null;
    if (baseOffset !== undefined) {
      baseObj = await readPackObjectAtOffset(packData, baseOffset, idx, tree, gitDirCid, packName, depth + 1);
    } else {
      baseObj = await readGitObject(tree, gitDirCid, baseSha);
    }
    if (!baseObj) return null;

    const content = applyDelta(baseObj.content, deltaData);
    return { type: baseObj.type, content };
  }

  const compressedData = packData.subarray(pos, objectEnd);
  const decompressed = await decompressZlib(compressedData);
  return { type: typeNames[type], content: decompressed.slice(0, size) };
}

/**
 * Read and parse a git object from hashtree (loose or packed)
 * Internal version with depth tracking for delta resolution
 */
async function readGitObjectInternal(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  sha: string,
  depth = 0
): Promise<{ type: string; content: Uint8Array } | null> {
  // Prevent infinite recursion
  if (depth > 50) return null;

  // Try loose object first: .git/objects/<sha[0:2]>/<sha[2:]>
  const objPath = `objects/${sha.slice(0, 2)}/${sha.slice(2)}`;

  try {
    const objResult = await tree.resolvePath(gitDirCid, objPath);
    if (objResult && objResult.type !== LinkType.Dir) {
      const compressedData = await tree.readFile(objResult.cid);
      if (compressedData) {
        // Decompress the object
        const decompressed = await decompressZlib(compressedData);

        // Parse: "<type> <size>\0<content>"
        const nullIndex = decompressed.indexOf(0);
        if (nullIndex !== -1) {
          const header = new TextDecoder().decode(decompressed.slice(0, nullIndex));
          const [type] = header.split(' ');
          const content = decompressed.slice(nullIndex + 1);
          return { type, content };
        }
      }
    }
  } catch {
    // Loose object not found, try pack files
  }

  // Try pack files
  const packInfo = await findInPack(tree, gitDirCid, sha);
  if (packInfo) {
    return readFromPack(tree, gitDirCid, packInfo.packName, packInfo.offset, depth);
  }

  return null;
}

/**
 * Read and parse a git object from hashtree (loose or packed)
 */
async function readGitObject(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  sha: string
): Promise<GitObject | null> {
  const cacheKey = gitDirCacheKey(gitDirCid);
  let dirCache = gitObjectCache.get(cacheKey);
  if (!dirCache) {
    dirCache = new Map();
    gitObjectCache.set(cacheKey, dirCache);
  }

  const cached = dirCache.get(sha);
  if (cached) {
    return await cached;
  }

  const pending = readGitObjectInternal(tree, gitDirCid, sha, 0);
  dirCache.set(sha, pending);
  return await pending;
}

/**
 * Parse a git commit object
 */
function parseCommit(content: Uint8Array): ParsedCommit | null {
  const text = new TextDecoder().decode(content);
  const lines = text.split('\n');

  let tree = '';
  const parents: string[] = [];
  let author = '';
  let email = '';
  let timestamp = 0;
  let messageStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line === '') {
      messageStart = i + 1;
      break;
    }

    if (line.startsWith('tree ')) {
      tree = line.slice(5);
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7));
    } else if (line.startsWith('author ')) {
      // Format: "author Name <email> timestamp timezone"
      const match = line.match(/^author (.+) <(.+)> (\d+)/);
      if (match) {
        author = match[1];
        email = match[2];
        timestamp = parseInt(match[3], 10);
      }
    }
  }

  const message = messageStart >= 0 ? lines.slice(messageStart).join('\n').trim() : '';

  return { tree, parents, author, email, timestamp, message };
}

function parseTag(content: Uint8Array): ParsedTag | null {
  const text = new TextDecoder().decode(content);
  const lines = text.split('\n');

  let object = '';
  let type = '';

  for (const line of lines) {
    if (line === '') break;
    if (line.startsWith('object ')) {
      object = line.slice(7).trim();
    } else if (line.startsWith('type ')) {
      type = line.slice(5).trim();
    }
  }

  if (!isFullSha(object) || !type) {
    return null;
  }

  return { object: object.toLowerCase(), type };
}

async function getParsedCommitFromSha(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  sha: string
): Promise<ParsedCommit | null> {
  if (parsedCommitCache.has(sha)) {
    return parsedCommitCache.get(sha) ?? null;
  }

  const obj = await readGitObject(tree, gitDirCid, sha);
  if (!obj || obj.type !== 'commit') {
    parsedCommitCache.set(sha, null);
    return null;
  }

  const parsed = parseCommit(obj.content);
  parsedCommitCache.set(sha, parsed);
  return parsed;
}

async function peelObjectToCommit(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  sha: string,
  seen = new Set<string>()
): Promise<string | null> {
  const normalizedSha = sha.toLowerCase();
  if (seen.has(normalizedSha)) {
    return null;
  }
  seen.add(normalizedSha);

  const obj = await readGitObject(tree, gitDirCid, normalizedSha);
  if (!obj) {
    return null;
  }

  if (obj.type === 'commit') {
    return normalizedSha;
  }

  if (obj.type !== 'tag') {
    return null;
  }

  const parsed = parseTag(obj.content);
  if (!parsed) {
    return null;
  }

  if (parsed.type === 'commit') {
    return parsed.object;
  }

  return peelObjectToCommit(tree, gitDirCid, parsed.object, seen);
}

async function resolveNamedRefToCommit(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  rootCid: CID,
  ref: string
): Promise<string | null> {
  const candidates = ref.startsWith('refs/')
    ? [ref]
    : [`refs/heads/${ref}`, `refs/tags/${ref}`];

  const packedRefs = await readPackedRefs(tree, gitDirCid);

  for (const candidate of candidates) {
    const isBranchRef = candidate.startsWith('refs/heads/');
    const looseSha = await readRefSha(tree, gitDirCid, candidate);
    if (looseSha) {
      if (isBranchRef) {
        return looseSha;
      }
      const peeled = await peelObjectToCommit(tree, gitDirCid, looseSha);
      if (peeled) {
        return peeled;
      }
    }

    const packed = packedRefs.get(candidate);
    if (packed?.peeled) {
      return packed.peeled;
    }
    if (packed?.sha) {
      if (isBranchRef) {
        return packed.sha;
      }
      const peeled = await peelObjectToCommit(tree, gitDirCid, packed.sha);
      if (peeled) {
        return peeled;
      }
    }
  }

  if (ref === 'HEAD') {
    return getHead(rootCid);
  }

  return null;
}

export async function resolveRevisionToCommit(rootCid: CID, ref: string): Promise<string | null> {
  if (ref === 'HEAD') {
    return await getHead(rootCid);
  }

  if (isFullSha(ref)) {
    return ref.toLowerCase();
  }

  const tree = getTree();
  const gitDirResult = await tree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return null;
  }

  const resolvedRef = await resolveNamedRefToCommit(tree, gitDirResult.cid, rootCid, ref);
  if (resolvedRef) {
    return resolvedRef;
  }

  if (/^[0-9a-f]{4,39}$/i.test(ref)) {
    const commits = await getLog(rootCid, { depth: 1000 });
    const match = commits.find((commit) => commit.oid.startsWith(ref.toLowerCase()));
    return match?.oid ?? null;
  }

  return null;
}

export async function getCommitInfo(rootCid: CID, ref: string): Promise<CommitDetails | null> {
  const tree = getTree();

  const gitDirResult = await tree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return null;
  }

  const sha = await resolveRevisionToCommit(rootCid, ref);
  if (!sha) {
    return null;
  }

  const parsed = await getParsedCommitFromSha(tree, gitDirResult.cid, sha);
  if (!parsed) {
    return null;
  }

  return {
    oid: sha,
    message: parsed.message,
    author: parsed.author,
    email: parsed.email,
    timestamp: parsed.timestamp,
    parent: parsed.parents,
    tree: parsed.tree,
  };
}

export async function getRootCommit(rootCid: CID): Promise<string | null> {
  const tree = getTree();
  const gitDirResult = await tree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return null;
  }

  let currentSha = await getHead(rootCid);
  if (!currentSha) {
    return null;
  }

  const visited = new Set<string>();
  while (currentSha && !visited.has(currentSha)) {
    visited.add(currentSha);

    const parsed = await getParsedCommitFromSha(tree, gitDirResult.cid, currentSha);
    if (!parsed) {
      return null;
    }

    if (parsed.parents.length === 0) {
      return currentSha;
    }

    currentSha = parsed.parents[0] || null;
  }

  return null;
}

/**
 * Get commit log by reading git objects directly from hashtree
 * No wasm-git needed - much faster for large repos
 * Uses parallel fetching for better performance
 */
export async function getLog(
  rootCid: CID,
  options?: { depth?: number }
): Promise<CommitInfo[]> {
  const startTime = performance.now();
  const tree = getTree();
  const depth = options?.depth ?? 20;

  // Check for .git directory
  const gitDirResult = await tree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return [];
  }

  try {
    // Get HEAD commit SHA
    const headSha = await getHead(rootCid);
    if (!headSha) {
      return [];
    }

    const commits: CommitInfo[] = [];
    const visited = new Set<string>();
    const queue = [headSha];
    const batchSize = 16;

    while (queue.length > 0 && commits.length < depth) {
      const batch: string[] = [];
      while (batch.length < batchSize && queue.length > 0 && commits.length + batch.length < depth) {
        const sha = queue.shift()!;
        if (!visited.has(sha)) {
          visited.add(sha);
          batch.push(sha);
        }
      }

      if (batch.length === 0) {
        break;
      }

      const parsedBatch = await Promise.all(
        batch.map(async (sha) => {
          const parsed = await getParsedCommitFromSha(tree, gitDirResult.cid, sha);
          return parsed ? { sha, parsed } : null;
        })
      );

      for (const item of parsedBatch) {
        if (!item) continue;

        commits.push({
          oid: item.sha,
          message: item.parsed.message,
          author: item.parsed.author,
          email: item.parsed.email,
          timestamp: item.parsed.timestamp,
          parent: item.parsed.parents,
        });

        for (const parent of item.parsed.parents) {
          if (!visited.has(parent)) {
            queue.push(parent);
          }
        }
      }
    }

    // Sort by timestamp (newest first)
    commits.sort((a, b) => b.timestamp - a.timestamp);

    const elapsed = performance.now() - startTime;
    if (elapsed >= 50) {
      console.log(`[git perf] getLog completed in ${elapsed.toFixed(0)} ms (depth=${depth}, commits=${commits.length})`);
    }

    return commits;
  } catch (err) {
    console.error('[git] getLog failed:', err);
    return [];
  }
}

/**
 * Fast commit count - traverses parent pointers without parsing full commit data
 */
export async function getCommitCount(
  rootCid: CID,
  options?: { maxCount?: number }
): Promise<number> {
  const tree = getTree();
  const maxCount = options?.maxCount ?? 10000;

  // Check for .git directory
  const gitDirResult = await tree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return 0;
  }

  try {
    const headSha = await getHead(rootCid);
    if (!headSha) {
      return 0;
    }

    const visited = new Set<string>();
    const queue = [headSha];
    const BATCH_SIZE = 50;

    while (queue.length > 0 && visited.size < maxCount) {
      const batch = queue.splice(0, Math.min(BATCH_SIZE, maxCount - visited.size));
      const newShas = batch.filter(sha => !visited.has(sha));

      if (newShas.length === 0) continue;

      for (const sha of newShas) {
        visited.add(sha);
      }

      const results = await Promise.all(
        newShas.map(async (sha) => {
          const obj = await readGitObject(tree, gitDirResult.cid, sha);
          if (!obj || obj.type !== 'commit') return [];
          return extractParentShas(obj.content);
        })
      );

      for (const parents of results) {
        for (const parent of parents) {
          if (!visited.has(parent)) {
            queue.push(parent);
          }
        }
      }
    }

    return visited.size;
  } catch (err) {
    console.error('[git] getCommitCount failed:', err);
    return 0;
  }
}

/**
 * Fast parent SHA extraction - doesn't parse full commit
 */
function extractParentShas(content: Uint8Array): string[] {
  const text = new TextDecoder().decode(content);
  const parents: string[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    if (line === '') break;
    if (line.startsWith('parent ')) {
      parents.push(line.slice(7));
    }
  }

  return parents;
}

// Cache for commit counts (gitDirCid -> count)
const commitCountCache = new Map<string, number>();

/**
 * FAST commit count
 * - For pack files: scan type bytes directly (no decompression)
 * - For loose objects: walk commit graph from HEAD (only fetches commits, not all objects)
 * - Results are cached per git directory
 */
export async function getCommitCountFast(rootCid: CID): Promise<number> {
  const startTime = performance.now();
  const tree = getTree();

  const gitDirResult = await tree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return 0;
  }

  // Check cache
  const cacheKey = gitDirResult.cid.key
    ? `${toHex(gitDirResult.cid.hash)}:${toHex(gitDirResult.cid.key)}`
    : toHex(gitDirResult.cid.hash);
  if (commitCountCache.has(cacheKey)) {
    const cached = commitCountCache.get(cacheKey)!;
    console.log(`[git perf] getCommitCountFast cache hit: ${cached} commits`);
    return cached;
  }

  let commitCount = 0;
  let hasPackFiles = false;
  let hasLooseObjects = false;

  try {
    const objectsDirResult = await tree.resolvePath(gitDirResult.cid, 'objects');
    if (objectsDirResult && objectsDirResult.type === LinkType.Dir) {
      const objectEntries = await tree.listDirectory(objectsDirResult.cid);
      hasLooseObjects = objectEntries.some(entry =>
        entry.type === LinkType.Dir && entry.name !== 'pack' && entry.name !== 'info'
      );
    }

    // 1. Count commits in pack files (most commits are packed)
    const packDirResult = await tree.resolvePath(gitDirResult.cid, 'objects/pack');
    if (packDirResult && packDirResult.type === LinkType.Dir) {
      const entries = await tree.listDirectory(packDirResult.cid);
      const idxFiles = entries.filter(e => e.name.endsWith('.idx'));

      for (const idxFile of idxFiles) {
        hasPackFiles = true;
        const packName = idxFile.name.replace('.idx', '.pack');

        // Load index to get offsets (uses cache)
        const idx = await loadPackIndex(tree, gitDirResult.cid, idxFile.name);
        if (!idx) continue;

        // Load pack file (uses cache)
        const packData = await loadPackData(tree, gitDirResult.cid, packName);
        if (!packData) continue;

        // Scan through all offsets, reading only type bytes (no decompression!)
        for (const offset of idx.offsets) {
          const type = readPackObjectType(packData, offset);
          if (type === 1) { // 1 = commit
            commitCount++;
          }
        }
      }
    }

    // 2. For loose objects: walk commit graph from HEAD (much faster than scanning all objects)
    if (!hasPackFiles) {
      const headSha = await getHead(rootCid);
      if (headSha) {
        const visited = new Set<string>();
        const queue = [headSha];
        const BATCH_SIZE = 50;

        while (queue.length > 0) {
          const batch = queue.splice(0, Math.min(BATCH_SIZE, queue.length));
          const newShas = batch.filter(sha => !visited.has(sha));

          if (newShas.length === 0) continue;

          for (const sha of newShas) {
            visited.add(sha);
          }

          // Fetch commits in parallel
          const results = await Promise.all(
            newShas.map(async (sha) => {
              const obj = await readGitObject(tree, gitDirResult.cid, sha);
              if (!obj || obj.type !== 'commit') return [];
              return extractParentShas(obj.content);
            })
          );

          for (const parents of results) {
            for (const parent of parents) {
              if (!visited.has(parent)) {
                queue.push(parent);
              }
            }
          }
        }

        commitCount = visited.size;
      }
    } else if (hasLooseObjects || commitCount < 2) {
      // Pack-only counting misses loose commits; fall back to graph traversal when needed.
      commitCount = await getCommitCount(rootCid);
    }

    // Cache the result
    commitCountCache.set(cacheKey, commitCount);
    console.log(`[git perf] getCommitCountFast completed in ${(performance.now() - startTime).toFixed(0)} ms, count: ${commitCount}`);
    return commitCount;
  } catch (err) {
    console.error('[git] getCommitCountFast failed:', err);
    return 0;
  }
}

/**
 * Read object type from pack data at given offset (no decompression)
 * Returns: 1=commit, 2=tree, 3=blob, 4=tag, 6=ofs_delta, 7=ref_delta
 */
function readPackObjectType(packData: Uint8Array, offset: number): number {
  const byte = packData[offset];
  return (byte >> 4) & 7;
}

// Use wasm-git for commit log (slow - copies entire .git)
export async function getLogWasm(
  rootCid: CID,
  options?: { depth?: number }
): Promise<CommitInfo[]> {
  return withWasmGitLock(async () => {
    const tree = getTree();
    const depth = options?.depth ?? 20;

    // Check for .git directory
    const gitDirResult = await tree.resolvePath(rootCid, '.git');
    if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
      return [];
    }

    const module = await loadWasmGit();

    // Use a unique path for each call to avoid conflicts
    const repoPath = createRepoPath();
    const originalCwd = module.FS.cwd();

    try {
      // Create and mount a fresh working directory
      module.FS.mkdir(repoPath);

      // Write .gitconfig so git doesn't complain about missing user
      try {
        module.FS.writeFile('/home/web_user/.gitconfig', '[user]\nname = Reader\nemail = reader@example.com\n');
      } catch {
        // May already exist
      }

      // Change to repo directory
      module.FS.chdir(repoPath);

      // Only copy .git directory - much faster for read-only operations
      await copyGitDirToWasmFS(module, rootCid, '.');

      // Run git log from HEAD
      const output = module.callWithOutput(['log']);

      if (!output || output.trim() === '') {
        return [];
      }

      // Parse the default git log format:
      // commit <sha>
      // Author: <name> <email>
      // Date:   <date>
      //
      //     <message>
      //
      const commits: CommitInfo[] = [];

      const commitBlocks = output.split(/^commit /m).filter(Boolean);

      for (const block of commitBlocks) {
        if (commits.length >= depth) break;

        const lines = block.split('\n');
        const oid = lines[0]?.trim();
        if (!oid || oid.length !== 40) continue;

        let author = '';
        let email = '';
        let timestamp = 0;
        const messageLines: string[] = [];
        let inMessage = false;

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];

          if (line.startsWith('Author: ')) {
            const authorMatch = line.match(/^Author:\s*(.+?)\s*<(.+?)>/);
            if (authorMatch) {
              author = authorMatch[1].trim();
              email = authorMatch[2];
            }
          } else if (line.startsWith('Date: ')) {
            // Parse date like "Thu Dec 11 15:05:31 2025 +0000"
            const dateStr = line.substring(6).trim();
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
              timestamp = Math.floor(date.getTime() / 1000);
            }
          } else if (line === '') {
            if (author && !inMessage) {
              inMessage = true;
            }
          } else if (inMessage) {
            // Message lines are indented with 4 spaces
            messageLines.push(line.replace(/^    /, ''));
          }
        }

        const message = messageLines.join('\n').trim();

        commits.push({
          oid,
          message,
          author,
          email,
          timestamp,
          parent: [], // wasm-git default format doesn't include parent info
        });
      }

      return commits;
    } catch (err) {
      console.error('[wasm-git] git log failed:', err);
      return [];
    } finally {
      // Restore original working directory
      try {
        module.FS.chdir(originalCwd);
        rmRf(module, repoPath);
      } catch {
        // Ignore errors
      }
    }
  });
}

/**
 * Get last commit info for files in a directory
 * Returns a map of filename -> commit info
 * @param rootCid - The root CID of the git repository
 * @param filenames - Array of filenames (base names only, not full paths)
 * @param subpath - Optional subdirectory path relative to git root (e.g., 'src' or 'src/utils')
 */
export async function getFileLastCommitsWasm(
  rootCid: CID,
  filenames: string[],
  subpath?: string
): Promise<Map<string, { oid: string; message: string; timestamp: number }>> {
  return withWasmGitLock(async () => {
    const tree = getTree();
    const result = new Map<string, { oid: string; message: string; timestamp: number }>();

    if (filenames.length === 0) return result;

    // Check for .git directory
    const gitDirResult = await tree.resolvePath(rootCid, '.git');
    if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
      return result;
    }

    const module = await loadWasmGit();
    const repoPath = createRepoPath();
    const originalCwd = module.FS.cwd();

    try {
      module.FS.mkdir(repoPath);

      try {
        module.FS.writeFile('/home/web_user/.gitconfig', '[user]\nname = Reader\nemail = reader@example.com\n');
      } catch {
        // May already exist
      }

      module.FS.chdir(repoPath);

      // Only copy .git directory - git log only needs history, not working tree
      await copyGitDirToWasmFS(module, rootCid, '.');

      // For each file, get the last commit that touched it
      for (const filename of filenames) {
        // Skip .git directory
        if (filename === '.git') continue;

        try {
          // Build the full path relative to git root
          const fullPath = subpath ? `${subpath}/${filename}` : filename;
          // Run git log -1 -- <fullPath> to get last commit for this file
          const output = module.callWithOutput(['log', '-1', '--', fullPath]);

          if (!output || output.trim() === '') continue;

          // Parse same format as getLog
          const lines = output.split('\n');
          let oid = '';
          let timestamp = 0;
          const messageLines: string[] = [];
          let inMessage = false;

          for (const line of lines) {
            if (line.startsWith('commit ')) {
              oid = line.substring(7).trim();
            } else if (line.startsWith('Date: ')) {
              const dateStr = line.substring(6).trim();
              const date = new Date(dateStr);
              if (!isNaN(date.getTime())) {
                timestamp = Math.floor(date.getTime() / 1000);
              }
            } else if (line === '') {
              if (oid && !inMessage) {
                inMessage = true;
              }
            } else if (inMessage) {
              messageLines.push(line.replace(/^    /, ''));
            }
          }

          if (oid) {
            result.set(filename, {
              oid,
              message: messageLines.join('\n').trim(),
              timestamp,
            });
          }
        } catch {
          // Skip files with errors
        }
      }

      return result;
    } catch (err) {
      console.error('[wasm-git] getFileLastCommits failed:', err);
      return result;
    } finally {
      try {
        module.FS.chdir(originalCwd);
        rmRf(module, repoPath);
      } catch {
        // Ignore
      }
    }
  });
}

/**
 * Parse a git tree object
 * Returns array of { mode, name, hash } entries
 */
function parseGitTree(content: Uint8Array): Array<{ mode: string; name: string; hash: string }> {
  const entries: Array<{ mode: string; name: string; hash: string }> = [];
  let pos = 0;

  while (pos < content.length) {
    // Find space (separates mode from name)
    let spacePos = pos;
    while (spacePos < content.length && content[spacePos] !== 0x20) spacePos++;
    const mode = new TextDecoder().decode(content.slice(pos, spacePos));

    // Find null (separates name from hash)
    let nullPos = spacePos + 1;
    while (nullPos < content.length && content[nullPos] !== 0) nullPos++;
    const name = new TextDecoder().decode(content.slice(spacePos + 1, nullPos));

    // Hash is 20 bytes after null
    const hashBytes = content.slice(nullPos + 1, nullPos + 21);
    const hash = Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    entries.push({ mode, name, hash });
    pos = nullPos + 21;
  }

  return entries;
}

// Tree objects are immutable, so cache parsed entry maps by tree SHA.
const treeEntriesCache = new Map<string, Map<string, { hash: string; mode: string }>>();

// Cache for individual path lookups in a tree
const treePathCache = new Map<string, Map<string, { hash: string; mode: string } | 'dir' | null>>();

async function getTreeEntriesMap(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  treeSha: string
): Promise<Map<string, { hash: string; mode: string }>> {
  const cached = treeEntriesCache.get(treeSha);
  if (cached) {
    return cached;
  }

  const obj = await readGitObject(tree, gitDirCid, treeSha);
  if (!obj || obj.type !== 'tree') {
    const empty = new Map<string, { hash: string; mode: string }>();
    treeEntriesCache.set(treeSha, empty);
    return empty;
  }

  const entries = new Map<string, { hash: string; mode: string }>();
  for (const entry of parseGitTree(obj.content)) {
    entries.set(entry.name, { hash: entry.hash, mode: entry.mode });
  }
  treeEntriesCache.set(treeSha, entries);
  return entries;
}

/**
 * Get a specific entry from a git tree by path (much faster than walking entire tree)
 */
async function getTreeEntryAtPath(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  treeSha: string,
  path: string
): Promise<{ hash: string; mode: string } | 'dir' | null> {
  const pathCache = treePathCache.get(treeSha) || new Map();

  if (pathCache.has(path)) {
    return pathCache.get(path)!;
  }

  const parts = path.split('/');
  let currentSha = treeSha;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const entries = await getTreeEntriesMap(tree, gitDirCid, currentSha);
    if (entries.size === 0) {
      pathCache.set(path, null);
      treePathCache.set(treeSha, pathCache);
      return null;
    }

    const entry = entries.get(part);
    if (!entry) {
      pathCache.set(path, null);
      treePathCache.set(treeSha, pathCache);
      return null;
    }

    if (i === parts.length - 1) {
      // Found the target
      const result = entry.mode === '40000' ? 'dir' : { hash: entry.hash, mode: entry.mode };
      pathCache.set(path, result);
      treePathCache.set(treeSha, pathCache);
      return result;
    }

    // Must be a directory to continue
    if (entry.mode !== '40000') {
      pathCache.set(path, null);
      treePathCache.set(treeSha, pathCache);
      return null;
    }
    currentSha = entry.hash;
  }

  pathCache.set(path, null);
  treePathCache.set(treeSha, pathCache);
  return null;
}

/**
 * Get the tree SHA for a subtree at a given path
 */
async function getSubtreeSha(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  treeSha: string,
  path: string
): Promise<string | null> {
  if (!path) return treeSha;

  const parts = path.split('/');
  let currentSha = treeSha;

  for (const part of parts) {
    const entries = await getTreeEntriesMap(tree, gitDirCid, currentSha);
    const entry = entries.get(part);
    if (!entry || entry.mode !== '40000') return null;
    currentSha = entry.hash;
  }

  return currentSha;
}

/**
 * Get last commit info for each file/directory by tracing through commit history
 * Native implementation - no wasm-git needed
 * Uses path-based lookups to avoid walking entire trees (O(depth) vs O(files) per path)
 */
export async function getFileLastCommits(
  rootCid: CID,
  filenames: string[],
  subpath?: string
): Promise<Map<string, { oid: string; message: string; timestamp: number }>> {
  const startTime = performance.now();
  const htree = getTree();
  const result = new Map<string, { oid: string; message: string; timestamp: number }>();

  if (filenames.length === 0) {
    return result;
  }

  // Check for .git directory
  const gitDirResult = await htree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return result;
  }

  try {
    // Build full paths to search for (files and directories)
    const targetNames = filenames.filter(f => f !== '.git');
    const targetPaths = new Map<string, string>(); // fullPath -> filename
    for (const f of targetNames) {
      const fullPath = subpath ? `${subpath}/${f}` : f;
      targetPaths.set(fullPath, f);
    }

    // Get commit history
    const headSha = await getHead(rootCid);
    if (!headSha) return result;

    // Walk through commits, comparing each with its parent to find when files changed
    const visited = new Set<string>();
    const queue = [headSha];
    const foundEntries = new Set<string>();

    // Cache for path lookups: commitTreeSha:path -> hash or 'dir' or null
    const pathLookupCache = new Map<string, { hash: string; mode: string } | 'dir' | null>();

    // Helper to get path entry with caching
    const getPathEntry = async (treeSha: string, path: string) => {
      const cacheKey = `${treeSha}:${path}`;
      if (pathLookupCache.has(cacheKey)) {
        return pathLookupCache.get(cacheKey)!;
      }
      const entry = await getTreeEntryAtPath(htree, gitDirResult.cid, treeSha, path);
      pathLookupCache.set(cacheKey, entry);
      return entry;
    };

    // Helper to get subtree SHA with caching
    const subtreeShaCache = new Map<string, string | null>();
    const getSubtree = async (treeSha: string, path: string) => {
      const cacheKey = `${treeSha}:${path}`;
      if (subtreeShaCache.has(cacheKey)) {
        return subtreeShaCache.get(cacheKey)!;
      }
      const sha = await getSubtreeSha(htree, gitDirResult.cid, treeSha, path);
      subtreeShaCache.set(cacheKey, sha);
      return sha;
    };

    // For loose object repos, batch load commits in parallel
    const BATCH_SIZE = 20;

    while (queue.length > 0 && foundEntries.size < targetPaths.size) {
      // Take a batch of commits to process
      const batch: string[] = [];
      while (batch.length < BATCH_SIZE && queue.length > 0 && foundEntries.size < targetPaths.size) {
        const sha = queue.shift()!;
        if (!visited.has(sha)) {
          visited.add(sha);
          batch.push(sha);
        }
      }
      if (batch.length === 0) break;

      // Load all commits in parallel
      const parsedCommits = await Promise.all(
        batch.map(async (sha) => {
          const parsed = await getParsedCommitFromSha(htree, gitDirResult.cid, sha);
          return parsed ? { sha, commit: parsed } : null;
        })
      );
      const resolvedCommits = parsedCommits.filter((c): c is { sha: string; commit: ParsedCommit } => c !== null);

      // Load parent commits to get their tree SHAs
      const parentShas = resolvedCommits
        .flatMap(c => c.commit.parents)
        .filter((parent, index, arr) => !visited.has(parent) && arr.indexOf(parent) === index);
      const parentCommits = await Promise.all(
        parentShas.map(async (sha) => {
          const parsed = await getParsedCommitFromSha(htree, gitDirResult.cid, sha);
          return parsed ? [sha, parsed] as const : null;
        })
      );
      const parentCommitMap = new Map<string, ParsedCommit>();
      for (const entry of parentCommits) {
        if (entry) {
          parentCommitMap.set(entry[0], entry[1]);
        }
      }

      // Now process each commit
      for (const { sha, commit } of resolvedCommits) {
        if (foundEntries.size >= targetPaths.size) break;

        let parentTreeSha: string | null = null;
        if (commit.parents.length > 0) {
          const parentCommit = parentCommitMap.get(commit.parents[0]);
          if (parentCommit) {
            parentTreeSha = parentCommit.tree;
          }
        }

        // Compare each target path using path-based lookups (not full tree walks)
        for (const [targetPath, filename] of targetPaths) {
          if (foundEntries.has(targetPath)) continue;

          // Get entry at this path in current commit
          const currentEntry = await getPathEntry(commit.tree, targetPath);

          if (currentEntry === null) {
            // Path doesn't exist in current commit, skip
            continue;
          }

          if (currentEntry === 'dir') {
            // It's a directory - compare subtree SHAs instead of walking all files
            const currentSubtreeSha = await getSubtree(commit.tree, targetPath);
            const parentSubtreeSha = parentTreeSha ? await getSubtree(parentTreeSha, targetPath) : null;

            if (currentSubtreeSha && currentSubtreeSha !== parentSubtreeSha) {
              // Directory was added or modified
              result.set(filename, {
                oid: sha,
                message: commit.message,
                timestamp: commit.timestamp,
              });
              foundEntries.add(targetPath);
            }
          } else {
            // It's a file - compare file hashes
            const parentEntry = parentTreeSha ? await getPathEntry(parentTreeSha, targetPath) : null;

            if (!parentEntry || parentEntry === 'dir' || currentEntry.hash !== parentEntry.hash) {
              // File was added or modified (or was a dir before, now a file)
              result.set(filename, {
                oid: sha,
                message: commit.message,
                timestamp: commit.timestamp,
              });
              foundEntries.add(targetPath);
            }
          }

        }

        for (const parent of commit.parents) {
          if (!visited.has(parent)) {
            queue.push(parent);
          }
        }
      }
      // end for commit in resolvedCommits
    } // end while queue

    console.log(`[git perf] getFileLastCommits completed in ${(performance.now() - startTime).toFixed(0)} ms`);
    return result;
  } catch (err) {
    console.error('[git] getFileLastCommits failed:', err);
    return result;
  }
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  oldHash?: string;
  newHash?: string;
}

async function collectTreeFiles(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  treeSha: string,
  prefix: string,
  status: 'added' | 'deleted',
  result: DiffEntry[]
): Promise<void> {
  const entries = await getTreeEntriesMap(tree, gitDirCid, treeSha);
  const names = Array.from(entries.keys()).sort();

  for (const name of names) {
    const entry = entries.get(name)!;
    const path = prefix ? `${prefix}/${name}` : name;

    if (entry.mode === '40000') {
      await collectTreeFiles(tree, gitDirCid, entry.hash, path, status, result);
      continue;
    }

    if (status === 'added') {
      result.push({ path, status, newHash: entry.hash });
    } else {
      result.push({ path, status, oldHash: entry.hash });
    }
  }
}

async function diffTreeObjects(
  tree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  fromTreeSha: string,
  toTreeSha: string,
  prefix: string,
  result: DiffEntry[]
): Promise<void> {
  if (fromTreeSha === toTreeSha) {
    return;
  }

  const [fromEntries, toEntries] = await Promise.all([
    getTreeEntriesMap(tree, gitDirCid, fromTreeSha),
    getTreeEntriesMap(tree, gitDirCid, toTreeSha),
  ]);

  const names = Array.from(new Set([...fromEntries.keys(), ...toEntries.keys()])).sort();

  for (const name of names) {
    const fromEntry = fromEntries.get(name);
    const toEntry = toEntries.get(name);
    const path = prefix ? `${prefix}/${name}` : name;

    if (!fromEntry && toEntry) {
      if (toEntry.mode === '40000') {
        await collectTreeFiles(tree, gitDirCid, toEntry.hash, path, 'added', result);
      } else {
        result.push({ path, status: 'added', newHash: toEntry.hash });
      }
      continue;
    }

    if (fromEntry && !toEntry) {
      if (fromEntry.mode === '40000') {
        await collectTreeFiles(tree, gitDirCid, fromEntry.hash, path, 'deleted', result);
      } else {
        result.push({ path, status: 'deleted', oldHash: fromEntry.hash });
      }
      continue;
    }

    if (!fromEntry || !toEntry) {
      continue;
    }

    if (fromEntry.hash === toEntry.hash && fromEntry.mode === toEntry.mode) {
      continue;
    }

    if (fromEntry.mode === '40000' && toEntry.mode === '40000') {
      await diffTreeObjects(tree, gitDirCid, fromEntry.hash, toEntry.hash, path, result);
      continue;
    }

    if (fromEntry.mode === '40000') {
      await collectTreeFiles(tree, gitDirCid, fromEntry.hash, path, 'deleted', result);
      result.push({ path, status: 'added', newHash: toEntry.hash });
      continue;
    }

    if (toEntry.mode === '40000') {
      result.push({ path, status: 'deleted', oldHash: fromEntry.hash });
      await collectTreeFiles(tree, gitDirCid, toEntry.hash, path, 'added', result);
      continue;
    }

    result.push({
      path,
      status: 'modified',
      oldHash: fromEntry.hash,
      newHash: toEntry.hash,
    });
  }
}

export async function getCommitDiffEntries(rootCid: CID, ref: string): Promise<DiffEntry[]> {
  const htree = getTree();
  const result: DiffEntry[] = [];

  const gitDirResult = await htree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return result;
  }

  const commit = await getCommitInfo(rootCid, ref);
  if (!commit) {
    return result;
  }

  if (!commit.parent[0]) {
    await collectTreeFiles(htree, gitDirResult.cid, commit.tree, '', 'added', result);
    result.sort((a, b) => a.path.localeCompare(b.path));
    return result;
  }

  return await getDiff(rootCid, commit.parent[0], commit.oid);
}

/**
 * Get diff between two commits
 * Native implementation - no wasm-git needed
 */
export async function getDiff(
  rootCid: CID,
  fromCommit: string,
  toCommit: string
): Promise<DiffEntry[]> {
  const htree = getTree();
  const startTime = performance.now();
  const result: DiffEntry[] = [];

  // Check for .git directory
  const gitDirResult = await htree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return result;
  }

  try {
    const [fromSha, toSha] = await Promise.all([
      resolveRevisionToCommit(rootCid, fromCommit),
      resolveRevisionToCommit(rootCid, toCommit),
    ]);
    if (!fromSha || !toSha) return result;

    const [fromParsed, toParsed] = await Promise.all([
      getParsedCommitFromSha(htree, gitDirResult.cid, fromSha),
      getParsedCommitFromSha(htree, gitDirResult.cid, toSha),
    ]);
    if (!fromParsed || !toParsed) return result;

    await diffTreeObjects(htree, gitDirResult.cid, fromParsed.tree, toParsed.tree, '', result);

    // Sort by path for consistent output
    result.sort((a, b) => a.path.localeCompare(b.path));

    const elapsed = performance.now() - startTime;
    if (elapsed >= 50) {
      console.log(`[git perf] getDiff completed in ${elapsed.toFixed(0)} ms (files=${result.length})`);
    }

    return result;
  } catch (err) {
    console.error('[git] getDiff failed:', err);
    return result;
  }
}

/**
 * Get file content at a specific commit
 * Native implementation - no wasm-git needed
 */
export async function getFileAtCommit(
  rootCid: CID,
  commitSha: string,
  filePath: string
): Promise<Uint8Array | null> {
  const htree = getTree();

  // Check for .git directory
  const gitDirResult = await htree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return null;
  }

  try {
    const resolvedSha = await resolveRevisionToCommit(rootCid, commitSha);
    if (!resolvedSha) return null;

    const commit = await getParsedCommitFromSha(htree, gitDirResult.cid, resolvedSha);
    if (!commit) return null;

    const entry = await getTreeEntryAtPath(htree, gitDirResult.cid, commit.tree, filePath);
    if (!entry || entry === 'dir') return null;

    const blobObj = await readGitObject(htree, gitDirResult.cid, entry.hash);
    if (!blobObj || blobObj.type !== 'blob') return null;
    return blobObj.content;
  } catch (err) {
    console.error('[git] getFileAtCommit failed:', err);
    return null;
  }
}

function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

async function collectCommitTreeEntries(
  htree: ReturnType<typeof getTree>,
  gitDirCid: CID,
  treeSha: string,
  prefix: string,
  entries: CommitTreeEntry[]
): Promise<void> {
  const treeObj = await readGitObject(htree, gitDirCid, treeSha);
  if (!treeObj || treeObj.type !== 'tree') return;

  for (const entry of parseGitTree(treeObj.content)) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (isTreeMode(entry.mode)) {
      entries.push({ name: entryPath, data: new Uint8Array(0), isDir: true });
      await collectCommitTreeEntries(htree, gitDirCid, entry.hash, entryPath, entries);
      continue;
    }

    const blobObj = await readGitObject(htree, gitDirCid, entry.hash);
    if (!blobObj || blobObj.type !== 'blob') continue;
    entries.push({ name: entryPath, data: blobObj.content, isDir: false });
  }
}

export async function getCommitTreeEntries(rootCid: CID, ref: string): Promise<CommitTreeEntry[]> {
  const htree = getTree();

  const gitDirResult = await htree.resolvePath(rootCid, '.git');
  if (!gitDirResult || gitDirResult.type !== LinkType.Dir) {
    return [];
  }

  const resolvedSha = await resolveRevisionToCommit(rootCid, ref);
  if (!resolvedSha) return [];

  const commit = await getParsedCommitFromSha(htree, gitDirResult.cid, resolvedSha);
  if (!commit) return [];

  const entries: CommitTreeEntry[] = [];
  await collectCommitTreeEntries(htree, gitDirResult.cid, commit.tree, '', entries);
  return entries;
}
