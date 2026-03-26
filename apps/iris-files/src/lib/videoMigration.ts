import { LinkType, nhashEncode, type CID, type TreeVisibility } from '@hashtree/core';
import { findPlayableMediaEntry } from './playableMedia';
import { getRefResolver } from '../refResolver';
import { getTree } from '../store';
import { getWorkerAdapter, waitForRelayConnection, waitForWorkerAdapter } from './workerInit';
import { getLinkKey, recoverLinkKeyFromSelfEncrypted, storeLinkKey, waitForLinkKeysCache } from '../stores/trees';
import { getTreeRootSync, waitForTreeRoot } from '../stores/treeRoot';
import { resolveReadableThumbnailRoot, resolveReadableVideoRoot } from './readableVideoRoot';
import { nostrStore, saveHashtree } from '../nostr';

const VIDEO_TREE_PREFIX = 'videos/';
const LIST_STABLE_WINDOW_MS = 1200;
const LIST_MAX_WAIT_MS = 10000;

export type VideoRepairIssueCode =
  | 'legacy-metadata'
  | 'missing-title'
  | 'missing-description'
  | 'missing-duration'
  | 'missing-thumbnail'
  | 'playlist-metadata'
  | 'historical-root'
  | 'historical-thumbnail'
  | 'missing-playable-media'
  | 'link-key-unavailable';

export interface VideoDirectoryEntry {
  name: string;
  cid: CID;
  size: number;
  type: LinkType;
  meta?: Record<string, unknown>;
}

export interface VideoMigrationTree {
  listDirectory: (cid: CID) => Promise<VideoDirectoryEntry[] | null>;
  readFile: (cid: CID) => Promise<Uint8Array | null>;
  setEntry: (
    rootCid: CID,
    path: string[],
    name: string,
    entryCid: CID,
    size: number,
    type: LinkType,
    meta?: Record<string, unknown>,
  ) => Promise<CID>;
}

export interface SingleVideoRepairPlan {
  kind: 'single';
  baseRootCid: CID;
  videoEntry: VideoDirectoryEntry;
  nextVideoMeta: Record<string, unknown>;
  thumbnailEntryToEnsure?: VideoDirectoryEntry;
  issueCodes: VideoRepairIssueCode[];
  summary: string[];
}

export interface PlaylistChildRepairPlan {
  childName: string;
  baseParentEntry: VideoDirectoryEntry;
  videoEntry: VideoDirectoryEntry;
  nextParentMeta: Record<string, unknown>;
  nextVideoMeta: Record<string, unknown>;
  thumbnailEntryToEnsure?: VideoDirectoryEntry;
  issueCodes: VideoRepairIssueCode[];
}

export interface PlaylistRepairPlan {
  kind: 'playlist';
  baseRootCid: CID;
  childPlans: PlaylistChildRepairPlan[];
  issueCodes: VideoRepairIssueCode[];
  summary: string[];
}

export type VideoDirectoryRepairPlan = SingleVideoRepairPlan | PlaylistRepairPlan;

export interface VideoDirectoryRepairAnalysis {
  kind: 'single' | 'playlist';
  issueCodes: VideoRepairIssueCode[];
  unresolvedIssueCodes: VideoRepairIssueCode[];
  summary: string[];
  plan: VideoDirectoryRepairPlan | null;
}

interface DirectorySidecars {
  metadataJson: Record<string, unknown> | null;
  infoJson: Record<string, unknown> | null;
  titleText: string | null;
  descriptionText: string | null;
  legacyFiles: string[];
}

interface ThumbnailResolution {
  nhash?: string;
  entry?: VideoDirectoryEntry;
  fromDonor?: boolean;
}

interface NormalizedMetaResult {
  nextMeta: Record<string, unknown>;
  issueCodes: Set<VideoRepairIssueCode>;
  unresolvedIssueCodes: Set<VideoRepairIssueCode>;
  legacyMetadataFound: boolean;
  usedDonorMetadata: boolean;
  thumbnailEntryToEnsure?: VideoDirectoryEntry;
}

interface BuildNormalizedMetaOptions {
  primaryMeta?: Record<string, unknown>;
  fallbackMeta?: Record<string, unknown>;
  sidecars: DirectorySidecars;
  donorMeta?: Record<string, unknown>;
  donorFallbackMeta?: Record<string, unknown>;
  donorSidecars?: DirectorySidecars | null;
  baseEntries: VideoDirectoryEntry[];
  donorEntries?: VideoDirectoryEntry[] | null;
  fallbackTitle: string;
  fallbackCreatedAt?: number;
}

