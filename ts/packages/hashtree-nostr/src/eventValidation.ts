import type { StoredNostrEvent } from './events.js';

export const HEX_64 = /^[0-9a-f]{64}$/;
export const HEX_128 = /^[0-9a-f]{128}$/;

export function assertStringArray(tags: unknown): asserts tags is string[][] {
  if (!Array.isArray(tags)) {
    throw new Error('Nostr event tags must be an array');
  }

  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.some((value) => typeof value !== 'string')) {
      throw new Error('Nostr event tags must be an array of string arrays');
    }
  }
}

export function validateHex64(value: string, label: string): string {
  if (!HEX_64.test(value)) {
    throw new Error(`${label} must be a lowercase 64-character hex string`);
  }

  return value;
}

export function validateHex128(value: string, label: string): string {
  if (!HEX_128.test(value)) {
    throw new Error(`${label} must be a lowercase 128-character hex string`);
  }

  return value;
}

export function validateCreatedAt(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('created_at must be a non-negative integer');
  }

  return value;
}

export function validateKind(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('kind must be a non-negative integer');
  }

  return value;
}

export function validateContent(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('content must be a string');
  }

  return value;
}

export function validateEventShape(event: StoredNostrEvent): StoredNostrEvent {
  const normalized = {
    id: validateHex64(event.id, 'event id'),
    pubkey: validateHex64(event.pubkey, 'pubkey'),
    created_at: validateCreatedAt(event.created_at),
    kind: validateKind(event.kind),
    tags: event.tags,
    content: validateContent(event.content),
    sig: validateHex128(event.sig, 'signature'),
  };

  assertStringArray(normalized.tags);
  return normalized;
}
