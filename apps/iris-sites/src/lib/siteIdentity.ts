import { sha256 } from '@noble/hashes/sha2.js';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const MUTABLE_OWNER_HINT_LENGTH = 16;
const MUTABLE_TREE_HINT_LENGTH = 25;
const MUTABLE_VERIFIER_LENGTH = 20;
const textEncoder = new TextEncoder();

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, '');
}

export function encodePathSegments(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function decodeBase32(value: string): Uint8Array | null {
  let bits = 0;
  let current = 0;
  const bytes: number[] = [];

  for (const char of value.trim().toLowerCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

function normalizeTreeHintPart(treeName: string): string {
  const slug = treeName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hint = (slug || 'site').slice(0, MUTABLE_TREE_HINT_LENGTH).replace(/-+$/g, '');
  return hint || 'site';
}

export function getMutableTreeHint(treeName: string): string {
  return normalizeTreeHintPart(treeName);
}

export function encodeImmutableHostLabel(hash: Uint8Array): string {
  return encodeBase32(hash);
}

export function decodeImmutableHostLabel(label: string): Uint8Array | null {
  const decoded = decodeBase32(label);
  if (!decoded || decoded.length !== 32) return null;
  return decoded;
}

function getMutableOwnerHint(npub: string): string {
  const hint = npub.trim().toLowerCase().slice(0, MUTABLE_OWNER_HINT_LENGTH);
  return /^[a-z0-9]+$/.test(hint) ? hint : 'npub';
}

function getMutableVerifier(npub: string, treeName: string): string {
  const digest = sha256(textEncoder.encode(`mutable-host-v1\0${npub}\0${treeName}`));
  return encodeBase32(digest).slice(0, MUTABLE_VERIFIER_LENGTH);
}

export function encodeMutableHostLabel(npub: string, treeName: string): string {
  return `${getMutableOwnerHint(npub)}-${getMutableTreeHint(treeName)}-${getMutableVerifier(npub, treeName)}`;
}

export function decodeMutableHostLabel(label: string): { ownerHint: string; treeHint: string; verifier: string } | null {
  const match = /^([a-z0-9]{1,16})-([a-z0-9-]{1,25})-([a-z2-7]{20})$/.exec(label);
  if (!match) return null;

  return {
    ownerHint: match[1],
    treeHint: match[2],
    verifier: match[3],
  };
}