interface ResolverListEntryLike {
  key: string;
  cid: CID;
  labels?: string[];
  visibility?: TreeVisibility;
  selfEncryptedLinkKey?: string;
  createdAt?: number;
}

export interface VideoMigrationCandidate {
  npub: string;
  treeName: string;
  displayName: string;
  visibility: TreeVisibility;
  createdAt?: number;
  currentRootCid: CID;
  publishBaseRootCid: CID;
  thumbnailSourceRootCid?: CID | null;
  issueCodes: VideoRepairIssueCode[];
  unresolvedIssueCodes: VideoRepairIssueCode[];
  summary: string[];
  plan: VideoDirectoryRepairPlan | null;
  status: 'ready' | 'clean' | 'unfixable' | 'error';
  currentRootWasReplaced: boolean;
  publishBlockedReason?: string;
  error?: string;
}

export interface VideoMigrationScanProgress {
  stage: 'list' | 'inspect';
  current: number;
  total: number;
  treeName?: string;
}

export interface PublishedVideoMigrationResult {
  cid: CID;
  visibility: TreeVisibility;
  blossom?: { pushed: number; skipped: number; failed: number; errors?: string[] };
}

function trimString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readOriginalDate(value: unknown): string | number | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function cloneMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  return meta ? { ...meta } : {};
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const sorted = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, candidate]) => [key, canonicalize(candidate)]);
    return Object.fromEntries(sorted);
  }
  return value;
}

function metaEquals(a: Record<string, unknown> | undefined, b: Record<string, unknown>): boolean {
  return JSON.stringify(canonicalize(a ?? {})) === JSON.stringify(canonicalize(b));
}

function sameHash(a: CID | null | undefined, b: CID | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.hash.length !== b.hash.length) return false;
  for (let i = 0; i < a.hash.length; i += 1) {
    if (a.hash[i] !== b.hash[i]) {
      return false;
    }
  }
  return true;
}

function getVideoDisplayName(treeName: string): string {
  return treeName.startsWith(VIDEO_TREE_PREFIX)
    ? treeName.slice(VIDEO_TREE_PREFIX.length)
    : treeName;
}

function findThumbnailEntry(entries: VideoDirectoryEntry[]): VideoDirectoryEntry | undefined {
  const preferred = ['thumbnail.jpg', 'thumbnail.webp', 'thumbnail.png', 'thumbnail.jpeg'];
  for (const name of preferred) {
    const match = entries.find((entry) => entry.name === name);
    if (match) {
      return match;
    }
  }
  return entries.find((entry) => (
    entry.name.startsWith('thumbnail.')
    || entry.name.endsWith('.jpg')
    || entry.name.endsWith('.jpeg')
    || entry.name.endsWith('.png')
    || entry.name.endsWith('.webp')
  ));
}

function resolveThumbnailReference(
  value: unknown,
  entries: VideoDirectoryEntry[],
  fromDonor = false,
): ThumbnailResolution {
  const trimmed = trimString(value);
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith('nhash1')) {
    return { nhash: trimmed, fromDonor };
  }
  const leaf = trimmed.split('/').filter(Boolean).at(-1);
  if (!leaf) {
    return {};
  }
  const entry = entries.find((candidate) => candidate.name === leaf);
  if (!entry) {
    return {};
  }
  return {
    nhash: nhashEncode(entry.cid),
    entry,
    fromDonor,
  };
}

