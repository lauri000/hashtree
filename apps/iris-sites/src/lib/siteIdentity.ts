import { nip19 } from 'nostr-tools';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const MUTABLE_OWNER_LABEL_LENGTH = 50;
const MUTABLE_TREE_HINT_LENGTH = 12;

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

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^(?:[a-f0-9]{2})*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
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

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function bigIntToBytes(value: bigint, byteLength: number): Uint8Array | null {
  if (value < 0n) return null;
  const bytes = new Uint8Array(byteLength);
  let remaining = value;
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return remaining === 0n ? bytes : null;
}

function encodeBase36(bytes: Uint8Array): string {
  let value = bytesToBigInt(bytes);
  if (value === 0n) return '0';

  let output = '';
  while (value > 0n) {
    const remainder = Number(value % 36n);
    output = BASE36_ALPHABET[remainder] + output;
    value /= 36n;
  }
  return output;
}

function decodeBase36(value: string, byteLength: number): Uint8Array | null {
  let decoded = 0n;
  for (const char of value.trim().toLowerCase()) {
    const index = BASE36_ALPHABET.indexOf(char);
    if (index < 0) return null;
    decoded = decoded * 36n + BigInt(index);
  }
  return bigIntToBytes(decoded, byteLength);
}

function getMutableOwnerBytes(npub: string): Uint8Array {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
    throw new Error(`Expected npub, got ${decoded.type}`);
  }

  const ownerBytes = hexToBytes(decoded.data);
  if (!ownerBytes || ownerBytes.length !== 32) {
    throw new Error('Invalid npub payload');
  }
  return ownerBytes;
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

export function encodeMutableHostLabel(npub: string, treeName: string): string {
  const ownerLabel = encodeBase36(getMutableOwnerBytes(npub)).padStart(MUTABLE_OWNER_LABEL_LENGTH, '0');
  return `${ownerLabel}-${getMutableTreeHint(treeName)}`;
}

export function decodeMutableHostLabel(label: string): { npub: string; treeHint: string } | null {
  const match = /^([0-9a-z]{50})-([a-z0-9-]{1,12})$/.exec(label);
  if (!match) return null;

  const ownerBytes = decodeBase36(match[1], 32);
  if (!ownerBytes) return null;

  return {
    npub: nip19.npubEncode(bytesToHex(ownerBytes)),
    treeHint: match[2],
  };
}
