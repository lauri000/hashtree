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

export interface BoardCardComment {
  id: string;
  authorNpub: string;
  markdown: string;
  createdAt: number;
  updatedAt: number;
  attachments: BoardCardAttachment[];
}

export interface BoardCard {
  id: string;
  title: string;
  description: string;
  assigneeNpubs: string[];
  attachments: BoardCardAttachment[];
  comments: BoardCardComment[];
  updatedAt?: number;
  updatedBy?: string;
}

export interface BoardColumn {
  id: string;
  title: string;
  cards: BoardCard[];
  updatedAt?: number;
  updatedBy?: string;
}

export interface BoardState {
  version: 1;
  boardId: string;
  title: string;
  columns: BoardColumn[];
  updatedAt: number;
  updatedBy: string;
  orderUpdatedAt?: number;
  orderUpdatedBy?: string;
}

export interface BoardOrder {
  version: 1;
  columns: string[];
  cardsByColumn: Record<string, string[]>;
  updatedAt: number;
  updatedBy: string;
}

export interface BoardMeta {
  version: 1;
  boardId: string;
  title: string;
  updatedAt: number;
  updatedBy: string;
}

export interface BoardColumnMeta {
  id: string;
  title: string;
  updatedAt: number;
  updatedBy: string;
}

export interface BoardPathTombstone {
  path: string;
  updatedAt: number;
  updatedBy: string;
}

export interface BoardTombstones {
  version: 1;
  entries: BoardPathTombstone[];
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

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const deduped = new Set<string>();
  for (const item of values) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
  }
  return Array.from(deduped);
}

function normalizeComment(raw: unknown, fallbackCommentId: string): BoardCardComment | null {
  if (!isRecord(raw)) return null;
  const authorNpub = normalizeString(raw.authorNpub, '');
  if (!authorNpub) return null;

  const attachments: BoardCardAttachment[] = [];
  const rawAttachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  for (let index = 0; index < rawAttachments.length; index += 1) {
    const attachment = normalizeAttachment(rawAttachments[index], `${fallbackCommentId}-attachment-${index + 1}`);
    if (attachment) attachments.push(attachment);
  }

  const createdAt = normalizeTimestamp(raw.createdAt, Date.now());
  return {
    id: normalizeString(raw.id, fallbackCommentId),
    authorNpub,
    markdown: typeof raw.markdown === 'string' ? raw.markdown : '',
    createdAt,
    updatedAt: normalizeTimestamp(raw.updatedAt, createdAt),
    attachments,
  };
}

function normalizeCard(
  raw: unknown,
  fallbackCardId: string,
  fallbackUpdatedAt: number = 0,
  fallbackUpdatedBy: string = ''
): BoardCard | null {
  if (!isRecord(raw)) return null;
  const attachments: BoardCardAttachment[] = [];
  const rawAttachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  for (let index = 0; index < rawAttachments.length; index += 1) {
    const attachment = normalizeAttachment(rawAttachments[index], `${fallbackCardId}-attachment-${index + 1}`);
    if (attachment) attachments.push(attachment);
  }

  const comments: BoardCardComment[] = [];
  const rawComments = Array.isArray(raw.comments) ? raw.comments : [];
  for (let index = 0; index < rawComments.length; index += 1) {
    const comment = normalizeComment(rawComments[index], `${fallbackCardId}-comment-${index + 1}`);
    if (comment) comments.push(comment);
  }

  return {
    id: normalizeString(raw.id, fallbackCardId),
    title: normalizeString(raw.title, `Card ${fallbackCardId}`),
    description: typeof raw.description === 'string' ? raw.description : '',
    assigneeNpubs: normalizeStringList(raw.assigneeNpubs),
    attachments,
    comments,
    updatedAt: normalizeTimestamp(raw.updatedAt, fallbackUpdatedAt),
    updatedBy: normalizeString(raw.updatedBy, fallbackUpdatedBy),
  };
}

function normalizeColumn(
  raw: unknown,
  fallbackColumnId: string,
  fallbackUpdatedAt: number = 0,
  fallbackUpdatedBy: string = ''
): BoardColumn | null {
  if (!isRecord(raw)) return null;

  const id = normalizeString(raw.id, fallbackColumnId);
  const title = normalizeString(raw.title, 'Untitled Column');

  const cards: BoardCard[] = [];
  const rawCards = Array.isArray(raw.cards) ? raw.cards : [];
  for (let index = 0; index < rawCards.length; index += 1) {
    const card = normalizeCard(rawCards[index], `${id}-card-${index + 1}`, fallbackUpdatedAt, fallbackUpdatedBy);
    if (card) cards.push(card);
  }

  return {
    id,
    title,
    cards,
    updatedAt: normalizeTimestamp(raw.updatedAt, fallbackUpdatedAt),
    updatedBy: normalizeString(raw.updatedBy, fallbackUpdatedBy),
  };
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
      { id: randomId(), title: 'Todo', cards: [], updatedAt, updatedBy: userNpub },
      { id: randomId(), title: 'Doing', cards: [], updatedAt, updatedBy: userNpub },
      { id: randomId(), title: 'Done', cards: [], updatedAt, updatedBy: userNpub },
    ],
    updatedAt,
    updatedBy: userNpub,
    orderUpdatedAt: updatedAt,
    orderUpdatedBy: userNpub,
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

  const boardUpdatedAt = normalizeTimestamp(parsed.updatedAt, 0);
  const boardUpdatedBy = normalizeString(parsed.updatedBy, fallbackUpdatedBy);
  const orderUpdatedAt = normalizeTimestamp(parsed.orderUpdatedAt, boardUpdatedAt);
  const orderUpdatedBy = normalizeString(parsed.orderUpdatedBy, boardUpdatedBy);

  const columns: BoardColumn[] = [];
  const rawColumns = Array.isArray(parsed.columns) ? parsed.columns : [];
  for (let index = 0; index < rawColumns.length; index += 1) {
    const column = normalizeColumn(rawColumns[index], `column-${index + 1}`, boardUpdatedAt, boardUpdatedBy);
    if (column) columns.push(column);
  }

  return {
    version: 1,
    boardId: normalizeString(parsed.boardId, fallbackBoardId),
    title: normalizeString(parsed.title, fallbackTitle),
    columns,
    updatedAt: boardUpdatedAt || Date.now(),
    updatedBy: boardUpdatedBy,
    orderUpdatedAt,
    orderUpdatedBy,
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
    updatedAt: board.orderUpdatedAt ?? board.updatedAt,
    updatedBy: board.orderUpdatedBy ?? board.updatedBy,
  };
  return JSON.stringify(order, null, 2) + '\n';
}

