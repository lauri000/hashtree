import { BTree, SearchIndex, type SearchLinkResult } from '@hashtree/index';
import type {
  CID,
  CollectionIndexLinkResult,
  CollectionManifest,
  CollectionSearchManifestIndex,
  SearchOptions,
  Store,
} from './types.js';
import { deserializeCid } from './cid.js';

export class CollectionSource {
  readonly manifest: CollectionManifest;
  private readonly byIdIndex: BTree;
  private readonly linkIndex: BTree;
  private readonly byIdRoot;
  private readonly searchIndexes = new Map<string, SearchIndex>();

  constructor(store: Store, manifest: CollectionManifest) {
    this.manifest = manifest;
    this.byIdIndex = new BTree(store);
    this.linkIndex = new BTree(store);
    this.byIdRoot = deserializeCid(manifest.byIdRoot);

    for (const [name, index] of Object.entries(manifest.indexes ?? {})) {
      if (index.kind === 'search') {
        this.searchIndexes.set(name, new SearchIndex(store, {
          order: index.options?.order,
          minKeywordLength: index.options?.minKeywordLength,
          stopWords: index.options?.stopWords ? new Set(index.options.stopWords) : undefined,
        }));
      }
    }
  }

  async get(id: string): Promise<CID | null> {
    if (!this.byIdRoot) {
      return null;
    }

    return await this.byIdIndex.getLink(this.byIdRoot, id);
  }

  async count(): Promise<number> {
    if (!this.byIdRoot) {
      return 0;
    }

    let count = 0;
    for await (const _entry of this.byIdIndex.linksEntries(this.byIdRoot)) {
      count += 1;
    }
    return count;
  }

  async queryById(options: { prefix?: string; limit?: number } = {}): Promise<CollectionIndexLinkResult[]> {
    if (!this.byIdRoot) {
      return [];
    }

    const results: CollectionIndexLinkResult[] = [];
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const iterator = options.prefix
      ? this.byIdIndex.prefixLinks(this.byIdRoot, options.prefix)
      : this.byIdIndex.linksEntries(this.byIdRoot);

    for await (const [key, cid] of iterator) {
      results.push({ key, cid });
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  async search(indexName: string, query: string, options: SearchOptions = {}): Promise<SearchLinkResult[]> {
    const manifestIndex = this.manifest.indexes[indexName];
    if (!manifestIndex || manifestIndex.kind !== 'search') {
      return [];
    }

    const root = deserializeCid(manifestIndex.root);
    const searchIndex = this.searchIndexes.get(indexName);
    if (!root || !searchIndex) {
      return [];
    }

    return await searchIndex.searchLinks(root, manifestIndex.prefix, query, options);
  }

  async queryIndex(
    indexName: string,
    options: { prefix?: string; limit?: number } = {},
  ): Promise<CollectionIndexLinkResult[]> {
    const manifestIndex = this.manifest.indexes[indexName];
    if (!manifestIndex) {
      return [];
    }

    const root = deserializeCid(manifestIndex.root);
    if (!root) {
      return [];
    }

    const results: CollectionIndexLinkResult[] = [];
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const iterator = options.prefix
      ? this.linkIndex.prefixLinks(root, options.prefix)
      : this.linkIndex.linksEntries(root);

    for await (const [key, cid] of iterator) {
      results.push({ key, cid });
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  getSearchManifestIndex(indexName: string): CollectionSearchManifestIndex | null {
    const manifestIndex = this.manifest.indexes[indexName];
    if (!manifestIndex || manifestIndex.kind !== 'search') {
      return null;
    }

    return manifestIndex;
  }
}
