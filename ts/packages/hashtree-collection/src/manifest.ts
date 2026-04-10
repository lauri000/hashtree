import type { CollectionDefinition, CollectionManifest, CollectionManifestIndex, CollectionState } from './types.js';
import { deserializeCid, serializeCid } from './cid.js';
import { defaultSearchPrefix } from './helpers.js';
import { getSchemaVersion } from './schema.js';

export function createEmptyCollectionState<T>(definition: CollectionDefinition<T>): CollectionState {
  return {
    byIdRoot: null,
    keyRoots: Object.fromEntries((definition.keyIndexes ?? []).map((index) => [index.name, null])),
    searchRoots: Object.fromEntries((definition.searchIndexes ?? []).map((index) => [index.name, null])),
    itemCount: 0,
    updatedAt: 0,
  };
}

export function collectionStateFromManifest<T>(
  definition: CollectionDefinition<T>,
  manifest: CollectionManifest | null | undefined,
): CollectionState {
  const empty = createEmptyCollectionState(definition);
  if (!manifest) {
    return empty;
  }

  const keyRoots = { ...empty.keyRoots };
  const searchRoots = { ...empty.searchRoots };

  for (const [name, index] of Object.entries(manifest.indexes ?? {})) {
    if (index.kind === 'key' && Object.hasOwn(keyRoots, name)) {
      keyRoots[name] = deserializeCid(index.root);
    }
    if (index.kind === 'search' && Object.hasOwn(searchRoots, name)) {
      searchRoots[name] = deserializeCid(index.root);
    }
  }

  return {
    byIdRoot: deserializeCid(manifest.byIdRoot),
    keyRoots,
    searchRoots,
    itemCount: Math.max(0, Number(manifest.itemCount) || 0),
    updatedAt: Number(manifest.updatedAt) || 0,
  };
}

export function collectionManifestFromState<T>(
  definition: CollectionDefinition<T>,
  state: CollectionState,
  metadata?: Record<string, unknown>,
): CollectionManifest {
  const indexes: Record<string, CollectionManifestIndex> = {};

  for (const definitionIndex of definition.keyIndexes ?? []) {
    indexes[definitionIndex.name] = {
      kind: 'key',
      root: serializeCid(state.keyRoots[definitionIndex.name] ?? null),
    };
  }

  for (const definitionIndex of definition.searchIndexes ?? []) {
    indexes[definitionIndex.name] = {
      kind: 'search',
      root: serializeCid(state.searchRoots[definitionIndex.name] ?? null),
      prefix: definitionIndex.prefix ?? defaultSearchPrefix(definitionIndex.name),
      options: definitionIndex.options,
    };
  }

  return {
    version: 1,
    sourceId: definition.sourceId,
    schemaVersion: getSchemaVersion(definition),
    updatedAt: state.updatedAt,
    itemCount: state.itemCount,
    byIdRoot: serializeCid(state.byIdRoot),
    indexes,
    metadata,
  };
}
