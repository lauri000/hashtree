/**
 * Playlist store and utilities
 *
 * A playlist is detected when a video tree has NO video file at root.
 * If root has video.mp4 etc → single video. Otherwise → playlist of subdirectories.
 *
 * Thresholds:
 * - MIN_VIDEOS_FOR_STRUCTURE (1): Minimum to consider it a playlist
 * - MIN_VIDEOS_FOR_SIDEBAR (2): Minimum to show playlist sidebar
 */

import { writable, get } from 'svelte/store';
import { nip19 } from 'nostr-tools';
import { getTree } from '../store';
import { getRefResolver } from '../refResolver';
import { getLocalRootCache, getLocalRootKey, onCacheUpdate } from '../treeRootCache';
import { LRUCache } from '../utils/lruCache';
import { indexVideo } from './searchIndex';
import { clearFeedPlaylistInfo } from './homeFeedCache';
import { getEncodedNhashUrl, getHtreePrefix, getNhashFileUrl, getStablePathUrl } from '../lib/mediaUrl';
import { getInitialPlaylistItemTitle } from '../lib/videoDisplayTitle';
import { LinkType, toHex, type CID } from '@hashtree/core';
import { findPlayableMediaEntry, isPlayableMediaFileName, PLAYABLE_MEDIA_EXTENSIONS } from '../lib/playableMedia';
import { resolveReadableVideoRoot } from '../lib/readableVideoRoot';
import { readDirectPlayableMediaFileName } from '../lib/directPlayableRoot';
import { buildPreferredTreeEventHref, buildTreeRouteHref } from '../lib/treeEventSnapshots';

// Cache playlist detection results to avoid layout shift on revisit
// Key: "npub/treeName", Value: PlaylistCardInfo or null (for single videos)
const playlistTreeCache = new LRUCache<string, PlaylistCardInfo | null>(200);
const playlistRootCache = new LRUCache<string, PlaylistCardInfo>(400);

// Invalidate playlist caches when video trees are updated
onCacheUpdate((npub: string, treeName: string) => {
  if (treeName.startsWith('videos/')) {
    const cacheKey = `${npub}/${treeName}`;
    playlistTreeCache.delete(cacheKey);
    clearFeedPlaylistInfo(cacheKey);
  }
});

// ============================================================================
// Constants and utilities
// ============================================================================

/** Minimum videos to show playlist sidebar (1 video has nowhere to navigate) */
export const MIN_VIDEOS_FOR_SIDEBAR = 2;

/** Minimum videos to consider a playlist structure */
export const MIN_VIDEOS_FOR_STRUCTURE = 1;

/** Limit total playlist metadata processing */
const MAX_PLAYLIST_METADATA_ITEMS = 400;

/** Video file extensions we recognize */
export const VIDEO_EXTENSIONS = PLAYABLE_MEDIA_EXTENSIONS;

/** Check if entries contain a video file */
export function hasVideoFile(entries: { name: string }[]): boolean {
  return entries.some(e => isPlayableMediaFileName(e.name));
}

/** Check if root is a playlist (no video file at root = playlist) */
export function isPlaylistStructure(entries: { name: string }[]): boolean {
  return !hasVideoFile(entries);
}

/** Find thumbnail entry in a directory */
export function findThumbnailEntry<T extends { name: string }>(entries: T[]): T | undefined {
  return entries.find(e =>
    e.name.startsWith('thumbnail.') ||
    e.name.endsWith('.jpg') ||
    e.name.endsWith('.jpeg') ||
    e.name.endsWith('.webp') ||
    e.name.endsWith('.png')
  );
}

type PlaylistTreeEntry = {
  name: string;
  cid?: CID;
  type?: LinkType;
  meta?: Record<string, unknown>;
};

function hasPlaylistEntryMetadataHint(entry: PlaylistTreeEntry): boolean {
  const meta = entry.meta as Record<string, unknown> | undefined;
  if (!meta) return false;
  return (
    (typeof meta.title === 'string' && meta.title.trim().length > 0)
    || (typeof meta.thumbnail === 'string' && meta.thumbnail.trim().length > 0)
    || typeof meta.duration === 'number'
    || typeof meta.createdAt === 'number'
    || typeof meta.originalDate === 'number'
  );
}

