import { decode, encode } from '@msgpack/msgpack';
import { CollectionSource, type CollectionManifest } from '@hashtree/collection';
import { HashTree, LinkType, type CID, type Store, toHex, sha256 } from '@hashtree/core';
import {
  collectionManifestToNostrEventManifest,
  createNostrEventCollectionWriter,
  DEFAULT_NOSTR_EVENT_COLLECTION_SOURCE_ID,
  nostrEventManifestToCollectionManifest,
} from './eventCollection.js';
import {
  compareEvents,
  createdAtFromIndexKey,
  getDTag,
  isParameterizedReplaceableKind,
  isReplaceableKind,
  MANIFEST_BY_AUTHOR_KIND_TIME,
  MANIFEST_BY_AUTHOR_TIME,
  MANIFEST_BY_ID,
  MANIFEST_BY_KIND_TIME,
  MANIFEST_BY_TAG,
  MANIFEST_BY_TIME,
  MANIFEST_PARAMETERIZED_REPLACEABLE,
  MANIFEST_REPLACEABLE,
  parameterizedReplaceableKey,
  replaceableKey,
  retainLatestReplaceableEvents,
  tagPrefix,
} from './eventKeys.js';
import { assertStringArray, validateEventShape, validateHex64, validateKind } from './eventValidation.js';

const EVENT_ENVELOPE_VERSION = 1;

export interface StoredNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrEventManifest {
  byId: CID | null;
  byAuthorTime: CID | null;
  byAuthorKindTime: CID | null;
  byKindTime: CID | null;
  byTime: CID | null;
  byTag: CID | null;
  replaceable: CID | null;
  parameterizedReplaceable: CID | null;
}

export interface ListEventsOptions {
  limit?: number;
  since?: number;
  until?: number;
}

function canonicalEventIdPayload(event: Omit<StoredNostrEvent, 'id' | 'sig'>): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

async function computeCanonicalEventId(event: Omit<StoredNostrEvent, 'sig'>): Promise<string> {
  const payload = canonicalEventIdPayload(event);
  return toHex(await sha256(new TextEncoder().encode(payload)));
}

export class NostrEventStore {
  private readonly store: Store;
  private readonly tree: HashTree;

  constructor(store: Store) {
    this.store = store;
    this.tree = new HashTree({ store });
  }

  encodeEvent(event: StoredNostrEvent): Uint8Array {
    const normalized = this.validateEventShape(event);
    return encode([
      EVENT_ENVELOPE_VERSION,
      normalized.id,
      normalized.pubkey,
      normalized.created_at,
      normalized.kind,
      normalized.tags,
      normalized.content,
      normalized.sig,
    ]);
  }

  decodeEvent(data: Uint8Array): StoredNostrEvent {
    const decoded = decode(data);
    if (!Array.isArray(decoded) || decoded.length !== 8) {
      throw new Error('Invalid Nostr event envelope');
    }

    const [
      version,
      id,
      pubkey,
      createdAt,
      kind,
      tags,
      content,
      sig,
    ] = decoded;

    if (version !== EVENT_ENVELOPE_VERSION) {
      throw new Error(`Unsupported Nostr event envelope version: ${String(version)}`);
    }
    if (typeof id !== 'string' || typeof pubkey !== 'string' || typeof content !== 'string' || typeof sig !== 'string') {
      throw new Error('Invalid Nostr event envelope fields');
    }
    if (typeof createdAt !== 'number' || !Number.isInteger(createdAt) || createdAt < 0) {
      throw new Error('Invalid Nostr event created_at');
    }
    if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0) {
      throw new Error('Invalid Nostr event kind');
    }

    assertStringArray(tags);

