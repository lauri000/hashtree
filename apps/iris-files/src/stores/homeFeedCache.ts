/**
 * Persistent cache for home feed videos
 * Survives component unmount for instant back-nav
 */
import { SortedMap } from '../utils/SortedMap';
import { SvelteSet } from 'svelte/reactivity';
import type { CID } from '@hashtree/core';
import { writable } from 'svelte/store';
import type { VideoItem } from '../components/Video/types';

export interface PlaylistInfo {
  videoCount: number;
  thumbnailUrl?: string;
  videoPath?: string;
  rootCid?: CID | null;
  duration?: number;
  createdAt?: number;
  title?: string;
}

export interface RecentVideoCardInfo extends PlaylistInfo {
  rootCid?: CID | null;
}

// Videos from followed users
export const videosByKey = new SortedMap<string, VideoItem>(
  (a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0)
);

// Videos liked/commented by followed users
export const socialVideosByKey = new SortedMap<string, VideoItem>(
  (a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0)
);

// Seen event IDs for deduplication
export const socialSeenEventIds = new SvelteSet<string>();

// Playlist detection results for feed videos
const feedPlaylistInfoCache: Record<string, PlaylistInfo> = {};

// Resolved media for recent cards keyed by recent path.
const recentVideoCardInfoCache: Record<string, RecentVideoCardInfo> = {};
export const recentVideoCardInfoVersion = writable(0);

// Track which user the cache is for
let cachedForPubkey: string | null = null;

/**
 * Clear caches when user changes
 */
export function clearCacheIfUserChanged(pubkey: string | null): boolean {
  if (pubkey !== cachedForPubkey) {
    videosByKey.clear();
    socialVideosByKey.clear();
    socialSeenEventIds.clear();
    // Clear playlist info cache
    for (const key of Object.keys(feedPlaylistInfoCache)) {
      delete feedPlaylistInfoCache[key];
    }
    cachedForPubkey = pubkey;
    return true;
  }
  return false;
}

/**
 * Get cached videos for immediate render
 */
export function getCachedVideos(): VideoItem[] {
  return videosByKey.values();
}

/**
 * Get cached social videos for immediate render
 */
export function getCachedSocialVideos(): VideoItem[] {
  return socialVideosByKey.values();
}

/**
 * Get cached playlist info for a video
 */
export function getFeedPlaylistInfo(key: string): PlaylistInfo | undefined {
  return feedPlaylistInfoCache[key];
}

/**
 * Set playlist info for a video
 */
export function setFeedPlaylistInfo(key: string, info: PlaylistInfo): void {
  feedPlaylistInfoCache[key] = info;
}

/**
 * Get all cached playlist info
 */
export function getAllFeedPlaylistInfo(): Record<string, PlaylistInfo> {
  return feedPlaylistInfoCache;
}

/**
 * Clear playlist info for a specific key
 */
export function clearFeedPlaylistInfo(key: string): void {
  delete feedPlaylistInfoCache[key];
}

export function getRecentVideoCardInfo(key: string): RecentVideoCardInfo | undefined {
  return recentVideoCardInfoCache[key];
}

export function setRecentVideoCardInfo(key: string, info: RecentVideoCardInfo): void {
  const existing = recentVideoCardInfoCache[key];
  recentVideoCardInfoCache[key] = {
    ...(existing ?? {}),
    ...info,
    rootCid: info.rootCid ?? existing?.rootCid ?? null,
  };
  recentVideoCardInfoVersion.update((version) => version + 1);
}

export function clearRecentVideoCardInfo(key: string): void {
  delete recentVideoCardInfoCache[key];
  recentVideoCardInfoVersion.update((version) => version + 1);
}