function readMetaString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function readMetaNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = toFiniteNumber(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function readMetaOriginalDate(...values: unknown[]): string | number | undefined {
  for (const value of values) {
    const parsed = readOriginalDate(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

async function readJsonSidecar(
  tree: VideoMigrationTree,
  entries: VideoDirectoryEntry[],
  name: string,
): Promise<Record<string, unknown> | null> {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) {
    return null;
  }
  try {
    const data = await tree.readFile(entry.cid);
    if (!data) {
      return null;
    }
    const parsed = JSON.parse(new TextDecoder().decode(data));
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function readTextSidecar(
  tree: VideoMigrationTree,
  entries: VideoDirectoryEntry[],
  name: string,
): Promise<string | null> {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) {
    return null;
  }
  try {
    const data = await tree.readFile(entry.cid);
    return data ? trimString(new TextDecoder().decode(data)) : null;
  } catch {
    return null;
  }
}

async function readDirectorySidecars(
  tree: VideoMigrationTree,
  entries: VideoDirectoryEntry[],
): Promise<DirectorySidecars> {
  const [metadataJson, infoJson, titleText, descriptionText] = await Promise.all([
    readJsonSidecar(tree, entries, 'metadata.json'),
    readJsonSidecar(tree, entries, 'info.json'),
    readTextSidecar(tree, entries, 'title.txt'),
    readTextSidecar(tree, entries, 'description.txt'),
  ]);

  const legacyFiles = [
    metadataJson ? 'metadata.json' : null,
    infoJson ? 'info.json' : null,
    titleText ? 'title.txt' : null,
    descriptionText ? 'description.txt' : null,
  ].filter((value): value is string => !!value);

  return {
    metadataJson,
    infoJson,
    titleText,
    descriptionText,
    legacyFiles,
  };
}

function buildNormalizedMeta(options: BuildNormalizedMetaOptions): NormalizedMetaResult {
  const primaryMeta = cloneMeta(options.primaryMeta);
  const fallbackMeta = cloneMeta(options.fallbackMeta);
  const donorMeta = cloneMeta(options.donorMeta);
  const donorFallbackMeta = cloneMeta(options.donorFallbackMeta);
  const nextMeta = { ...primaryMeta };
  const issueCodes = new Set<VideoRepairIssueCode>();
  const unresolvedIssueCodes = new Set<VideoRepairIssueCode>();

  const nextTitle = readMetaString(
    primaryMeta.title,
    fallbackMeta.title,
    options.sidecars.metadataJson?.title,
    options.sidecars.infoJson?.title,
    options.sidecars.titleText,
    donorMeta.title,
    donorFallbackMeta.title,
    options.donorSidecars?.metadataJson?.title,
    options.donorSidecars?.infoJson?.title,
    options.donorSidecars?.titleText,
    options.fallbackTitle,
  );
  if (nextTitle) {
    nextMeta.title = nextTitle;
    if (!trimString(primaryMeta.title)) {
      issueCodes.add('missing-title');
    }
  }

  const nextDescription = readMetaString(
    primaryMeta.description,
    fallbackMeta.description,
    options.sidecars.metadataJson?.description,
    options.sidecars.infoJson?.description,
    options.sidecars.descriptionText,
    donorMeta.description,
    donorFallbackMeta.description,
    options.donorSidecars?.metadataJson?.description,
    options.donorSidecars?.infoJson?.description,
    options.donorSidecars?.descriptionText,
  );
  if (nextDescription) {
    nextMeta.description = nextDescription;
    if (!trimString(primaryMeta.description)) {
      issueCodes.add('missing-description');
    }
  }

  const nextDuration = readMetaNumber(
    primaryMeta.duration,
    fallbackMeta.duration,
    options.sidecars.metadataJson?.duration,
    options.sidecars.infoJson?.duration,
    donorMeta.duration,
    donorFallbackMeta.duration,
    options.donorSidecars?.metadataJson?.duration,
    options.donorSidecars?.infoJson?.duration,
  );
  if (nextDuration !== undefined) {
    nextMeta.duration = nextDuration;
    if (toFiniteNumber(primaryMeta.duration) === undefined) {
      issueCodes.add('missing-duration');
    }
  }

  const nextCreatedAt = readMetaNumber(
    primaryMeta.createdAt,
    fallbackMeta.createdAt,
    options.sidecars.metadataJson?.createdAt,
    donorMeta.createdAt,
    donorFallbackMeta.createdAt,
    options.donorSidecars?.metadataJson?.createdAt,
    options.fallbackCreatedAt,
  );
  if (nextCreatedAt !== undefined) {
    nextMeta.createdAt = nextCreatedAt;
  }

  const nextOriginalDate = readMetaOriginalDate(
    primaryMeta.originalDate,
    fallbackMeta.originalDate,
    options.sidecars.metadataJson?.originalDate,
    options.sidecars.infoJson?.upload_date,
    donorMeta.originalDate,
    donorFallbackMeta.originalDate,
    options.donorSidecars?.metadataJson?.originalDate,
    options.donorSidecars?.infoJson?.upload_date,
  );
  if (nextOriginalDate !== undefined) {
    nextMeta.originalDate = nextOriginalDate;
  }

  const baseThumbnailEntry = findThumbnailEntry(options.baseEntries);
  const donorThumbnailEntry = options.donorEntries ? findThumbnailEntry(options.donorEntries) : undefined;
  const thumbnailResolution = (
    resolveThumbnailReference(primaryMeta.thumbnail, options.baseEntries)
    || resolveThumbnailReference(fallbackMeta.thumbnail, options.baseEntries)
    || resolveThumbnailReference(options.sidecars.metadataJson?.thumbnail, options.baseEntries)
    || resolveThumbnailReference(options.sidecars.infoJson?.thumbnail, options.baseEntries)
  );
  const exactBaseThumbnail = baseThumbnailEntry
    ? { nhash: nhashEncode(baseThumbnailEntry.cid), entry: baseThumbnailEntry, fromDonor: false }
    : null;
  const donorThumbnailResolution = (
    resolveThumbnailReference(donorMeta.thumbnail, options.donorEntries ?? [], true)
    || resolveThumbnailReference(donorFallbackMeta.thumbnail, options.donorEntries ?? [], true)
    || resolveThumbnailReference(options.donorSidecars?.metadataJson?.thumbnail, options.donorEntries ?? [], true)
    || resolveThumbnailReference(options.donorSidecars?.infoJson?.thumbnail, options.donorEntries ?? [], true)
  );
  const exactDonorThumbnail = donorThumbnailEntry
    ? { nhash: nhashEncode(donorThumbnailEntry.cid), entry: donorThumbnailEntry, fromDonor: true }
    : null;

  const chosenThumbnail = (
    thumbnailResolution.nhash ? thumbnailResolution
      : exactBaseThumbnail?.nhash ? exactBaseThumbnail
        : donorThumbnailResolution?.nhash ? donorThumbnailResolution
          : exactDonorThumbnail?.nhash ? exactDonorThumbnail
            : null
  );

  const nextThumbnail = trimString(nextMeta.thumbnail);
  if (chosenThumbnail?.nhash) {
    if (nextThumbnail !== chosenThumbnail.nhash) {
      nextMeta.thumbnail = chosenThumbnail.nhash;
      issueCodes.add('missing-thumbnail');
    }
  } else if (!nextThumbnail?.startsWith('nhash1')) {
    unresolvedIssueCodes.add('missing-thumbnail');
  }

  const thumbnailEntryToEnsure = !baseThumbnailEntry && chosenThumbnail?.fromDonor && chosenThumbnail.entry
    ? chosenThumbnail.entry
    : undefined;
  if (thumbnailEntryToEnsure) {
    issueCodes.add('historical-thumbnail');
  }

  const legacyMetadataFound = options.sidecars.legacyFiles.length > 0 || !!options.donorSidecars?.legacyFiles.length;
  if (legacyMetadataFound) {
    issueCodes.add('legacy-metadata');
  }

  const usedDonorMetadata = !!(
    options.donorSidecars?.legacyFiles.length
    || (chosenThumbnail?.fromDonor && chosenThumbnail.nhash)
    || (!trimString(primaryMeta.title) && (trimString(donorMeta.title) || trimString(donorFallbackMeta.title)))
  );

  return {
    nextMeta,
    issueCodes,
    unresolvedIssueCodes,
    legacyMetadataFound,
    usedDonorMetadata,
    thumbnailEntryToEnsure,
  };
}

function dedupeSummary(lines: string[]): string[] {
  return Array.from(new Set(lines));
}

function mergeIssueCodes(...groups: Array<Iterable<VideoRepairIssueCode>>): VideoRepairIssueCode[] {
  const merged = new Set<VideoRepairIssueCode>();
  for (const group of groups) {
    for (const item of group) {
      merged.add(item);
    }
  }
  return Array.from(merged);
}

export async function analyzeVideoDirectoryRepair(
  tree: VideoMigrationTree,
  options: {
    treeName: string;
    baseRootCid: CID;
    thumbnailDonorRootCid?: CID | null;
    fallbackCreatedAt?: number;
  },
): Promise<VideoDirectoryRepairAnalysis> {
  const baseEntries = await tree.listDirectory(options.baseRootCid);
  if (!baseEntries || baseEntries.length === 0) {
    return {
      kind: 'single',
      issueCodes: ['missing-playable-media'],
      unresolvedIssueCodes: ['missing-playable-media'],
      summary: ['The selected root could not be listed or has no entries.'],
      plan: null,
    };
  }

  const donorEntries = options.thumbnailDonorRootCid && !sameHash(options.thumbnailDonorRootCid, options.baseRootCid)
    ? await tree.listDirectory(options.thumbnailDonorRootCid).catch(() => null)
    : null;

  const singleVideoEntry = findPlayableMediaEntry(baseEntries);
  if (singleVideoEntry) {
    const sidecars = await readDirectorySidecars(tree, baseEntries);
    const donorSidecars = donorEntries ? await readDirectorySidecars(tree, donorEntries) : null;
    const donorVideoEntry = donorEntries ? findPlayableMediaEntry(donorEntries) : undefined;
    const normalized = buildNormalizedMeta({
      primaryMeta: singleVideoEntry.meta,
      sidecars,
      donorMeta: donorVideoEntry?.meta,
      donorSidecars,
      baseEntries,
      donorEntries,
      fallbackTitle: getVideoDisplayName(options.treeName),
      fallbackCreatedAt: options.fallbackCreatedAt,
    });

    const summary = [];
    if (normalized.legacyMetadataFound) {
      summary.push('Promote legacy sidecar metadata into the video entry.');
    }
    if (normalized.thumbnailEntryToEnsure || trimString(normalized.nextMeta.thumbnail)?.startsWith('nhash1')) {
      summary.push('Normalize thumbnail metadata for the video root.');
    }
    if (normalized.usedDonorMetadata) {
      summary.push('Use recoverable historical data where the current root is incomplete.');
    }

    const plan = (!metaEquals(singleVideoEntry.meta, normalized.nextMeta) || normalized.thumbnailEntryToEnsure)
      ? {
          kind: 'single' as const,
          baseRootCid: options.baseRootCid,
          videoEntry: singleVideoEntry,
          nextVideoMeta: normalized.nextMeta,
          thumbnailEntryToEnsure: normalized.thumbnailEntryToEnsure,
          issueCodes: Array.from(normalized.issueCodes),
          summary: dedupeSummary(summary),
        }
      : null;

    return {
      kind: 'single',
      issueCodes: plan?.issueCodes ?? mergeIssueCodes(normalized.issueCodes, normalized.unresolvedIssueCodes),
      unresolvedIssueCodes: Array.from(normalized.unresolvedIssueCodes),
      summary: dedupeSummary(summary),
      plan,
    };
  }

  const childPlans: PlaylistChildRepairPlan[] = [];
  const issueCodes = new Set<VideoRepairIssueCode>();
  const unresolvedIssueCodes = new Set<VideoRepairIssueCode>();
  const summary: string[] = [];
  const donorEntryByName = new Map((donorEntries ?? []).map((entry) => [entry.name, entry]));
  let sawPlayableChild = false;

  for (const entry of baseEntries) {
    if (!entry.cid) {
      continue;
    }
    const childEntries = await tree.listDirectory(entry.cid).catch(() => null);
    if (!childEntries || childEntries.length === 0) {
      continue;
    }
    const childVideoEntry = findPlayableMediaEntry(childEntries);
    if (!childVideoEntry) {
      continue;
    }
    sawPlayableChild = true;

    const donorParentEntry = donorEntryByName.get(entry.name);
    const donorChildEntries = donorParentEntry?.cid
      ? await tree.listDirectory(donorParentEntry.cid).catch(() => null)
      : null;
    const donorChildVideoEntry = donorChildEntries ? findPlayableMediaEntry(donorChildEntries) : undefined;
    const childSidecars = await readDirectorySidecars(tree, childEntries);
    const donorChildSidecars = donorChildEntries ? await readDirectorySidecars(tree, donorChildEntries) : null;
    const normalized = buildNormalizedMeta({
      primaryMeta: entry.meta,
      fallbackMeta: childVideoEntry.meta,
      sidecars: childSidecars,
      donorMeta: donorParentEntry?.meta,
      donorFallbackMeta: donorChildVideoEntry?.meta,
      donorSidecars: donorChildSidecars,
      baseEntries: childEntries,
      donorEntries: donorChildEntries,
      fallbackTitle: entry.name,
      fallbackCreatedAt: options.fallbackCreatedAt,
    });

    const nextParentMeta = normalized.nextMeta;
    const nextVideoMeta = {
      ...(childVideoEntry.meta ?? {}),
      title: nextParentMeta.title,
      ...(nextParentMeta.description ? { description: nextParentMeta.description } : {}),
      ...(typeof nextParentMeta.duration === 'number' ? { duration: nextParentMeta.duration } : {}),
      ...(typeof nextParentMeta.createdAt === 'number' ? { createdAt: nextParentMeta.createdAt } : {}),
      ...(nextParentMeta.originalDate !== undefined ? { originalDate: nextParentMeta.originalDate } : {}),
      ...(trimString(nextParentMeta.thumbnail) ? { thumbnail: nextParentMeta.thumbnail } : {}),
    };

    const childChanged = !metaEquals(childVideoEntry.meta, nextVideoMeta);
    const parentChanged = !metaEquals(entry.meta, nextParentMeta);

    if (parentChanged || childChanged || normalized.thumbnailEntryToEnsure) {
      issueCodes.add('playlist-metadata');
      for (const code of normalized.issueCodes) {
        issueCodes.add(code);
      }
      childPlans.push({
        childName: entry.name,
        baseParentEntry: entry,
        videoEntry: childVideoEntry,
        nextParentMeta,
        nextVideoMeta,
        thumbnailEntryToEnsure: normalized.thumbnailEntryToEnsure,
        issueCodes: mergeIssueCodes(normalized.issueCodes),
      });
      if (childSidecars.legacyFiles.length || donorChildSidecars?.legacyFiles.length) {
        summary.push(`Promote sidecar metadata for playlist item "${entry.name}".`);
      }
      if (normalized.thumbnailEntryToEnsure || trimString(nextParentMeta.thumbnail)?.startsWith('nhash1')) {
        summary.push(`Normalize thumbnail metadata for playlist item "${entry.name}".`);
      }
    } else {
      for (const code of normalized.unresolvedIssueCodes) {
        unresolvedIssueCodes.add(code);
      }
    }
  }

  if (!sawPlayableChild) {
    return {
      kind: 'playlist',
      issueCodes: ['missing-playable-media'],
      unresolvedIssueCodes: ['missing-playable-media'],
      summary: ['No playable media files were found in the playlist root.'],
      plan: null,
    };
  }

  return {
    kind: 'playlist',
    issueCodes: childPlans.length > 0 ? Array.from(issueCodes) : Array.from(unresolvedIssueCodes),
    unresolvedIssueCodes: Array.from(unresolvedIssueCodes),
    summary: dedupeSummary(summary),
    plan: childPlans.length > 0
      ? {
          kind: 'playlist',
          baseRootCid: options.baseRootCid,
          childPlans,
          issueCodes: Array.from(issueCodes),
          summary: dedupeSummary(summary),
        }
      : null,
  };
}

export async function applyVideoDirectoryRepair(
  tree: VideoMigrationTree,
  plan: VideoDirectoryRepairPlan,
): Promise<CID> {
  if (plan.kind === 'single') {
    let nextRootCid = plan.baseRootCid;
    if (plan.thumbnailEntryToEnsure) {
      nextRootCid = await tree.setEntry(
        nextRootCid,
        [],
        plan.thumbnailEntryToEnsure.name,
        plan.thumbnailEntryToEnsure.cid,
        plan.thumbnailEntryToEnsure.size,
        plan.thumbnailEntryToEnsure.type,
        plan.thumbnailEntryToEnsure.meta,
      );
    }
    return await tree.setEntry(
      nextRootCid,
      [],
      plan.videoEntry.name,
      plan.videoEntry.cid,
      plan.videoEntry.size,
      plan.videoEntry.type,
      plan.nextVideoMeta,
    );
  }

  let nextRootCid = plan.baseRootCid;
  for (const childPlan of plan.childPlans) {
    let nextChildCid = childPlan.baseParentEntry.cid;
    if (childPlan.thumbnailEntryToEnsure) {
      nextChildCid = await tree.setEntry(
        nextChildCid,
        [],
        childPlan.thumbnailEntryToEnsure.name,
        childPlan.thumbnailEntryToEnsure.cid,
        childPlan.thumbnailEntryToEnsure.size,
        childPlan.thumbnailEntryToEnsure.type,
        childPlan.thumbnailEntryToEnsure.meta,
      );
    }

    nextChildCid = await tree.setEntry(
      nextChildCid,
      [],
      childPlan.videoEntry.name,
      childPlan.videoEntry.cid,
      childPlan.videoEntry.size,
      childPlan.videoEntry.type,
      childPlan.nextVideoMeta,
    );

    const nextChildEntries = await tree.listDirectory(nextChildCid);
    const nextChildSize = nextChildEntries?.reduce((sum, entry) => sum + entry.size, 0) ?? childPlan.baseParentEntry.size;
    nextRootCid = await tree.setEntry(
      nextRootCid,
      [],
      childPlan.baseParentEntry.name,
      nextChildCid,
      nextChildSize,
      childPlan.baseParentEntry.type,
      childPlan.nextParentMeta,
    );
  }
  return nextRootCid;
}

async function listVideoTreeEntries(npub: string): Promise<ResolverListEntryLike[]> {
  return new Promise((resolve) => {
    const resolver = getRefResolver();
    if (!resolver.list) {
      resolve([]);
      return;
    }

    let lastEntries: ResolverListEntryLike[] = [];
    let lastUpdateAt = Date.now();
    let finished = false;
    let stableTimer: ReturnType<typeof setInterval> | null = null;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (stableTimer) {
        clearInterval(stableTimer);
      }
      unsubscribe?.();
      resolve(
        lastEntries
          .filter((entry) => entry.key.startsWith(`${npub}/${VIDEO_TREE_PREFIX}`))
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
      );
    };

    const unsubscribe = resolver.list(npub, (entries) => {
      lastEntries = entries as ResolverListEntryLike[];
      lastUpdateAt = Date.now();
    });

    stableTimer = setInterval(() => {
      if (Date.now() - lastUpdateAt >= LIST_STABLE_WINDOW_MS) {
        finish();
      }
    }, 200);

    setTimeout(finish, LIST_MAX_WAIT_MS);
  });
}

function candidateStatusFromParts(parts: {
  issueCodes: VideoRepairIssueCode[];
  unresolvedIssueCodes: VideoRepairIssueCode[];
  plan: VideoDirectoryRepairPlan | null;
  currentRootWasReplaced: boolean;
  publishBlockedReason?: string;
  error?: string;
}): VideoMigrationCandidate['status'] {
  if (parts.error) {
    return 'error';
  }
  if (parts.publishBlockedReason) {
    return 'unfixable';
  }
  if (parts.plan || parts.currentRootWasReplaced) {
    return 'ready';
  }
  if (parts.issueCodes.length > 0 || parts.unresolvedIssueCodes.length > 0) {
    return 'unfixable';
  }
  return 'clean';
}

export async function scanVideoMigrations(options: {
  npub?: string | null;
  onProgress?: (progress: VideoMigrationScanProgress) => void;
} = {}): Promise<VideoMigrationCandidate[]> {
  const state = nostrStore.getState();
  const targetNpub = options.npub ?? state.npub;
  if (!targetNpub) {
    throw new Error('No target npub available');
  }

  await waitForRelayConnection(5000).catch(() => false);
  options.onProgress?.({ stage: 'list', current: 0, total: 0 });
  const treeEntries = await listVideoTreeEntries(targetNpub);
  const tree = getTree() as unknown as VideoMigrationTree;
  const results: VideoMigrationCandidate[] = [];

  for (const [index, entry] of treeEntries.entries()) {
    const treeName = entry.key.slice(targetNpub.length + 1);
    options.onProgress?.({
      stage: 'inspect',
      current: index + 1,
      total: treeEntries.length,
      treeName,
    });

    try {
      if (
        targetNpub === state.npub
        && entry.visibility === 'link-visible'
        && entry.selfEncryptedLinkKey
      ) {
        await recoverLinkKeyFromSelfEncrypted(targetNpub, treeName, entry.selfEncryptedLinkKey).catch(() => null);
      }

      const resolvedRootCid = getTreeRootSync(targetNpub, treeName)
        ?? await waitForTreeRoot(targetNpub, treeName, 12000)
        ?? entry.cid;
      const publishBaseRootCid = await resolveReadableVideoRoot({
        rootCid: resolvedRootCid,
        npub: targetNpub,
        treeName,
        priority: 'foreground',
      }) ?? resolvedRootCid;
      const thumbnailSourceRootCid = await resolveReadableThumbnailRoot({
        rootCid: publishBaseRootCid,
        npub: targetNpub,
        treeName,
        priority: 'foreground',
      }) ?? publishBaseRootCid;

      const analysis = await analyzeVideoDirectoryRepair(tree, {
        treeName,
        baseRootCid: publishBaseRootCid,
        thumbnailDonorRootCid: sameHash(thumbnailSourceRootCid, publishBaseRootCid) ? null : thumbnailSourceRootCid,
        fallbackCreatedAt: entry.createdAt,
      });

      const issueCodes = new Set<VideoRepairIssueCode>(analysis.issueCodes);
      const unresolvedIssueCodes = new Set<VideoRepairIssueCode>(analysis.unresolvedIssueCodes);
      const summary = [...analysis.summary];
      const currentRootWasReplaced = !sameHash(resolvedRootCid, publishBaseRootCid);
      if (currentRootWasReplaced) {
        issueCodes.add('historical-root');
        summary.unshift('Republish a healthier historical root because the current root no longer resolves cleanly.');
      }
      if (!sameHash(thumbnailSourceRootCid, publishBaseRootCid)) {
        issueCodes.add('historical-thumbnail');
        summary.push('Use a historical thumbnail source to repair the current root.');
      }

      let publishBlockedReason: string | undefined;
      if (
        entry.visibility === 'link-visible'
        && targetNpub === state.npub
      ) {
        await waitForLinkKeysCache();
        if (!getLinkKey(targetNpub, treeName)) {
          issueCodes.add('link-key-unavailable');
          publishBlockedReason = 'Missing link key for this link-visible tree. Open the tree once with its share key before migrating it.';
        }
      }

      results.push({
        npub: targetNpub,
        treeName,
        displayName: getVideoDisplayName(treeName),
        visibility: entry.visibility ?? 'public',
        createdAt: entry.createdAt,
        currentRootCid: resolvedRootCid,
        publishBaseRootCid,
        thumbnailSourceRootCid,
        issueCodes: Array.from(issueCodes),
        unresolvedIssueCodes: Array.from(unresolvedIssueCodes),
        summary: dedupeSummary(summary),
        plan: analysis.plan,
        currentRootWasReplaced,
        publishBlockedReason,
        status: candidateStatusFromParts({
          issueCodes: Array.from(issueCodes),
          unresolvedIssueCodes: Array.from(unresolvedIssueCodes),
          plan: analysis.plan,
          currentRootWasReplaced,
          publishBlockedReason,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown scan error';
      results.push({
        npub: targetNpub,
        treeName,
        displayName: getVideoDisplayName(treeName),
        visibility: entry.visibility ?? 'public',
        createdAt: entry.createdAt,
        currentRootCid: entry.cid,
        publishBaseRootCid: entry.cid,
        issueCodes: [],
        unresolvedIssueCodes: [],
        summary: [],
        plan: null,
        currentRootWasReplaced: false,
        error: message,
        status: 'error',
      });
    }
  }

  return results;
}

export async function publishVideoMigration(candidate: VideoMigrationCandidate): Promise<PublishedVideoMigrationResult> {
  const state = nostrStore.getState();
  if (!state.npub || state.npub !== candidate.npub) {
    throw new Error('Log in as the target account before publishing migrations');
  }
  if (candidate.publishBlockedReason) {
    throw new Error(candidate.publishBlockedReason);
  }

  const tree = getTree() as unknown as VideoMigrationTree;
  let nextRootCid = candidate.publishBaseRootCid;
  if (candidate.plan) {
    nextRootCid = await applyVideoDirectoryRepair(tree, candidate.plan);
  }

  const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(10000);
  const blossom = adapter
    ? await adapter.pushToBlossom(nextRootCid.hash, nextRootCid.key, candidate.treeName).catch(() => undefined)
    : undefined;

  let linkKey: string | undefined;
  if (candidate.visibility === 'link-visible') {
    await waitForLinkKeysCache();
    linkKey = getLinkKey(candidate.npub, candidate.treeName) ?? undefined;
    if (!linkKey) {
      throw new Error('Missing link key for link-visible publish');
    }
  }

  const result = await saveHashtree(candidate.treeName, nextRootCid, {
    visibility: candidate.visibility,
    ...(linkKey ? { linkKey } : {}),
  });
  if (!result.success) {
    throw new Error('Failed to publish migrated tree root');
  }
  if (result.linkKey) {
    await storeLinkKey(candidate.npub, candidate.treeName, result.linkKey);
  }

  return {
    cid: nextRootCid,
    visibility: candidate.visibility,
    blossom,
  };
}