export function parseBoardOrder(
  raw: unknown,
  fallbackUpdatedAt: number = 0,
  fallbackUpdatedBy: string = ''
): BoardOrder {
  const parsed = parseJsonRecord(raw);
  if (!parsed) {
    return {
      version: 1,
      columns: [],
      cardsByColumn: {},
      updatedAt: fallbackUpdatedAt,
      updatedBy: fallbackUpdatedBy,
    };
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
    updatedAt: normalizeTimestamp(parsed.updatedAt, fallbackUpdatedAt),
    updatedBy: normalizeString(parsed.updatedBy, fallbackUpdatedBy),
  };
}

export function serializeColumnMeta(column: BoardColumn): string {
  return JSON.stringify({
    id: column.id,
    title: column.title,
    updatedAt: column.updatedAt ?? 0,
    updatedBy: column.updatedBy ?? '',
  }, null, 2) + '\n';
}

export function parseColumnMeta(
  raw: unknown,
  fallbackColumnId: string,
  fallbackUpdatedAt: number = 0,
  fallbackUpdatedBy: string = ''
): BoardColumnMeta | null {
  const parsed = parseJsonRecord(raw);
  if (!parsed) return null;

  return {
    id: normalizeString(parsed.id, fallbackColumnId),
    title: normalizeString(parsed.title, 'Untitled Column'),
    updatedAt: normalizeTimestamp(parsed.updatedAt, fallbackUpdatedAt),
    updatedBy: normalizeString(parsed.updatedBy, fallbackUpdatedBy),
  };
}

export function serializeCardData(card: BoardCard): string {
  return JSON.stringify({
    id: card.id,
    title: card.title,
    description: card.description,
    assigneeNpubs: card.assigneeNpubs,
    attachments: card.attachments,
    comments: card.comments,
    updatedAt: card.updatedAt ?? 0,
    updatedBy: card.updatedBy ?? '',
  }, null, 2) + '\n';
}

export function parseCardData(
  raw: unknown,
  fallbackCardId: string,
  fallbackUpdatedAt: number = 0,
  fallbackUpdatedBy: string = ''
): BoardCard | null {
  const parsed = parseJsonRecord(raw);
  if (!parsed) return null;
  return normalizeCard(parsed, fallbackCardId, fallbackUpdatedAt, fallbackUpdatedBy);
}

// Backward-compatible aliases while moving storage format utilities.
export const serializeCardMarkdown = serializeCardData;
export const parseCardMarkdown = parseCardData;

export function createInitialBoardTombstones(): BoardTombstones {
  return {
    version: 1,
    entries: [],
  };
}

export function serializeBoardTombstones(tombstones: BoardTombstones): string {
  return JSON.stringify({
    version: 1,
    entries: tombstones.entries.map(entry => ({
      path: entry.path,
      updatedAt: entry.updatedAt,
      updatedBy: entry.updatedBy,
    })),
  }, null, 2) + '\n';
}

export function parseBoardTombstones(raw: unknown, fallbackUpdatedBy: string = ''): BoardTombstones {
  const parsed = parseJsonRecord(raw);
  if (!parsed || !Array.isArray(parsed.entries)) {
    return createInitialBoardTombstones();
  }

  const entries: BoardPathTombstone[] = [];
  for (const rawEntry of parsed.entries) {
    if (!isRecord(rawEntry)) continue;
    const path = normalizeString(rawEntry.path, '');
    if (!path) continue;
    entries.push({
      path,
      updatedAt: normalizeTimestamp(rawEntry.updatedAt, 0),
      updatedBy: normalizeString(rawEntry.updatedBy, fallbackUpdatedBy),
    });
  }

  return {
    version: 1,
    entries,
  };
}

export function cloneBoardState(state: BoardState): BoardState {
  return {
    ...state,
    columns: state.columns.map(column => ({
      ...column,
      cards: column.cards.map(card => ({
        ...card,
        assigneeNpubs: [...card.assigneeNpubs],
        attachments: card.attachments.map(attachment => ({ ...attachment })),
        comments: card.comments.map(comment => ({
          ...comment,
          attachments: comment.attachments.map(attachment => ({ ...attachment })),
        })),
      })),
    })),
  };
}

export function cloneBoardTombstones(tombstones: BoardTombstones): BoardTombstones {
  return {
    version: 1,
    entries: tombstones.entries.map(entry => ({ ...entry })),
  };
}
