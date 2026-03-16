import { decode, encode } from '@msgpack/msgpack';
import { HashTree, LinkType, type CID, type Store, toHex, sha256 } from '@hashtree/core';
import { BTree } from '@hashtree/index';

const EVENT_ENVELOPE_VERSION = 1;
const MAX_U64 = (1n << 64n) - 1n;
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;
const MANIFEST_BY_ID = 'by-id';
const MANIFEST_BY_AUTHOR_TIME = 'by-author-time';
const MANIFEST_BY_AUTHOR_KIND_TIME = 'by-author-kind-time';
const MANIFEST_REPLACEABLE = 'replaceable';
const MANIFEST_PARAMETERIZED_REPLACEABLE = 'parameterized-replaceable';

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
  replaceable: CID | null;
  parameterizedReplaceable: CID | null;
}

export interface ListEventsOptions {
  limit?: number;
}

function canonicalEventIdPayload(event: Omit<StoredNostrEvent, 'id' | 'sig'>): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

async function computeCanonicalEventId(event: Omit<StoredNostrEvent, 'sig'>): Promise<string> {
  const payload = canonicalEventIdPayload(event);
  return toHex(await sha256(new TextEncoder().encode(payload)));
}

function padKind(kind: number): string {
  return kind.toString(16).padStart(8, '0');
}

function reverseTimestamp(createdAt: number): string {
  return (MAX_U64 - BigInt(createdAt)).toString(16).padStart(16, '0');
}

function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000);
}

function isParameterizedReplaceableKind(kind: number): boolean {
  return kind >= 30_000 && kind < 40_000;
}

function getDTag(event: StoredNostrEvent): string | null {
  for (const tag of event.tags) {
    if (tag[0] === 'd' && typeof tag[1] === 'string' && tag[1].length > 0) {
      return tag[1];
    }
  }

  return null;
}

function compareEvents(a: StoredNostrEvent, b: StoredNostrEvent): number {
  if (a.created_at !== b.created_at) {
    return a.created_at - b.created_at;
  }

  return a.id.localeCompare(b.id);
}

function assertStringArray(tags: unknown): asserts tags is string[][] {
  if (!Array.isArray(tags)) {
    throw new Error('Nostr event tags must be an array');
  }

  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.some(value => typeof value !== 'string')) {
      throw new Error('Nostr event tags must be an array of string arrays');
    }
  }
}

export class NostrEventStore {
  private readonly tree: HashTree;
  private readonly index: BTree;

  constructor(store: Store) {
    this.tree = new HashTree({ store });
    this.index = new BTree(store);
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
    const eventBytes = this.encodeEvent(normalized);
    const { cid: eventCid } = await this.tree.putFile(eventBytes);

    const nextManifest: NostrEventManifest = {
      byId: await this.index.insertLink(manifest.byId, normalized.id, eventCid),
      byAuthorTime: await this.index.insertLink(
        manifest.byAuthorTime,
        this.authorTimeKey(normalized),
        eventCid
      ),
      byAuthorKindTime: await this.index.insertLink(
        manifest.byAuthorKindTime,
        this.authorKindTimeKey(normalized),
        eventCid
      ),
      replaceable: manifest.replaceable,
      parameterizedReplaceable: manifest.parameterizedReplaceable,
    };

    if (isReplaceableKind(normalized.kind)) {
      nextManifest.replaceable = await this.upsertWinner(
        manifest.replaceable,
        this.replaceableKey(normalized.pubkey, normalized.kind),
        normalized,
        eventCid
      );
    }

    if (isParameterizedReplaceableKind(normalized.kind)) {
      const dTag = getDTag(normalized);
      if (dTag) {
        nextManifest.parameterizedReplaceable = await this.upsertWinner(
          manifest.parameterizedReplaceable,
          this.parameterizedReplaceableKey(normalized.pubkey, normalized.kind, dTag),
          normalized,
          eventCid
        );
      }
    }

    const manifestRoot = await this.writeManifest(nextManifest);
    if (!manifestRoot) {
      throw new Error('Failed to create Nostr event manifest');
    }

    return manifestRoot;
  }

  async build(root: CID | null, events: StoredNostrEvent[]): Promise<CID | null> {
    const normalized = await Promise.all(events.map(event => this.validateEvent(event)));
    normalized.sort(compareEvents);

    let current = root;
    for (const event of normalized) {
      current = await this.add(current, event);
    }

    return current;
  }

  async getById(root: CID | null, eventId: string): Promise<StoredNostrEvent | null> {
    if (!HEX_64.test(eventId)) {
      throw new Error('Event id must be a lowercase 64-character hex string');
    }

    const manifest = await this.getManifest(root);
    if (!manifest.byId) {
      return null;
    }

    const eventCid = await this.index.getLink(manifest.byId, eventId);
    if (!eventCid) {
      return null;
    }

    return this.readStoredEvent(eventCid);
  }

  async listByAuthor(root: CID | null, pubkey: string, options: ListEventsOptions = {}): Promise<StoredNostrEvent[]> {
    const manifest = await this.getManifest(root);
    if (!manifest.byAuthorTime) {
      return [];
    }

    return this.collectEvents(manifest.byAuthorTime, `${this.validateHex64(pubkey, 'pubkey')}:`, options.limit);
  }