function looksLikePlaylistEntryName(name: string): boolean {
  return /^video[_-]/i.test(name) || !/\.[a-z0-9]{1,8}$/i.test(name);
}

function isLikelyPlaylistVideoEntry(entry: PlaylistTreeEntry): boolean {
  if (!entry?.cid) return false;
  if (typeof entry.type === 'number' && entry.type !== LinkType.Dir) return false;
  return hasPlaylistEntryMetadataHint(entry) || looksLikePlaylistEntryName(entry.name);
}

/** Build SW URL for a thumbnail */
export function buildThumbnailUrl(
  npub: string,
  treeName: string,
  videoDir: string,
  thumbName: string
): string {
  const path = videoDir
    ? `${encodeURIComponent(videoDir)}/${encodeURIComponent(thumbName)}`
    : encodeURIComponent(thumbName);
  return `${getHtreePrefix()}/htree/${npub}/${encodeURIComponent(treeName)}/${path}`;
}

function resolveEmbeddedThumbnailUrl(
  value: unknown,
  entries: Array<{ name: string; cid?: CID }>
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('nhash1')) {
    return getEncodedNhashUrl(trimmed);
  }

  const normalized = trimmed.split('/').filter(Boolean).at(-1);
  if (!normalized) return undefined;
  const entry = entries.find((candidate) => candidate.name === normalized && candidate.cid);
  if (!entry?.cid) return undefined;
  return getNhashFileUrl(entry.cid, entry.name);
}

/**
 * Find the first video entry in a playlist directory.
 * Returns the first child entry that actually contains a video file.
 */
export async function findFirstVideoEntry(rootCid: CID): Promise<string | null> {
  const tree = getTree();

  try {
    const entries = await tree.listDirectory(rootCid);
    if (!entries || entries.length === 0) return null;

    // If root has video file, it's a single video, not a playlist
    if (!isPlaylistStructure(entries)) return null;

    const sorted = entries
      .filter((entry) => !!entry?.cid)
      .sort((a, b) => a.name.localeCompare(b.name));
    const fallbackEntry = sorted.find((entry) => /^video[_-]/i.test(entry.name))
      ?? sorted.find((entry) => isLikelyPlaylistVideoEntry(entry))
      ?? sorted[0];
    let hadIndeterminateChild = false;
    for (const entry of sorted) {
      try {
        const subEntries = await tree.listDirectory(entry.cid);
        if (subEntries && hasVideoFile(subEntries)) {
          return entry.name;
        }
      } catch {
        hadIndeterminateChild = true;
      }
    }
    return hadIndeterminateChild ? fallbackEntry?.name ?? null : null;
  } catch {
    return null;
  }
}

/** Info returned by detectPlaylistForCard */
export interface PlaylistCardInfo {
  videoCount: number;
  thumbnailUrl?: string;
  videoPath?: string;
  rootCid?: CID | null;
  /** Duration in seconds (for single videos) */
  duration?: number;
  /** Created timestamp in seconds (for single videos) */
  createdAt?: number;
  /** Title from metadata (for single videos) */
  title?: string;
}

export function shouldRefreshPlaylistCardInfo(info: PlaylistCardInfo | null | undefined): boolean {
  return !!info && !info.thumbnailUrl && !info.videoPath;
}

function sameHash(a: CID | null | undefined, b: CID | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return toHex(a.hash) === toHex(b.hash)
    && ((a.key && b.key && toHex(a.key) === toHex(b.key)) || (!a.key && !b.key));
}

function getRootCacheKey(rootCid: CID): string {
  return `${toHex(rootCid.hash)}:${rootCid.key ? toHex(rootCid.key) : ''}`;
}

async function readTextViaStablePath(rootCid: CID, path: string): Promise<string | null> {
  const url = getStablePathUrl({ rootCid, path });
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const text = (await response.text()).trim();
    return text || null;
  } catch {
    return null;
  }
}

async function detectDirectRootMediaInfo(rootCid: CID, treeName?: string): Promise<PlaylistCardInfo | null> {
  const tree = getTree();
  const videoPath = await readDirectPlayableMediaFileName(tree, rootCid);
  if (!videoPath) {
    return null;
  }

  const title = treeName?.startsWith('videos/')
    ? treeName.slice(7)
    : treeName;

  return {
    videoCount: 0,
    rootCid,
    videoPath,
    title: title || undefined,
  };
}

