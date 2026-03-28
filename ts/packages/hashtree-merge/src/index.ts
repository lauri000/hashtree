export type PathEntryKind = 'file' | 'directory';

export interface PathMergeEntry<T> {
  path: string;
  kind: PathEntryKind;
  value: T;
}

export interface PathTombstone {
  path: string;
}

export interface PathMergeSource<T> {
  name: string;
  precedence?: number;
  entries: Iterable<PathMergeEntry<T>>;
  tombstones?: Iterable<PathTombstone>;
}

export type HiddenReason = 'shadowed' | 'tombstoned';

export interface HiddenPath {
  path: string;
  kind: PathEntryKind;
  source: string;
  reason: HiddenReason;
  bySource: string;
}

export interface MergedPathEntry<T> {
  path: string;
  kind: PathEntryKind;
  value: T;
  source: string;
}

export interface PathMergeResult<T> {
  entries: MergedPathEntry<T>[];
  hidden: HiddenPath[];
}

export class PathMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathMergeError';
  }
}

export function mergePathSources<T>(sources: Iterable<PathMergeSource<T>>): PathMergeResult<T> {
  const orderedSources = Array.from(sources)
    .map((source, index) => ({
      ...source,
      precedence: source.precedence ?? index,
      index,
    }))
    .sort((left, right) => {
      const precedenceDelta = right.precedence - left.precedence;
      if (precedenceDelta !== 0) return precedenceDelta;
      return right.index - left.index;
    });

  const winners = new Map<string, MergedPathEntry<T>>();
  const tombstones = new Map<string, string>();
  const hidden: HiddenPath[] = [];

  for (const source of orderedSources) {
    const sourceEntries = new Map<string, PathMergeEntry<T>>();
    for (const entry of source.entries) {
      const normalizedPath = normalizePath(entry.path);
      sourceEntries.set(normalizedPath, {
        path: normalizedPath,
        kind: entry.kind,
        value: entry.value,
      });
    }

    const sourceTombstones = new Set<string>();
    for (const tombstone of source.tombstones ?? []) {
      sourceTombstones.add(normalizePath(tombstone.path));
    }

    for (const path of sourceTombstones) {
      if (winners.has(path) || tombstones.has(path)) continue;
      tombstones.set(path, source.name);
    }

    for (const path of sourceTombstones) {
      const entry = sourceEntries.get(path);
      if (!entry) continue;
      hidden.push({
        path,
        kind: entry.kind,
        source: source.name,
        reason: 'tombstoned',
        bySource: source.name,
      });
    }

    for (const [path, entry] of sourceEntries) {
      if (sourceTombstones.has(path)) continue;

      const tombstoneSource = tombstones.get(path);
      if (tombstoneSource) {
        hidden.push({
          path,
          kind: entry.kind,
          source: source.name,
          reason: 'tombstoned',
          bySource: tombstoneSource,
        });
        continue;
      }

      const winner = winners.get(path);
      if (winner) {
        hidden.push({
          path,
          kind: entry.kind,
          source: source.name,
          reason: 'shadowed',
          bySource: winner.source,
        });
        continue;
      }

      winners.set(path, {
        path,
        kind: entry.kind,
        value: entry.value,
        source: source.name,
      });
    }
  }

  return {
    entries: Array.from(winners.values()).sort(compareMergedEntries),
    hidden: hidden.sort(compareHiddenPaths),
  };
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  const normalized = trimmed
    .split('/')
    .filter(segment => segment.length > 0);

  if (normalized.length === 0 || normalized.some(segment => segment === '.' || segment === '..')) {
    throw new PathMergeError(`invalid path: ${path}`);
  }

  return normalized.join('/');
}

function compareMergedEntries<T>(left: MergedPathEntry<T>, right: MergedPathEntry<T>): number {
  return left.path.localeCompare(right.path)
    || left.source.localeCompare(right.source);
}

function compareHiddenPaths(left: HiddenPath, right: HiddenPath): number {
  return left.path.localeCompare(right.path)
    || left.source.localeCompare(right.source)
    || left.bySource.localeCompare(right.bySource);
}
