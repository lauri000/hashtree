const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

const DISALLOWED_CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const REPLACEMENT_CHAR_REGEX = /\uFFFD/;

function looksLikeEmbeddedBinaryMetadata(text: string): boolean {
  const upper = text.toUpperCase();
  if (upper.includes('ICC_PROFILE')) {
    return true;
  }
  if (upper.includes('JFIF') && text.length > 32) {
    return true;
  }
  return false;
}

function sanitizeVideoText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (REPLACEMENT_CHAR_REGEX.test(trimmed)) return '';
  if (DISALLOWED_CONTROL_CHAR_REGEX.test(trimmed)) return '';
  if (looksLikeEmbeddedBinaryMetadata(trimmed)) return '';
  return trimmed;
}

export function sanitizeVideoTitle(value: unknown): string {
  return sanitizeVideoText(value);
}

export function sanitizeVideoDescription(value: unknown): string {
  return sanitizeVideoText(value);
}

export function decodeVideoTextFile(data: Uint8Array | null | undefined): string {
  if (!data?.length) return '';
  try {
    return sanitizeVideoText(fatalTextDecoder.decode(data));
  } catch {
    return '';
  }
}
