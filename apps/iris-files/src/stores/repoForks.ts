import { writable } from 'svelte/store';
import { type NDKEvent, ndk } from '../nostr';
import { fetchRepoAnnouncement, buildRepoAddress } from '../nip34';
import { type GitRepoAnnouncement, isNewerGitRepoAnnouncement, parseGitRepoAnnouncement } from '../lib/gitRepoAnnouncements';
import { LRUCache } from '../utils/lruCache';
import { KeyedEventEmitter } from '../utils/keyedEventEmitter';
import { KIND_REPO_ANNOUNCEMENT } from '../utils/constants';

export interface RepoForkStats {
  address: string;
  count: number;
  updatedAt: number;
  earliestUniqueCommit: string | null;
}

const repoForkStatsCache = new LRUCache<string, RepoForkStats>(200);
const repoForkStatsEmitter = new KeyedEventEmitter<string, RepoForkStats>();
const repoForkSourceCache = new Map<string, GitRepoAnnouncement | null>();
const repoForkAnnouncementCache = new Map<string, Map<string, GitRepoAnnouncement>>();
const activeRepoForkSubscriptions = new Map<string, { stop: () => void }>();

function getRepoForkAnnouncementMap(repoAddress: string): Map<string, GitRepoAnnouncement> {
  let announcements = repoForkAnnouncementCache.get(repoAddress);
  if (!announcements) {
    announcements = new Map();
    repoForkAnnouncementCache.set(repoAddress, announcements);
  }

  return announcements;
}

function rebuildRepoForkStats(repoAddress: string): void {
  const sourceAnnouncement = repoForkSourceCache.get(repoAddress);
  const announcements = [...getRepoForkAnnouncementMap(repoAddress).values()];
  const earliestUniqueCommit = sourceAnnouncement?.earliestUniqueCommit ?? null;

  const snapshot: RepoForkStats = {
    address: repoAddress,
    count: announcements.filter(announcement => (
      !!earliestUniqueCommit &&
      announcement.earliestUniqueCommit === earliestUniqueCommit &&
      announcement.address !== sourceAnnouncement?.address &&
      announcement.isPersonalFork
    )).length,
    updatedAt: announcements.reduce(
      (latest, announcement) => Math.max(latest, announcement.createdAt),
      sourceAnnouncement?.createdAt || 0,
    ),
    earliestUniqueCommit,
  };

  repoForkStatsCache.set(repoAddress, snapshot);
  repoForkStatsEmitter.notify(repoAddress, snapshot);
}

function applyRepoForkAnnouncement(repoAddress: string, announcement: GitRepoAnnouncement): void {
  const announcements = getRepoForkAnnouncementMap(repoAddress);
  const current = announcements.get(announcement.address);
  if (!isNewerGitRepoAnnouncement(announcement, current)) {
    return;
  }

  announcements.set(announcement.address, announcement);

  if (announcement.address === repoAddress) {
    repoForkSourceCache.set(repoAddress, announcement);
  }

  rebuildRepoForkStats(repoAddress);
}

async function fetchRepoForkStats(ownerNpub: string, repoName: string): Promise<void> {
  let repoAddress = '';
  try {
    repoAddress = buildRepoAddress(ownerNpub, repoName);
  } catch {
    return;
  }

  if (!repoAddress || activeRepoForkSubscriptions.has(repoAddress)) {
    return;
  }

  const sourceAnnouncement = await fetchRepoAnnouncement(ownerNpub, repoName);
  repoForkSourceCache.set(repoAddress, sourceAnnouncement);
  if (sourceAnnouncement) {
    getRepoForkAnnouncementMap(repoAddress).set(sourceAnnouncement.address, sourceAnnouncement);
  }
  rebuildRepoForkStats(repoAddress);

  if (!sourceAnnouncement?.earliestUniqueCommit) {
    return;
  }

  const sub = ndk.subscribe(
    {
      kinds: [KIND_REPO_ANNOUNCEMENT],
      '#r': [sourceAnnouncement.earliestUniqueCommit],
    },
    { closeOnEose: false },
  );

  sub.on('event', (event: NDKEvent) => {
    const announcement = parseGitRepoAnnouncement(event);
    if (!announcement || announcement.earliestUniqueCommit !== sourceAnnouncement.earliestUniqueCommit) {
      return;
    }

    applyRepoForkAnnouncement(repoAddress, announcement);
  });

  activeRepoForkSubscriptions.set(repoAddress, { stop: () => sub.stop() });
}

export function createRepoForkStatsStore(ownerNpub?: string, repoName?: string) {
  let repoAddress = '';
  if (ownerNpub && repoName) {
    try {
      repoAddress = buildRepoAddress(ownerNpub, repoName);
    } catch {
      repoAddress = '';
    }
  }

  const { subscribe: storeSubscribe, set } = writable<RepoForkStats | undefined>(
    repoAddress ? repoForkStatsCache.get(repoAddress) : undefined,
  );

  if (repoAddress && ownerNpub && repoName) {
    const unsubscribe = repoForkStatsEmitter.subscribe(repoAddress, set);
    const cached = repoForkStatsCache.get(repoAddress);
    if (cached) {
      set(cached);
    } else {
      void fetchRepoForkStats(ownerNpub, repoName);
    }

    return {
      subscribe: storeSubscribe,
      destroy: unsubscribe,
    };
  }

  return {
    subscribe: storeSubscribe,
    destroy: () => {},
  };
}