/**
 * Get cached playlist info synchronously.
 * Returns undefined if not cached, null if known to be single video,
 * or PlaylistCardInfo if known to be playlist.
 */
export function getCachedPlaylistInfo(npub: string, treeName: string): PlaylistCardInfo | null | undefined {
  return playlistTreeCache.get(`${npub}/${treeName}`);
}

export interface DetectPlaylistForCardOptions {
  cacheScope?: 'tree' | 'root';
  exactRoot?: boolean;
}

/**
 * Detect if a tree is a playlist and get card display info.
 * For single videos, returns { videoCount: 0, duration, thumbnailUrl }.
 * For playlists, returns { videoCount: N, thumbnailUrl }.
 * Used by VideoHome and VideoProfileView for card display.
 * Results are cached to avoid layout shift on revisit.
 */
export async function detectPlaylistForCard(
  rootCid: CID,
  npub: string,
  treeName: string,
  options: DetectPlaylistForCardOptions = {},
): Promise<PlaylistCardInfo | null> {
  const cacheScope = options.cacheScope ?? 'tree';
  const exactRoot = options.exactRoot ?? cacheScope === 'root';
  const cacheKey = `${npub}/${treeName}`;

  if (cacheScope === 'tree') {
    const cached = playlistTreeCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const effectiveRootCid = exactRoot
    ? rootCid
    : await resolveReadableVideoRoot({
        rootCid,
        npub,
        treeName,
        priority: 'background',
      });
  if (!effectiveRootCid) {
    return null;
  }
  const info = await readPlaylistCardInfoAtRoot(effectiveRootCid, treeName);
  if (cacheScope === 'tree' && info && sameHash(effectiveRootCid, rootCid)) {
    playlistTreeCache.set(cacheKey, info);
  }
  return info;
}

async function readPlaylistCardInfoAtRoot(
  effectiveRootCid: CID,
  treeName: string,
): Promise<PlaylistCardInfo | null> {
  const rootCacheKey = getRootCacheKey(effectiveRootCid);
  const cached = playlistRootCache.get(rootCacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const tree = getTree();

  try {
    const entries = await tree.listDirectory(effectiveRootCid);
    if (!entries || entries.length === 0) {
      const directRootInfo = await detectDirectRootMediaInfo(effectiveRootCid, treeName);
      if (directRootInfo) {
        playlistRootCache.set(rootCacheKey, directRootInfo);
        return directRootInfo;
      }
      return null;
    }

    // If root has video file, it's a single video - fetch duration, createdAt, and title
    if (hasVideoFile(entries)) {
      let duration: number | undefined;
      let createdAt: number | undefined;
      let thumbnailUrl: string | undefined;
      let title: string | undefined;
      let videoPath: string | undefined;

      // Try video file's link entry meta first (new format)
      const videoEntry = findPlayableMediaEntry(entries);
      if (videoEntry) {
        videoPath = videoEntry.name;
      }
      if (videoEntry?.meta) {
        const videoMeta = videoEntry.meta as Record<string, unknown>;
        if (typeof videoMeta.duration === 'number') {
          duration = videoMeta.duration;
        }
        if (typeof videoMeta.createdAt === 'number') {
          createdAt = videoMeta.createdAt;
        }
        if (typeof videoMeta.title === 'string') {
          title = videoMeta.title;
        }
        if (typeof videoMeta.thumbnail === 'string') {
          thumbnailUrl = getEncodedNhashUrl(videoMeta.thumbnail);
        }
      }

      // Fall back to metadata.json (legacy format)
      if (!duration || !createdAt || !title) {
        const metadataEntry = entries.find(e => e.name === 'metadata.json');
        if (metadataEntry) {
          try {
            const metadataData = await tree.readFile(metadataEntry.cid);
            if (metadataData) {
              const metadata = JSON.parse(new TextDecoder().decode(metadataData));
              if (!thumbnailUrl) {
                thumbnailUrl = resolveEmbeddedThumbnailUrl(metadata.thumbnail, entries);
              }
              if (!duration && typeof metadata.duration === 'number') {
                duration = metadata.duration;
              }
              if (!createdAt && typeof metadata.createdAt === 'number') {
                createdAt = metadata.createdAt;
              }
              if (!title && typeof metadata.title === 'string') {
                title = metadata.title;
              }
            }
          } catch { /* ignore */ }
        }
      }

      // Try info.json if no duration or title yet
      if (!duration || !title) {
        const infoEntry = entries.find(e => e.name === 'info.json');
        if (infoEntry) {
          try {
            const infoData = await tree.readFile(infoEntry.cid);
            if (infoData) {
              const info = JSON.parse(new TextDecoder().decode(infoData));
              if (!thumbnailUrl) {
                thumbnailUrl = resolveEmbeddedThumbnailUrl(info.thumbnail, entries);
              }
              if (!duration && typeof info.duration === 'number') {
                duration = info.duration;
              }
              if (!title && typeof info.title === 'string') {
                title = info.title;
              }
            }
          } catch { /* ignore */ }
        }
      }

      // Find thumbnail
      const thumbEntry = findThumbnailEntry(entries);
      if (thumbEntry) {
        thumbnailUrl = getNhashFileUrl(thumbEntry.cid, thumbEntry.name);
      }

      const info: PlaylistCardInfo = {
        videoCount: 0,
        rootCid: effectiveRootCid,
        duration,
        thumbnailUrl,
        videoPath,
        createdAt,
        title,
      };
      playlistRootCache.set(rootCacheKey, info);
      return info;
    }

    // It's a playlist - find first thumbnail in parallel
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    // Check first few entries in parallel for speed
    const results = await Promise.all(
      sorted.slice(0, 5).map(async (entry) => {
        try {
          const subEntries = await tree.listDirectory(entry.cid);
          if (subEntries) {
            const thumbEntry = findThumbnailEntry(subEntries);
            if (thumbEntry) {
              return getNhashFileUrl(thumbEntry.cid, thumbEntry.name);
            }
          }
        } catch { /* skip */ }
        return null;
      })
    );

    const thumbnailUrl = results.find(r => r !== null) ?? undefined;
    const info: PlaylistCardInfo = { videoCount: entries.length, thumbnailUrl, rootCid: effectiveRootCid };
    playlistRootCache.set(rootCacheKey, info);
    return info;
  } catch {
    return null;
  }
}

async function readSingleVideoCardInfo(rootCid: CID): Promise<PlaylistCardInfo | null> {
  const tree = getTree();

  try {
    const entries = await tree.listDirectory(rootCid);
    if (!entries || entries.length === 0) {
      return detectDirectRootMediaInfo(rootCid);
    }

    let duration: number | undefined;
    let createdAt: number | undefined;
    let thumbnailUrl: string | undefined;
    let title: string | undefined;
    let videoPath: string | undefined;

    const videoEntry = findPlayableMediaEntry(entries);
    if (videoEntry) {
      videoPath = videoEntry.name;
    }
    if (videoEntry?.meta) {
      const videoMeta = videoEntry.meta as Record<string, unknown>;
      if (typeof videoMeta.duration === 'number') {
        duration = videoMeta.duration;
      }
      if (typeof videoMeta.createdAt === 'number') {
        createdAt = videoMeta.createdAt;
      }
      if (typeof videoMeta.title === 'string') {
        title = videoMeta.title;
      }
      if (typeof videoMeta.thumbnail === 'string') {
        thumbnailUrl = getEncodedNhashUrl(videoMeta.thumbnail);
      }
    }

    if (!duration || !createdAt || !title) {
      const metadataEntry = entries.find(e => e.name === 'metadata.json');
      if (metadataEntry) {
        try {
          const metadataData = await tree.readFile(metadataEntry.cid);
          if (metadataData) {
            const metadata = JSON.parse(new TextDecoder().decode(metadataData));
            if (!thumbnailUrl) {
              thumbnailUrl = resolveEmbeddedThumbnailUrl(metadata.thumbnail, entries);
            }
            if (!duration && typeof metadata.duration === 'number') {
              duration = metadata.duration;
            }
            if (!createdAt && typeof metadata.createdAt === 'number') {
              createdAt = metadata.createdAt;
            }
            if (!title && typeof metadata.title === 'string') {
              title = metadata.title;
            }
          }
        } catch { /* ignore */ }
      }
    }

    if (!duration || !title) {
      const infoEntry = entries.find(e => e.name === 'info.json');
      if (infoEntry) {
        try {
          const infoData = await tree.readFile(infoEntry.cid);
          if (infoData) {
            const info = JSON.parse(new TextDecoder().decode(infoData));
            if (!thumbnailUrl) {
              thumbnailUrl = resolveEmbeddedThumbnailUrl(info.thumbnail, entries);
            }
            if (!duration && typeof info.duration === 'number') {
              duration = info.duration;
            }
            if (!title && typeof info.title === 'string') {
              title = info.title;
            }
          }
        } catch { /* ignore */ }
      }
    }

    const thumbEntry = findThumbnailEntry(entries);
    if (thumbEntry) {
      thumbnailUrl = getNhashFileUrl(thumbEntry.cid, thumbEntry.name);
    }

    return { videoCount: 0, rootCid, duration, thumbnailUrl, videoPath, createdAt, title };
  } catch {
    return null;
  }
}

export async function detectVideoCardInfo(
  rootCid: CID,
  npub: string,
  treeName: string,
  videoId?: string,
  options: { exactRoot?: boolean } = {},
): Promise<PlaylistCardInfo | null> {
  if (!videoId) {
    return detectPlaylistForCard(rootCid, npub, treeName, {
      exactRoot: options.exactRoot,
    });
  }

  const tree = getTree();
  const effectiveRootCid = options.exactRoot
    ? rootCid
    : await resolveReadableVideoRoot({
        rootCid,
        npub,
        treeName,
        videoId,
        priority: 'background',
      });
  if (!effectiveRootCid) {
    return null;
  }
  try {
    const videoDir = await tree.resolvePath(effectiveRootCid, videoId);
    if (!videoDir) {
      return null;
    }
    return await readSingleVideoCardInfo(videoDir.cid);
  } catch {
    return null;
  }
}

// ============================================================================
// Types
// ============================================================================

export interface PlaylistItem {
  id: string;           // Directory name (e.g., video ID)
  title: string;        // From info.json or title.txt
  thumbnailUrl?: string; // SW URL to thumbnail
  duration?: number;    // From info.json (seconds)
  cid: CID;            // CID of the video subdirectory
}

export interface Playlist {
  name: string;         // Channel/playlist name
  items: PlaylistItem[];
  currentIndex: number;
  npub: string;
  treeName: string;     // e.g., "videos/Channel Name"
}

// Current playlist state
export const currentPlaylist = writable<Playlist | null>(null);

// Repeat modes: 'none' = stop at end, 'all' = loop playlist, 'one' = loop current video
export type RepeatMode = 'none' | 'all' | 'one';
export const repeatMode = writable<RepeatMode>('none');

// Shuffle mode: when enabled, playNext picks a random video
export const shuffleEnabled = writable<boolean>(false);

// Cycle through repeat modes
export function cycleRepeatMode(): RepeatMode {
  let newMode: RepeatMode = 'none';
  repeatMode.update(mode => {
    if (mode === 'none') newMode = 'all';
    else if (mode === 'all') newMode = 'one';
    else newMode = 'none';
    return newMode;
  });
  return newMode;
}

// Toggle shuffle
export function toggleShuffle(): boolean {
  let enabled = false;
  shuffleEnabled.update(v => {
    enabled = !v;
    return enabled;
  });
  return enabled;
}

/**
 * Load playlist from a video tree that has subdirectories
 * Shows sidebar immediately with folder names, then progressively loads metadata.
 *
 * @param npub Owner's npub
 * @param treeName Full tree name (e.g., "videos/Channel Name")
 * @param rootCid Root CID of the tree
 * @param currentVideoId Currently playing video's directory name
 */
export async function loadPlaylist(
  npub: string,
  treeName: string,
  rootCid: CID,
  currentVideoId?: string
): Promise<Playlist | null> {
  // Check if this playlist is already loaded - just update currentIndex
  const existing = get(currentPlaylist);
  if (existing && existing.npub === npub && existing.treeName === treeName) {
    if (currentVideoId) {
      const idx = existing.items.findIndex(v => v.id === currentVideoId);
      if (idx !== -1 && idx !== existing.currentIndex) {
        currentPlaylist.update(p => p ? { ...p, currentIndex: idx } : null);
      }
    }
    return existing;
  }

  const tree = getTree();

  try {
    // List root directory
    const entries = await tree.listDirectory(rootCid);
    if (!entries || entries.length === 0) return null;

    // Quick check: identify which entries are video directories
    // Use short timeout for initial detection
    const candidateEntries = entries.filter((entry) => !!entry?.cid);
    const quickChecks = await Promise.all(
      candidateEntries.map(async (entry): Promise<{ entry: typeof candidateEntries[number]; status: 'video' | 'not-video' | 'indeterminate' }> => {
        try {
          const subEntries = await Promise.race([
            tree.listDirectory(entry.cid),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
          ]);
          return {
            entry,
            status: subEntries && hasVideoFile(subEntries) ? 'video' : 'not-video',
          };
        } catch {
          return { entry, status: 'indeterminate' };
        }
      })
    );

    const selectedEntries = new Map<string, typeof candidateEntries[number]>();
    for (const check of quickChecks) {
      if (check.status === 'video') {
        selectedEntries.set(check.entry.name, check.entry);
      }
    }

    if (currentVideoId) {
      const currentEntry = candidateEntries.find((entry) => entry.name === currentVideoId);
      if (currentEntry) {
        selectedEntries.set(currentEntry.name, currentEntry);
      }
    }

    if (selectedEntries.size < MIN_VIDEOS_FOR_SIDEBAR) {
      for (const check of quickChecks) {
        if (check.status !== 'indeterminate' || !isLikelyPlaylistVideoEntry(check.entry)) {
          continue;
        }
        selectedEntries.set(check.entry.name, check.entry);
        if (selectedEntries.size >= MIN_VIDEOS_FOR_SIDEBAR) {
          break;
        }
      }
    }

    const videoEntries = Array.from(selectedEntries.values());

    // Only show playlist sidebar if we have enough videos
    if (videoEntries.length < MIN_VIDEOS_FOR_SIDEBAR) return null;

    // Sort entries by name for consistent ordering
    videoEntries.sort((a, b) => a.name.localeCompare(b.name));

    // Avoid flashing synthetic generated folder ids like video_123456789 while metadata loads.
    const skeletonItems: PlaylistItem[] = videoEntries.map(entry => ({
      id: entry.name,
      title: getInitialPlaylistItemTitle(entry.name),
      cid: entry.cid,
    }));

    // Find current index
    let currentIndex = 0;
    if (currentVideoId) {
      const idx = skeletonItems.findIndex(v => v.id === currentVideoId);
      if (idx !== -1) currentIndex = idx;
    }

    // Extract playlist name
    const name = treeName.replace(/^videos\//, '');

    // Set playlist immediately with skeleton items (sidebar appears now!)
    const playlist: Playlist = {
      name,
      items: skeletonItems,
      currentIndex,
      npub,
      treeName,
    };
    currentPlaylist.set(playlist);

    // Load metadata in background, updating store progressively
    loadPlaylistMetadata(npub, treeName, videoEntries, currentIndex);

    return playlist;
  } catch (e) {
    console.error('Failed to load playlist:', e);
    return null;
  }
}

/**
 * Load metadata for playlist items in background
 * Updates the store progressively as metadata loads
 */
async function loadPlaylistMetadata(
  npub: string,
  treeName: string,
  entries: Array<{ name: string; cid: CID; meta?: Record<string, unknown> }>,
  currentIndex: number
): Promise<void> {
  const tree = getTree();

  // Load current video first for better UX
  const orderedEntries = [...entries];
  if (currentIndex > 0 && currentIndex < orderedEntries.length) {
    const current = orderedEntries.splice(currentIndex, 1)[0];
    orderedEntries.unshift(current);
  }

  const entriesToProcess = orderedEntries.length > MAX_PLAYLIST_METADATA_ITEMS
    ? orderedEntries.slice(0, MAX_PLAYLIST_METADATA_ITEMS)
    : orderedEntries;

  const processEntry = async (entry: typeof entries[0]): Promise<void> => {
    try {
      let title = entry.name;
      let duration: number | undefined;
      let thumbnailUrl: string | undefined;

      // Check parent entry metadata first (new optimized format - no subdirectory reads needed)
      const entryMeta = entry.meta as Record<string, unknown> | undefined;
      if (entryMeta?.title && typeof entryMeta.title === 'string') {
        title = entryMeta.title;
      }
      if (entryMeta?.duration && typeof entryMeta.duration === 'number') {
        duration = entryMeta.duration;
      }
      if (entryMeta?.thumbnail && typeof entryMeta.thumbnail === 'string') {
        // Thumbnail stored as nhash - use direct nhash URL
        thumbnailUrl = getEncodedNhashUrl(entryMeta.thumbnail);
      }

      // If we have full metadata from parent entry meta, skip subdirectory reads
      if (title !== entry.name && duration && thumbnailUrl) {
        currentPlaylist.update(playlist => {
          if (!playlist) return playlist;
          const items = playlist.items.map(item =>
            item.id === entry.name
              ? { ...item, title, duration, thumbnailUrl }
              : item
          );
          return { ...playlist, items };
        });
        return;
      }

      let subEntries: Array<{ name: string; cid: CID; size: number; type: LinkType; meta?: Record<string, unknown> }> | null = null;
      try {
        subEntries = await tree.listDirectory(entry.cid);
      } catch {}
      if (!subEntries) {
        if (title === entry.name) {
          const remoteTitle = await readTextViaStablePath(entry.cid, 'title.txt');
          if (remoteTitle) {
            title = remoteTitle;
          }
        }
        if (title !== entry.name || duration || thumbnailUrl) {
          currentPlaylist.update(playlist => {
            if (!playlist) return playlist;
            const items = playlist.items.map(item =>
              item.id === entry.name
                ? { ...item, title, duration, thumbnailUrl }
                : item
            );
            return { ...playlist, items };
          });
        }
        return;
      }

      // Try video file's link entry meta first (new format)
      if (title === entry.name) {
        const videoEntry = findPlayableMediaEntry(subEntries);
        if (videoEntry?.meta) {
          const videoMeta = videoEntry.meta as Record<string, unknown>;
          if (videoMeta.title && typeof videoMeta.title === 'string') {
            title = videoMeta.title;
          }
          if (!duration && videoMeta.duration && typeof videoMeta.duration === 'number') {
            duration = videoMeta.duration;
          }
        }
      }

      // Fall back to metadata.json (legacy format)
      if (title === entry.name) {
        const metadataEntry = subEntries.find(e => e.name === 'metadata.json');
        if (metadataEntry) {
          try {
            const metadataData = await tree.readFile(metadataEntry.cid);
            if (metadataData) {
              const metadata = JSON.parse(new TextDecoder().decode(metadataData));
              title = metadata.title || title;
              if (!duration && typeof metadata.duration === 'number') {
                duration = metadata.duration;
              }
            }
          } catch {}
        }
      }

      // Try info.json (yt-dlp format with duration)
      if (!duration || title === entry.name) {
        const infoEntry = subEntries.find(e => e.name === 'info.json');
        if (infoEntry) {
          try {
            const infoData = await tree.readFile(infoEntry.cid);
            if (infoData) {
              const info = JSON.parse(new TextDecoder().decode(infoData));
              if (title === entry.name) title = info.title || title;
              if (!duration) duration = info.duration;
            }
          } catch {}
        }
      }

      // Try title.txt if still no title (legacy format)
      if (title === entry.name) {
        const titleEntry = subEntries.find(e => e.name === 'title.txt');
        if (titleEntry) {
          try {
            const titleData = await tree.readFile(titleEntry.cid);
            if (titleData) {
              title = new TextDecoder().decode(titleData).trim();
            }
          } catch {}
        }
      }

      if (title === entry.name) {
        const remoteTitle = await readTextViaStablePath(entry.cid, 'title.txt');
        if (remoteTitle) {
          title = remoteTitle;
        }
      }

      // Find thumbnail from subdirectory if not in entry meta
      if (!thumbnailUrl) {
        const thumbEntry = findThumbnailEntry(subEntries);
        if (thumbEntry) {
          thumbnailUrl = getNhashFileUrl(thumbEntry.cid, thumbEntry.name);
        }
      }

      // Update the store with this item's metadata
      currentPlaylist.update(playlist => {
        if (!playlist) return playlist;
        const items = playlist.items.map(item =>
          item.id === entry.name
            ? { ...item, title, duration, thumbnailUrl }
            : item
        );
        return { ...playlist, items };
      });

      // Index for search (only if we have a real title, not just folder name)
      if (title !== entry.name) {
        try {
          const pubkey = nip19.decode(npub).data as string;
          const href = await buildPreferredTreeEventHref(npub, treeName, [entry.name]).catch(() =>
            buildTreeRouteHref(npub, treeName, [entry.name])
          );
          await indexVideo({
            title,
            pubkey,
            treeName,
            videoId: entry.name,
            href,
            timestamp: Date.now(),
            duration,
          });
        } catch {}
      }
    } catch {}
  };

  await Promise.allSettled(entriesToProcess.map(processEntry));
}

/**
 * Navigate to next video in playlist
 * @param options.shuffle Override shuffle setting (for auto-play)
 * @param options.wrap Whether to wrap around to start (for repeat all)
 */
export function playNext(options?: { shuffle?: boolean; wrap?: boolean }): string | null {
  const playlist = get(currentPlaylist);
  if (!playlist || playlist.items.length === 0) return null;

  const shuffle = options?.shuffle ?? get(shuffleEnabled);
  const wrap = options?.wrap ?? true;

  let nextIndex: number;

  if (shuffle) {
    // Pick random video (different from current if possible)
    if (playlist.items.length === 1) {
      nextIndex = 0;
    } else {
      do {
        nextIndex = Math.floor(Math.random() * playlist.items.length);
      } while (nextIndex === playlist.currentIndex);
    }
  } else {
    // Sequential: go to next
    nextIndex = playlist.currentIndex + 1;
    if (nextIndex >= playlist.items.length) {
      if (wrap) {
        nextIndex = 0;
      } else {
        return null; // End of playlist
      }
    }
  }

  const nextItem = playlist.items[nextIndex];
  currentPlaylist.update(p => p ? { ...p, currentIndex: nextIndex } : null);

  // Return URL hash for navigation
  return `#/${playlist.npub}/${encodeURIComponent(playlist.treeName)}/${encodeURIComponent(nextItem.id)}`;
}

/**
 * Navigate to previous video in playlist
 */
export function playPrevious(): string | null {
  const playlist = get(currentPlaylist);
  if (!playlist || playlist.items.length === 0) return null;

  const prevIndex = playlist.currentIndex === 0
    ? playlist.items.length - 1
    : playlist.currentIndex - 1;
  const prevItem = playlist.items[prevIndex];

  currentPlaylist.update(p => p ? { ...p, currentIndex: prevIndex } : null);

  return `#/${playlist.npub}/${encodeURIComponent(playlist.treeName)}/${encodeURIComponent(prevItem.id)}`;
}

/**
 * Navigate to specific video by index
 */
export function playAt(index: number): string | null {
  const playlist = get(currentPlaylist);
  if (!playlist || index < 0 || index >= playlist.items.length) return null;

  const item = playlist.items[index];
  currentPlaylist.update(p => p ? { ...p, currentIndex: index } : null);

  return `#/${playlist.npub}/${encodeURIComponent(playlist.treeName)}/${encodeURIComponent(item.id)}`;
}

/**
 * Load playlist when viewing a video inside a playlist
 * Resolves the parent tree and loads the playlist
 * @param npub Owner's npub
 * @param parentTreeName Parent tree name (e.g., "videos/Channel Name")
 * @param currentVideoId Current video's directory name
 */
export async function loadPlaylistFromVideo(
  npub: string,
  parentTreeName: string,
  currentVideoId: string
): Promise<Playlist | null> {
  try {
    let parentRoot: CID | null = null;

    // Check local cache first (for recently uploaded playlists)
    const localHash = getLocalRootCache(npub, parentTreeName);
    if (localHash) {
      const localKey = getLocalRootKey(npub, parentTreeName);
      parentRoot = { hash: localHash, key: localKey };
      console.log('[Playlist] Found in local cache:', parentTreeName);
    }

    // If not in local cache, try resolver
    if (!parentRoot) {
      const resolver = getRefResolver();
      parentRoot = await resolver.resolve(`${npub}/${parentTreeName}`);
    }

    if (!parentRoot) {
      console.log('[Playlist] Could not resolve parent tree:', parentTreeName);
      return null;
    }

    // Load the playlist from the parent tree
    return loadPlaylist(npub, parentTreeName, parentRoot, currentVideoId);
  } catch (e) {
    console.error('Failed to load playlist from video:', e);
    return null;
  }
}

/**
 * Clear current playlist
 */
export function clearPlaylist() {
  currentPlaylist.set(null);
}
