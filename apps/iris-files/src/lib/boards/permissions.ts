import { nip19 } from 'nostr-tools';

export type BoardRole = 'admin' | 'writer';

export interface BoardPermissions {
  version: 1;
  boardId: string;
  title: string;
  admins: string[];
  writers: string[];
  updatedAt: number;
  updatedBy: string;
}

function toText(raw: unknown): string | null {
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(raw));
  }
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  }
  if (raw instanceof Uint8Array) {
    return new TextDecoder().decode(raw);
  }
  if (typeof raw === 'string') return raw;
  return null;
}

export function serializeBoardPermissions(permissions: BoardPermissions): string {
  return JSON.stringify(permissions, null, 2) + '\n';
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (value instanceof ArrayBuffer) return false;
  if (ArrayBuffer.isView(value)) return false;
  return true;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (isObject(raw)) return raw;

  const text = toText(raw);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isValidNpub(npub: string): boolean {
  if (!npub.startsWith('npub1')) return false;
  try {
    const decoded = nip19.decode(npub);
    return decoded.type === 'npub';
  } catch {
    return false;
  }
}

function normalizeNpubList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const deduped = new Set<string>();
  for (const item of values) {
    if (typeof item !== 'string') continue;
    const npub = item.trim();
    if (!isValidNpub(npub)) continue;
    deduped.add(npub);
  }
  return Array.from(deduped);
}

function normalizePermissionsData(
  partial: Partial<BoardPermissions>,
  ownerNpub: string
): BoardPermissions {
  const admins = normalizeNpubList(partial.admins);
  if (!admins.includes(ownerNpub)) admins.unshift(ownerNpub);

  const writers = normalizeNpubList(partial.writers).filter(npub => !admins.includes(npub));

  const updatedBy = partial.updatedBy && isValidNpub(partial.updatedBy)
    ? partial.updatedBy
    : ownerNpub;

  return {
    version: 1,
    boardId: partial.boardId || '',
    title: typeof partial.title === 'string' ? partial.title : '',
    admins,
    writers,
    updatedAt: typeof partial.updatedAt === 'number' ? partial.updatedAt : Date.now(),
    updatedBy,
  };
}

export function createInitialBoardPermissions(
  boardId: string,
  title: string,
  ownerNpub: string,
  updatedAt: number = Date.now()
): BoardPermissions {
  return {
    version: 1,
    boardId,
    title,
    admins: [ownerNpub],
    writers: [],
    updatedAt,
    updatedBy: ownerNpub,
  };
}

function coercePermissions(raw: unknown): Partial<BoardPermissions> | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;

  return {
    version: 1,
    boardId: typeof parsed.boardId === 'string' ? parsed.boardId : '',
    title: typeof parsed.title === 'string' ? parsed.title : '',
    admins: Array.isArray(parsed.admins) ? parsed.admins as string[] : [],
    writers: Array.isArray(parsed.writers) ? parsed.writers as string[] : [],
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : '',
  };
}

export function parseBoardPermissions(raw: unknown, ownerNpub: string): BoardPermissions | null {
  if (!isValidNpub(ownerNpub)) return null;

  const coerced = coercePermissions(raw);
  if (!coerced) return null;
  return normalizePermissionsData(coerced, ownerNpub);
}

export function canManageBoard(
  permissions: BoardPermissions,
  userNpub: string | null | undefined,
  ownerNpub: string
): boolean {
  if (!userNpub) return false;
  return userNpub === ownerNpub || permissions.admins.includes(userNpub);
}

export function canWriteBoard(
  permissions: BoardPermissions,
  userNpub: string | null | undefined,
  ownerNpub: string
): boolean {
  if (!userNpub) return false;
  return canManageBoard(permissions, userNpub, ownerNpub) || permissions.writers.includes(userNpub);
}

export function addBoardPermission(
  permissions: BoardPermissions,
  role: BoardRole,
  targetNpub: string,
  actorNpub: string,
  updatedAt: number = Date.now()
): BoardPermissions {
  if (!isValidNpub(targetNpub)) return permissions;

  const admins = [...permissions.admins];
  const writers = [...permissions.writers];

  if (role === 'admin') {
    if (!admins.includes(targetNpub)) admins.push(targetNpub);
    const writerIndex = writers.indexOf(targetNpub);
    if (writerIndex !== -1) writers.splice(writerIndex, 1);
  } else {
    if (!admins.includes(targetNpub) && !writers.includes(targetNpub)) {
      writers.push(targetNpub);
    }
  }

  return {
    ...permissions,
    admins,
    writers,
    updatedAt,
    updatedBy: isValidNpub(actorNpub) ? actorNpub : permissions.updatedBy,
  };
}

export function removeBoardPermission(
  permissions: BoardPermissions,
  role: BoardRole,
  targetNpub: string,
  actorNpub: string,
  updatedAt: number = Date.now()
): BoardPermissions {
  const admins = [...permissions.admins];
  const writers = [...permissions.writers];

  if (role === 'admin') {
    const targetIndex = admins.indexOf(targetNpub);
    if (targetIndex === -1) return permissions;
    if (admins.length === 1) return permissions;
    admins.splice(targetIndex, 1);
  } else {
    const targetIndex = writers.indexOf(targetNpub);
    if (targetIndex === -1) return permissions;
    writers.splice(targetIndex, 1);
  }

  return {
    ...permissions,
    admins,
    writers,
    updatedAt,
    updatedBy: isValidNpub(actorNpub) ? actorNpub : permissions.updatedBy,
  };
}