  async listByAuthorAndKind(
    root: CID | null,
    pubkey: string,
    kind: number,
    options: ListEventsOptions = {}
  ): Promise<StoredNostrEvent[]> {
    const manifest = await this.getManifest(root);
    if (!manifest.byAuthorKindTime) {
      return [];
    }

    return this.collectEvents(
      manifest.byAuthorKindTime,
      `${this.validateHex64(pubkey, 'pubkey')}:${padKind(this.validateKind(kind))}:`,
      options.limit
    );
  }

  async getReplaceable(root: CID | null, pubkey: string, kind: number): Promise<StoredNostrEvent | null> {
    const manifest = await this.getManifest(root);
    if (!manifest.replaceable) {
      return null;
    }

    const eventCid = await this.index.getLink(
      manifest.replaceable,
      this.replaceableKey(this.validateHex64(pubkey, 'pubkey'), this.validateKind(kind))
    );

    return eventCid ? this.readStoredEvent(eventCid) : null;
  }

  async getParameterizedReplaceable(
    root: CID | null,
    pubkey: string,
    kind: number,
    dTag: string
  ): Promise<StoredNostrEvent | null> {
    const manifest = await this.getManifest(root);
    if (!manifest.parameterizedReplaceable) {
      return null;
    }

    if (dTag.length === 0) {
      throw new Error('Parameterized replaceable events require a non-empty d tag');
    }

    const eventCid = await this.index.getLink(
      manifest.parameterizedReplaceable,
      this.parameterizedReplaceableKey(
        this.validateHex64(pubkey, 'pubkey'),
        this.validateKind(kind),
        dTag
      )
    );

    return eventCid ? this.readStoredEvent(eventCid) : null;
  }

  async getManifest(root: CID | null): Promise<NostrEventManifest> {
    if (!root) {
      return {
        byId: null,
        byAuthorTime: null,
        byAuthorKindTime: null,
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
      replaceable: getCid(MANIFEST_REPLACEABLE),
      parameterizedReplaceable: getCid(MANIFEST_PARAMETERIZED_REPLACEABLE),
    };
  }

  private async collectEvents(root: CID, prefix: string, limit?: number): Promise<StoredNostrEvent[]> {
    const events: StoredNostrEvent[] = [];

    for await (const [, eventCid] of this.index.prefixLinks(root, prefix)) {
      events.push(await this.readStoredEvent(eventCid));
      if (limit !== undefined && events.length >= limit) {
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

  private async upsertWinner(
    root: CID | null,
    key: string,
    event: StoredNostrEvent,
    eventCid: CID
  ): Promise<CID> {
    const existingCid = root ? await this.index.getLink(root, key) : null;
    if (!existingCid) {
      return this.index.insertLink(root, key, eventCid);
    }

    const existingEvent = await this.readStoredEvent(existingCid);
    if (compareEvents(event, existingEvent) > 0) {
      return this.index.insertLink(root, key, eventCid);
    }

    return root!;
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

  private authorTimeKey(event: StoredNostrEvent): string {
    return `${event.pubkey}:${reverseTimestamp(event.created_at)}:${event.id}`;
  }

  private authorKindTimeKey(event: StoredNostrEvent): string {
    return `${event.pubkey}:${padKind(event.kind)}:${reverseTimestamp(event.created_at)}:${event.id}`;
  }

  private replaceableKey(pubkey: string, kind: number): string {
    return `${pubkey}:${padKind(kind)}`;
  }

  private parameterizedReplaceableKey(pubkey: string, kind: number, dTag: string): string {
    return `${pubkey}:${padKind(kind)}:${dTag}`;
  }

  private validateEventShape(event: StoredNostrEvent): StoredNostrEvent {
    const normalized = {
      id: this.validateHex64(event.id, 'event id'),
      pubkey: this.validateHex64(event.pubkey, 'pubkey'),
      created_at: this.validateCreatedAt(event.created_at),
      kind: this.validateKind(event.kind),
      tags: event.tags,
      content: this.validateContent(event.content),
      sig: this.validateHex128(event.sig, 'signature'),
    };

    assertStringArray(normalized.tags);
    return normalized;
  }

  private async validateEvent(event: StoredNostrEvent): Promise<StoredNostrEvent> {
    const normalized = this.validateEventShape(event);
    const computedId = await computeCanonicalEventId(normalized);
    if (computedId !== normalized.id) {
      throw new Error(`Event id mismatch: expected ${computedId}, got ${normalized.id}`);
    }

    return normalized;
  }

  private validateHex64(value: string, label: string): string {
    if (!HEX_64.test(value)) {
      throw new Error(`${label} must be a lowercase 64-character hex string`);
    }

    return value;
  }

  private validateHex128(value: string, label: string): string {
    if (!HEX_128.test(value)) {
      throw new Error(`${label} must be a lowercase 128-character hex string`);
    }

    return value;
  }

  private validateCreatedAt(value: number): number {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('created_at must be a non-negative integer');
    }

    return value;
  }

  private validateKind(value: number): number {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('kind must be a non-negative integer');
    }

    return value;
  }

  private validateContent(value: string): string {
    if (typeof value !== 'string') {
      throw new Error('content must be a string');
    }

    return value;
  }
}
