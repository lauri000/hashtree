const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const SAFE_TREE_LABEL_RE = /^(?!x-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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

export function encodeImmutableHostLabel(hash: Uint8Array): string {
  return encodeBase32(hash);
}

export function decodeImmutableHostLabel(label: string): Uint8Array | null {
  const decoded = decodeBase32(label);
  if (!decoded || decoded.length !== 32) return null;
  return decoded;
}

export function encodeTreeNameLabels(treeName: string): string[] {
  const safeLabels = treeName.split('/').filter(Boolean);
  if (safeLabels.length && safeLabels.every((label) => SAFE_TREE_LABEL_RE.test(label))) {
    return safeLabels;
  }

  const treeHex = bytesToHex(new TextEncoder().encode(treeName));
  const chunks = treeHex.match(/.{1,60}/g);
  if (!chunks || chunks.length === 0) {
    return ['x-00'];
  }
  return chunks.map((chunk) => `x-${chunk}`);
}

export function decodeTreeNameFromLabels(labels: string[]): string | null {
  if (!labels.length) return null;

  if (labels.every((label) => SAFE_TREE_LABEL_RE.test(label))) {
    return labels.join('/');
  }

  if (!labels.every((label) => /^x-[a-f0-9]+$/.test(label))) {
    return null;
  }

  const hex = labels.map((label) => label.slice(2)).join('');
  const bytes = hexToBytes(hex);
  if (!bytes) return null;

  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