    return this.validateEventShape({
      id,
      pubkey,
      created_at: createdAt,
      kind,
      tags,
      content,
      sig,
    });
  }

  async add(root: CID | null, event: StoredNostrEvent): Promise<CID> {
    const normalized = await this.validateEvent(event);
    const manifest = await this.getManifest(root);
    const decision = await this.resolveReplaceableDecision(manifest, normalized);
    if (!decision.accept) {
      if (!root) {
        throw new Error('Rejecting replaceable event without an existing manifest root');
      }
      return root;
    }

    const eventBytes = this.encodeEvent(normalized);
    const { cid: eventCid } = await this.tree.putFile(eventBytes);
    const writer = this.collectionWriterFromManifest(manifest);
    await writer.put(normalized, eventCid, {
      previous: decision.replaced?.event,
    });

    const nextManifest = collectionManifestToNostrEventManifest(writer.manifest());
    const manifestRoot = await this.writeManifest(nextManifest);
    if (!manifestRoot) {
      throw new Error('Failed to create Nostr event manifest');
    }

    if (decision.replaced) {
      await this.store.delete(decision.replaced.cid.hash);
    }

    return manifestRoot;
  }

  async build(root: CID | null, events: StoredNostrEvent[]): Promise<CID | null> {
    const normalized = retainLatestReplaceableEvents(
      await Promise.all(events.map((event) => this.validateEvent(event))),
    );
    normalized.sort(compareEvents);

    if (normalized.length === 0) {
      return root;
    }

    if (root) {
      let current = root;
      for (const event of normalized) {
        current = await this.add(current, event);
      }
      return current;
    }

    const writer = this.collectionWriterFromManifest(this.emptyManifest());
    await writer.rebuild(await Promise.all(normalized.map(async (event) => {
      const { cid } = await this.tree.putFile(this.encodeEvent(event));
      return { item: event, cid };
    })));

    return await this.writeManifest(collectionManifestToNostrEventManifest(writer.manifest()));
  }

  async getById(root: CID | null, eventId: string): Promise<StoredNostrEvent | null> {
    const source = this.collectionSourceFromManifest(await this.getManifest(root));
    const eventCid = await source.get(validateHex64(eventId, 'event id'));
    if (!eventCid) {
      return null;
    }

    return this.readStoredEvent(eventCid);
  }

  async listByAuthor(root: CID | null, pubkey: string, options: ListEventsOptions = {}): Promise<StoredNostrEvent[]> {
    return this.collectEvents(
      this.collectionSourceFromManifest(await this.getManifest(root)),
      MANIFEST_BY_AUTHOR_TIME,
      `${validateHex64(pubkey, 'pubkey')}:`,
      options,
    );
  }

  async listByAuthorAndKind(
    root: CID | null,
    pubkey: string,
    kind: number,
    options: ListEventsOptions = {}
  ): Promise<StoredNostrEvent[]> {
    return this.collectEvents(
      this.collectionSourceFromManifest(await this.getManifest(root)),
      MANIFEST_BY_AUTHOR_KIND_TIME,
      `${validateHex64(pubkey, 'pubkey')}:${validateKind(kind).toString(16).padStart(8, '0')}:`,
      options,
    );
  }

  async getReplaceable(root: CID | null, pubkey: string, kind: number): Promise<StoredNostrEvent | null> {
    const source = this.collectionSourceFromManifest(await this.getManifest(root));
    const eventCid = await source.getIndexLink(
      MANIFEST_REPLACEABLE,
      replaceableKey(validateHex64(pubkey, 'pubkey'), validateKind(kind)),
    );

    return eventCid ? this.readStoredEvent(eventCid) : null;
  }

  async listRecent(root: CID | null, options: ListEventsOptions = {}): Promise<StoredNostrEvent[]> {
    return this.collectEvents(
      this.collectionSourceFromManifest(await this.getManifest(root)),
      MANIFEST_BY_TIME,
      '',
      options,
    );
  }

  async listByTag(
    root: CID | null,
    tagName: string,
    tagValue: string,
    options: ListEventsOptions = {}
  ): Promise<StoredNostrEvent[]> {
    return this.collectEvents(
      this.collectionSourceFromManifest(await this.getManifest(root)),
      MANIFEST_BY_TAG,
      tagPrefix(tagName, tagValue),
      options,
    );
  }

  async getParameterizedReplaceable(
    root: CID | null,
    pubkey: string,
    kind: number,
    dTag: string
  ): Promise<StoredNostrEvent | null> {
    if (dTag.length === 0) {
      throw new Error('Parameterized replaceable events require a non-empty d tag');
    }

    const source = this.collectionSourceFromManifest(await this.getManifest(root));
    const eventCid = await source.getIndexLink(
      MANIFEST_PARAMETERIZED_REPLACEABLE,
      parameterizedReplaceableKey(
        validateHex64(pubkey, 'pubkey'),
        validateKind(kind),
        dTag,
      ),
    );

    return eventCid ? this.readStoredEvent(eventCid) : null;
  }

  async getManifest(root: CID | null): Promise<NostrEventManifest> {
    if (!root) {
      return {
        byId: null,
        byAuthorTime: null,
        byAuthorKindTime: null,
        byKindTime: null,
        byTime: null,
        byTag: null,
        replaceable: null,
        parameterizedReplaceable: null,
      };
    }

    const entries = await this.tree.listDirectory(root);
    const getCid = (name: string): CID | null => entries.find(entry => entry.name === name)?.cid ?? null;

    return {
      byId: getCid(MANIFEST_BY_ID),
      byAuthorTime: getCid(MANIFEST_BY_AUTHOR_TIME),
      byAuthorKindTime: getCid(MANIFEST_BY_AUTHOR_KIND_TIME),
      byKindTime: getCid(MANIFEST_BY_KIND_TIME),
      byTime: getCid(MANIFEST_BY_TIME),
      byTag: getCid(MANIFEST_BY_TAG),
      replaceable: getCid(MANIFEST_REPLACEABLE),
      parameterizedReplaceable: getCid(MANIFEST_PARAMETERIZED_REPLACEABLE),
    };
  }

  async getCollectionManifest(
    root: CID | null,
    sourceId: string = DEFAULT_NOSTR_EVENT_COLLECTION_SOURCE_ID,
  ): Promise<CollectionManifest> {
    const manifest = nostrEventManifestToCollectionManifest(await this.getManifest(root), sourceId);
    const source = new CollectionSource(this.store, manifest);
    return {
      ...manifest,
      itemCount: await source.count(),
    };
  }

  async getCollectionSource(
    root: CID | null,
    sourceId: string = DEFAULT_NOSTR_EVENT_COLLECTION_SOURCE_ID,
  ): Promise<CollectionSource> {
    return new CollectionSource(this.store, await this.getCollectionManifest(root, sourceId));
  }

  async listByKind(
    root: CID | null,
    kind: number,
    options: ListEventsOptions = {}
  ): Promise<StoredNostrEvent[]> {
    return this.collectEvents(
      this.collectionSourceFromManifest(await this.getManifest(root)),
      MANIFEST_BY_KIND_TIME,
      `${validateKind(kind).toString(16).padStart(8, '0')}:`,
      options,
    );
  }

  private async collectEvents(
    source: CollectionSource,
    indexName: string,
    prefix: string,
    options: ListEventsOptions = {},
  ): Promise<StoredNostrEvent[]> {
    const events: StoredNostrEvent[] = [];
    const entries = indexName === MANIFEST_BY_ID
      ? await source.queryById({
        prefix,
        limit: options.limit !== undefined && options.since === undefined && options.until === undefined
          ? options.limit
          : undefined,
      })
      : await source.queryIndex(indexName, {
        prefix,
        limit: options.limit !== undefined && options.since === undefined && options.until === undefined
          ? options.limit
          : undefined,
      });

    for (const { key, cid: eventCid } of entries) {
      const createdAt = createdAtFromIndexKey(key);
      if (options.until !== undefined && createdAt > options.until) {
        continue;
      }
      if (options.since !== undefined && createdAt < options.since) {
        break;
      }
      events.push(await this.readStoredEvent(eventCid));
      if (options.limit !== undefined && events.length >= options.limit) {
        break;
      }
    }

    return events;
  }

  private async readStoredEvent(eventCid: CID): Promise<StoredNostrEvent> {
    const data = await this.tree.readFile(eventCid);
    if (!data) {
      throw new Error('Stored Nostr event blob is missing');
    }

    return this.decodeEvent(data);
  }

  private emptyManifest(): NostrEventManifest {
    return {
      byId: null,
      byAuthorTime: null,
      byAuthorKindTime: null,
      byKindTime: null,
      byTime: null,
      byTag: null,
      replaceable: null,
      parameterizedReplaceable: null,
    };
  }

  private collectionSourceFromManifest(manifest: NostrEventManifest): CollectionSource {
    return new CollectionSource(
      this.store,
      nostrEventManifestToCollectionManifest(manifest),
    );
  }

  private collectionWriterFromManifest(manifest: NostrEventManifest) {
    return createNostrEventCollectionWriter(this.store, manifest);
  }

  private async resolveReplaceableDecision(
    manifest: NostrEventManifest,
    event: StoredNostrEvent,
  ): Promise<{ accept: boolean; replaced?: { event: StoredNostrEvent; cid: CID } }> {
    const slot = isReplaceableKind(event.kind)
      ? {
        indexName: MANIFEST_REPLACEABLE,
        key: replaceableKey(event.pubkey, event.kind),
      }
      : isParameterizedReplaceableKind(event.kind)
        ? {
          indexName: MANIFEST_PARAMETERIZED_REPLACEABLE,
          key: parameterizedReplaceableKey(event.pubkey, event.kind, getDTag(event) ?? ''),
        }
        : null;

    if (!slot) {
      return { accept: true };
    }

    const source = this.collectionSourceFromManifest(manifest);
    const existingCid = await source.getIndexLink(slot.indexName, slot.key);
    if (!existingCid) {
      return { accept: true };
    }

    try {
      const existingEvent = await this.readStoredEvent(existingCid);
      if (compareEvents(event, existingEvent) > 0) {
        return {
          accept: true,
          replaced: {
            event: existingEvent,
            cid: existingCid,
          },
        };
      }
      return { accept: false };
    } catch (error) {
      if (error instanceof Error && error.message === 'Stored Nostr event blob is missing') {
        return { accept: true };
      }
      throw error;
    }
  }

  private async writeManifest(manifest: NostrEventManifest): Promise<CID | null> {
    const entries = [];

    if (manifest.byId) {
      entries.push({ name: MANIFEST_BY_ID, cid: manifest.byId, size: 0, type: LinkType.Dir });
    }
    if (manifest.byAuthorTime) {
      entries.push({ name: MANIFEST_BY_AUTHOR_TIME, cid: manifest.byAuthorTime, size: 0, type: LinkType.Dir });
    }
    if (manifest.byAuthorKindTime) {
      entries.push({ name: MANIFEST_BY_AUTHOR_KIND_TIME, cid: manifest.byAuthorKindTime, size: 0, type: LinkType.Dir });
    }
    if (manifest.byKindTime) {
      entries.push({ name: MANIFEST_BY_KIND_TIME, cid: manifest.byKindTime, size: 0, type: LinkType.Dir });
    }
    if (manifest.byTime) {
      entries.push({ name: MANIFEST_BY_TIME, cid: manifest.byTime, size: 0, type: LinkType.Dir });
    }
    if (manifest.byTag) {
      entries.push({ name: MANIFEST_BY_TAG, cid: manifest.byTag, size: 0, type: LinkType.Dir });
    }
    if (manifest.replaceable) {
      entries.push({ name: MANIFEST_REPLACEABLE, cid: manifest.replaceable, size: 0, type: LinkType.Dir });
    }
    if (manifest.parameterizedReplaceable) {
      entries.push({
        name: MANIFEST_PARAMETERIZED_REPLACEABLE,
        cid: manifest.parameterizedReplaceable,
        size: 0,
        type: LinkType.Dir,
      });
    }

    if (entries.length === 0) {
      return null;
    }

    const { cid } = await this.tree.putDirectory(entries);
    return cid;
  }

  private validateEventShape(event: StoredNostrEvent): StoredNostrEvent {
    return validateEventShape(event);
  }

  private async validateEvent(event: StoredNostrEvent): Promise<StoredNostrEvent> {
    const normalized = this.validateEventShape(event);
    const computedId = await computeCanonicalEventId(normalized);
    if (computedId !== normalized.id) {
      throw new Error(`Event id mismatch: expected ${computedId}, got ${normalized.id}`);
    }

    return normalized;
  }
}
