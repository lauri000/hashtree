export interface BoardCardAttachment {
  id: string;
  fileName: string;
  displayName: string;
  mimeType: string;
  size: number;
  uploaderNpub: string;
  cidHash: string;
  cidKey?: string;
}

export interface BoardCard {
  id: string;
  title: string;
  description: string;
  attachments: BoardCardAttachment[];
}

export interface BoardColumn {
  id: string;
  title: string;
  cards: BoardCard[];
}

export interface BoardState {
  version: 1;
  boardId: string;
  title: string;
  columns: BoardColumn[];
  updatedAt: number;
  updatedBy: string;
}

export interface BoardOrder {
  version: 1;
  columns: string[];
  cardsByColumn: Record<string, string[]>;
}

export interface BoardMeta {
  version: 1;
  boardId: string;
  title: string;
  updatedAt: number;
  updatedBy: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (value instanceof ArrayBuffer) return false;
  if (ArrayBuffer.isView(value)) return false;
  return true;
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

function parseJsonValue(raw: unknown): unknown | null {
  if (raw === null || raw === undefined) return null;
  if (isRecord(raw) || Array.isArray(raw)) return raw;

  const text = toText(raw);
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonRecord(raw: unknown): Record<string, unknown> | null {
  const parsed = parseJsonValue(raw);
  if (!isRecord(parsed)) return null;
  return parsed;
}

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

function normalizeFileSize(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return 0;
}

function normalizeAttachment(raw: unknown, fallbackAttachmentId: string): BoardCardAttachment | null {
  if (!isRecord(raw)) return null;

  const fileName = normalizeString(raw.fileName, '');
  const cidHash = normalizeString(raw.cidHash, '');
  const uploaderNpub = normalizeString(raw.uploaderNpub, '');
  if (!fileName || !cidHash || !uploaderNpub) return null;

  const cidKey = typeof raw.cidKey === 'string' && raw.cidKey.trim()
    ? raw.cidKey.trim()
    : undefined;

  return {
    id: normalizeString(raw.id, fallbackAttachmentId),
    fileName,
    displayName: normalizeString(raw.displayName, fileName),
    mimeType: normalizeString(raw.mimeType, 'application/octet-stream'),
    size: normalizeFileSize(raw.size),
    uploaderNpub,
    cidHash,
    cidKey,
  };
}

function normalizeCard(raw: unknown, fallbackCardId: string): BoardCard | null {
  if (!isRecord(raw)) return null;
  const attachments: BoardCardAttachment[] = [];
  const rawAttachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  for (let index = 0; index < rawAttachments.length; index += 1) {
    const attachment = normalizeAttachment(rawAttachments[index], `${fallbackCardId}-attachment-${index + 1}`);
    if (attachment) attachments.push(attachment);
  }
  return {
    id: normalizeString(raw.id, fallbackCardId),
    title: normalizeString(raw.title, `Card ${fallbackCardId}`),
    description: typeof raw.description === 'string' ? raw.description : '',
    attachments,
  };
}

function normalizeColumn(raw: unknown, fallbackColumnId: string): BoardColumn | null {
  if (!isRecord(raw)) return null;

  const id = normalizeString(raw.id, fallbackColumnId);
  const title = normalizeString(raw.title, 'Untitled Column');

  const cards: BoardCard[] = [];
  const rawCards = Array.isArray(raw.cards) ? raw.cards : [];
  for (let index = 0; index < rawCards.length; index += 1) {
    const card = normalizeCard(rawCards[index], `${id}-card-${index + 1}`);
    if (card) cards.push(card);
  }

  return { id, title, cards };
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createBoardId(): string {
  return randomId();
}

export function createInitialBoardState(
  boardId: string,
  title: string,
  userNpub: string,
  updatedAt: number = Date.now()
): BoardState {
  return {
    version: 1,
    boardId,
    title,
    columns: [
      { id: randomId(), title: 'Todo', cards: [] },
      { id: randomId(), title: 'Doing', cards: [] },
      { id: randomId(), title: 'Done', cards: [] },
    ],
    updatedAt,
    updatedBy: userNpub,
  };
}

export function serializeBoardState(board: BoardState): string {
  return JSON.stringify(board, null, 2) + '\n';
}

export function parseBoardState(
  raw: unknown,
  fallbackBoardId: string,
  fallbackTitle: string,
  fallbackUpdatedBy: string
): BoardState | null {
  const parsed = parseJsonRecord(raw);
  if (!parsed) return null;

  const columns: BoardColumn[] = [];
  const rawColumns = Array.isArray(parsed.columns) ? parsed.columns : [];
  for (let index = 0; index < rawColumns.length; index += 1) {
    const column = normalizeColumn(rawColumns[index], `column-${index + 1}`);
    if (column) columns.push(column);
  }

  return {
    version: 1,
    boardId: normalizeString(parsed.boardId, fallbackBoardId),
    title: normalizeString(parsed.title, fallbackTitle),
    columns,
    updatedAt: normalizeTimestamp(parsed.updatedAt, Date.now()),
    updatedBy: normalizeString(parsed.updatedBy, fallbackUpdatedBy),
  };
}

export function serializeBoardMeta(board: BoardState): string {
  const meta: BoardMeta = {
    version: 1,
    boardId: board.boardId,
    title: board.title,
    updatedAt: board.updatedAt,
    updatedBy: board.updatedBy,
  };
  return JSON.stringify(meta, null, 2) + '\n';
}

export function parseBoardMeta(
  raw: unknown,
  fallbackBoardId: string,
  fallbackTitle: string,
  fallbackUpdatedBy: string
): BoardMeta | null {
  const parsed = parseJsonRecord(raw);
  if (!parsed) return null;

  return {
    version: 1,
    boardId: normalizeString(parsed.boardId, fallbackBoardId),
    title: normalizeString(parsed.title, fallbackTitle),
    updatedAt: normalizeTimestamp(parsed.updatedAt, Date.now()),
    updatedBy: normalizeString(parsed.updatedBy, fallbackUpdatedBy),
  };
}

export function serializeBoardOrder(board: BoardState): string {
  const order: BoardOrder = {
    version: 1,
    columns: board.columns.map(column => column.id),
    cardsByColumn: Object.fromEntries(
      board.columns.map(column => [column.id, column.cards.map(card => card.id)])
    ),
  };
  return JSON.stringify(order, null, 2) + '\n';
}

export function parseBoardOrder(raw: unknown): BoardOrder {
  const parsed = parseJsonRecord(raw);
  if (!parsed) {
    return { version: 1, columns: [], cardsByColumn: {} };
  }

  const columns = Array.isArray(parsed.columns)
    ? parsed.columns
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
    : [];

  const cardsByColumn: Record<string, string[]> = {};
  if (isRecord(parsed.cardsByColumn)) {
    for (const [columnId, cardIds] of Object.entries(parsed.cardsByColumn)) {
      if (!columnId.trim()) continue;
      if (!Array.isArray(cardIds)) continue;
      cardsByColumn[columnId] = cardIds
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean);
    }
  }

  return {
    version: 1,
    columns,
    cardsByColumn,
  };
}

export function serializeColumnMeta(column: BoardColumn): string {
  return JSON.stringify({ id: column.id, title: column.title }, null, 2) + '\n';
}

export function parseColumnMeta(raw: unknown, fallbackColumnId: string): { id: string; title: string } | null {
  const parsed = parseJsonRecord(raw);
  if (!parsed) return null;

  return {
    id: normalizeString(parsed.id, fallbackColumnId),
    title: normalizeString(parsed.title, 'Untitled Column'),
  };
}

export function serializeCardData(card: BoardCard): string {
  return JSON.stringify({
    id: card.id,
    title: card.title,
    description: card.description,
    attachments: card.attachments,
  }, null, 2) + '\n';
}

export function parseCardData(raw: unknown, fallbackCardId: string): BoardCard | null {
  const parsed = parseJsonRecord(raw);
  if (!parsed) return null;
  return normalizeCard(parsed, fallbackCardId);
}

// Backward-compatible aliases while moving storage format utilities.
export const serializeCardMarkdown = serializeCardData;
export const parseCardMarkdown = parseCardData;

export function cloneBoardState(state: BoardState): BoardState {
  return {
    ...state,
    columns: state.columns.map(column => ({
      ...column,
      cards: column.cards.map(card => ({
        ...card,
        attachments: card.attachments.map(attachment => ({ ...attachment })),
      })),
    })),
  };
}
