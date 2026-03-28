import { mergePathSources, type HiddenPath, type PathMergeSource } from '@hashtree/merge';
import {
  BOARD_CARD_FILE_SUFFIX,
  BOARD_CARDS_DIR,
  BOARD_COLUMN_META_FILE,
  BOARD_COLUMNS_DIR,
  BOARD_META_FILE,
  BOARD_ORDER_FILE,
  BOARD_PERMISSIONS_FILE,
} from './constants';
import {
  createInitialBoardPermissions,
  type BoardPermissions,
} from './permissions';
import {
  createInitialBoardTombstones,
  type BoardCard,
  type BoardColumn,
  type BoardMeta,
  type BoardOrder,
  type BoardPathTombstone,
  type BoardState,
  type BoardTombstones,
} from './state';

interface BoardPathValueBase {
  updatedAt: number;
  updatedBy: string;
}

interface BoardMetaPathValue extends BoardPathValueBase {
  kind: 'board-meta';
  meta: BoardMeta;
}

interface BoardOrderPathValue extends BoardPathValueBase {
  kind: 'board-order';
  order: BoardOrder;
}

interface BoardPermissionsPathValue extends BoardPathValueBase {
  kind: 'board-permissions';
  permissions: BoardPermissions;
}

interface BoardColumnPathValue extends BoardPathValueBase {
  kind: 'board-column';
  column: BoardColumn;
}

interface BoardCardPathValue extends BoardPathValueBase {
  kind: 'board-card';
  columnId: string;
  card: BoardCard;
}

type BoardPathValue =
  | BoardMetaPathValue
  | BoardOrderPathValue
  | BoardPermissionsPathValue
  | BoardColumnPathValue
  | BoardCardPathValue;

export interface BoardMergeSource {
  source: string;
  board: BoardState | null;
  permissions?: BoardPermissions | null;
  tombstones?: BoardTombstones | null;
}

export interface MergedBoardSnapshot {
  board: BoardState | null;
  permissions: BoardPermissions | null;
  tombstones: BoardTombstones;
  hidden: HiddenPath[];
}

interface MergeBoardSnapshotOptions {
  ownerNpub: string;
  fallbackBoardId: string;
  fallbackTitle: string;
}

function compareRecordTimestamp(
  updatedAt: number,
  currentUpdatedAt: number,
  leftTieBreaker: string,
  rightTieBreaker: string,
): boolean {
  if (updatedAt !== currentUpdatedAt) return updatedAt > currentUpdatedAt;
  return leftTieBreaker > rightTieBreaker;
}

function normalizeColumn(column: BoardColumn, board: BoardState): BoardColumn {
  return {
    ...column,
    updatedAt: column.updatedAt ?? board.updatedAt,
    updatedBy: column.updatedBy ?? board.updatedBy,
    cards: column.cards.map(card => normalizeCard(card, board)),
  };
}

function normalizeCard(card: BoardCard, board: BoardState): BoardCard {
  return {
    ...card,
    updatedAt: card.updatedAt ?? board.updatedAt,
    updatedBy: card.updatedBy ?? board.updatedBy,
    attachments: card.attachments.map(attachment => ({ ...attachment })),
    comments: card.comments.map(comment => ({
      ...comment,
      attachments: comment.attachments.map(attachment => ({ ...attachment })),
    })),
  };
}

function normalizeBoard(board: BoardState): BoardState {
  return {
    ...board,
    orderUpdatedAt: board.orderUpdatedAt ?? board.updatedAt,
    orderUpdatedBy: board.orderUpdatedBy ?? board.updatedBy,
    columns: board.columns.map(column => normalizeColumn(column, board)),
  };
}

function clonePermissions(permissions: BoardPermissions): BoardPermissions {
  return {
    ...permissions,
    admins: [...permissions.admins],
    writers: [...permissions.writers],
  };
}

function cloneCard(card: BoardCard): BoardCard {
  return {
    ...card,
    assigneeNpubs: [...card.assigneeNpubs],
    attachments: card.attachments.map(attachment => ({ ...attachment })),
    comments: card.comments.map(comment => ({
      ...comment,
      attachments: comment.attachments.map(attachment => ({ ...attachment })),
    })),
  };
}

function cloneColumn(column: BoardColumn): BoardColumn {
  return {
    ...column,
    cards: column.cards.map(cloneCard),
  };
}

function buildBoardMeta(board: BoardState): BoardMeta {
  return {
    version: 1,
    boardId: board.boardId,
    title: board.title,
    updatedAt: board.updatedAt,
    updatedBy: board.updatedBy,
  };
}

function buildBoardOrder(board: BoardState): BoardOrder {
  return {
    version: 1,
    columns: board.columns.map(column => column.id),
    cardsByColumn: Object.fromEntries(
      board.columns.map(column => [column.id, column.cards.map(card => card.id)]),
    ),
    updatedAt: board.orderUpdatedAt ?? board.updatedAt,
    updatedBy: board.orderUpdatedBy ?? board.updatedBy,
  };
}

function buildPathSources(source: BoardMergeSource): Array<PathMergeSource<BoardPathValue>> {
  const result: Array<PathMergeSource<BoardPathValue>> = [];

  if (source.board) {
    const board = normalizeBoard(source.board);
    const boardMeta = buildBoardMeta(board);
    const boardOrder = buildBoardOrder(board);

    result.push({
      name: `${source.source}:${BOARD_META_FILE}`,
      precedence: boardMeta.updatedAt,
      entries: [{ path: BOARD_META_FILE, kind: 'file', value: { kind: 'board-meta', meta: boardMeta, updatedAt: boardMeta.updatedAt, updatedBy: boardMeta.updatedBy } }],
      tombstones: [],
    });
    result.push({
      name: `${source.source}:${BOARD_ORDER_FILE}`,
      precedence: boardOrder.updatedAt,
      entries: [{ path: BOARD_ORDER_FILE, kind: 'file', value: { kind: 'board-order', order: boardOrder, updatedAt: boardOrder.updatedAt, updatedBy: boardOrder.updatedBy } }],
      tombstones: [],
    });

    for (const column of board.columns) {
      result.push({
        name: `${source.source}:${boardColumnPath(column.id)}`,
        precedence: column.updatedAt ?? board.updatedAt,
        entries: [{
          path: boardColumnPath(column.id),
          kind: 'file',
          value: {
            kind: 'board-column',
            column: cloneColumn({ ...column, cards: [] }),
            updatedAt: column.updatedAt ?? board.updatedAt,
            updatedBy: column.updatedBy ?? board.updatedBy,
          },
        }],
        tombstones: [],
      });

      for (const card of column.cards) {
        result.push({
          name: `${source.source}:${boardCardPath(column.id, card.id)}`,
          precedence: card.updatedAt ?? board.updatedAt,
          entries: [{
            path: boardCardPath(column.id, card.id),
            kind: 'file',
            value: {
              kind: 'board-card',
              columnId: column.id,
              card: cloneCard(card),
              updatedAt: card.updatedAt ?? board.updatedAt,
              updatedBy: card.updatedBy ?? board.updatedBy,
            },
          }],
          tombstones: [],
        });
      }
    }
  }

  if (source.permissions) {
    const permissions = clonePermissions(source.permissions);
    result.push({
      name: `${source.source}:${BOARD_PERMISSIONS_FILE}`,
      precedence: permissions.updatedAt,
      entries: [{ path: BOARD_PERMISSIONS_FILE, kind: 'file', value: { kind: 'board-permissions', permissions, updatedAt: permissions.updatedAt, updatedBy: permissions.updatedBy } }],
      tombstones: [],
    });
  }

  for (const tombstone of source.tombstones?.entries ?? []) {
    result.push({
      name: `${source.source}:tombstone:${tombstone.path}`,
      precedence: tombstone.updatedAt,
      entries: [],
      tombstones: [{ path: tombstone.path }],
    });
  }

  return result;
}

function pickLatestTombstones(sources: Iterable<BoardMergeSource>): BoardPathTombstone[] {
  const latest = new Map<string, BoardPathTombstone & { tieBreaker: string }>();

  for (const source of sources) {
    for (const tombstone of source.tombstones?.entries ?? []) {
      const current = latest.get(tombstone.path);
      if (!current || compareRecordTimestamp(tombstone.updatedAt, current.updatedAt, source.source, current.tieBreaker)) {
        latest.set(tombstone.path, { ...tombstone, tieBreaker: source.source });
      }
    }
  }

  return Array.from(latest.values())
    .map(({ tieBreaker: _tieBreaker, ...entry }) => entry)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function applyCardOrder(cards: BoardCard[], orderedCardIds: string[] | undefined): BoardCard[] {
  const byId = new Map(cards.map(card => [card.id, card]));
  const used = new Set<string>();
  const ordered: BoardCard[] = [];

  for (const cardId of orderedCardIds ?? []) {
    const card = byId.get(cardId);
    if (!card || used.has(card.id)) continue;
    ordered.push(card);
    used.add(card.id);
  }

  for (const card of cards) {
    if (used.has(card.id)) continue;
    ordered.push(card);
  }

  return ordered;
}

function applyColumnOrder(columns: BoardColumn[], orderedColumnIds: string[]): BoardColumn[] {
  const byId = new Map(columns.map(column => [column.id, column]));
  const used = new Set<string>();
  const ordered: BoardColumn[] = [];

  for (const columnId of orderedColumnIds) {
    const column = byId.get(columnId);
    if (!column || used.has(column.id)) continue;
    ordered.push(column);
    used.add(column.id);
  }

  for (const column of columns) {
    if (used.has(column.id)) continue;
    ordered.push(column);
  }

  return ordered;
}

export function boardColumnPath(columnId: string): string {
  return `${BOARD_COLUMNS_DIR}/${columnId}/${BOARD_COLUMN_META_FILE}`;
}

export function boardCardPath(columnId: string, cardId: string): string {
  return `${BOARD_COLUMNS_DIR}/${columnId}/${BOARD_CARDS_DIR}/${cardId}${BOARD_CARD_FILE_SUFFIX}`;
}

export function recordBoardPathDeletion(
  tombstones: BoardTombstones,
  path: string,
  updatedBy: string,
  updatedAt: number = Date.now(),
): BoardTombstones {
  return {
    version: 1,
    entries: [
      ...tombstones.entries.filter(entry => entry.path !== path),
      { path, updatedAt, updatedBy },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function recordBoardPathDeletions(
  tombstones: BoardTombstones,
  paths: Iterable<string>,
  updatedBy: string,
  updatedAt: number = Date.now(),
): BoardTombstones {
  let next = tombstones;
  for (const path of paths) {
    next = recordBoardPathDeletion(next, path, updatedBy, updatedAt);
  }
  return next;
}

export function clearBoardPathDeletions(tombstones: BoardTombstones, pathPrefix: string): BoardTombstones {
  return {
    version: 1,
    entries: tombstones.entries.filter(entry => entry.path !== pathPrefix && !entry.path.startsWith(`${pathPrefix}/`)),
  };
}

export function mergeBoardSnapshots(
  sources: Iterable<BoardMergeSource>,
  options: MergeBoardSnapshotOptions,
): MergedBoardSnapshot {
  const snapshots = Array.from(sources);
  const merged = mergePathSources(snapshots.flatMap(buildPathSources));
  const liveTombstones = pickLatestTombstones(snapshots);

  const entryUpdatedAtByPath = new Map<string, number>();
  const columnMap = new Map<string, BoardColumn>();
  const cardCandidates = new Map<string, { path: string; columnId: string; card: BoardCard }>();
  let boardMeta: BoardMeta | null = null;
  let boardOrder: BoardOrder | null = null;
  let permissions: BoardPermissions | null = null;
  let latestBoardUpdatedAt = 0;
  let latestBoardUpdatedBy = options.ownerNpub;

  for (const entry of merged.entries) {
    const value = entry.value;
    entryUpdatedAtByPath.set(entry.path, value.updatedAt);

    if (value.updatedAt > latestBoardUpdatedAt) {
      latestBoardUpdatedAt = value.updatedAt;
      latestBoardUpdatedBy = value.updatedBy;
    }

    switch (value.kind) {
      case 'board-meta':
        boardMeta = value.meta;
        break;
      case 'board-order':
        boardOrder = value.order;
        break;
      case 'board-permissions':
        permissions = value.permissions;
        break;
      case 'board-column':
        columnMap.set(value.column.id, { ...value.column, cards: [] });
        break;
      case 'board-card': {
        const current = cardCandidates.get(value.card.id);
        const nextCard = cloneCard(value.card);
        if (!current || compareRecordTimestamp(nextCard.updatedAt ?? 0, current.card.updatedAt ?? 0, value.columnId, current.columnId)) {
          cardCandidates.set(value.card.id, {
            path: entry.path,
            columnId: value.columnId,
            card: nextCard,
          });
        }
        break;
      }
    }
  }

  for (const { columnId } of cardCandidates.values()) {
    if (!columnMap.has(columnId)) {
      columnMap.set(columnId, {
        id: columnId,
        title: 'Untitled Column',
        cards: [],
        updatedAt: 0,
        updatedBy: options.ownerNpub,
      });
    }
  }

  for (const { columnId, card } of cardCandidates.values()) {
    const column = columnMap.get(columnId);
    if (!column) continue;
    column.cards.push(card);
  }

  const orderedColumns = applyColumnOrder(Array.from(columnMap.values()), boardOrder?.columns ?? []).map(column => ({
    ...column,
    cards: applyCardOrder(column.cards, boardOrder?.cardsByColumn[column.id]),
  }));

  const resolvedBoardId = boardMeta?.boardId || permissions?.boardId || options.fallbackBoardId;
  const resolvedTitle = boardMeta?.title || permissions?.title || options.fallbackTitle;
  const resolvedPermissions = permissions
    ? {
      ...permissions,
      boardId: resolvedBoardId,
      title: resolvedTitle,
      admins: [...permissions.admins],
      writers: [...permissions.writers],
    }
    : (orderedColumns.length > 0
      ? createInitialBoardPermissions(resolvedBoardId, resolvedTitle, options.ownerNpub, latestBoardUpdatedAt || Date.now())
      : null);

  const board = orderedColumns.length > 0 || boardMeta || boardOrder
    ? {
      version: 1,
      boardId: resolvedBoardId,
      title: resolvedTitle,
      columns: orderedColumns,
      updatedAt: latestBoardUpdatedAt || boardMeta?.updatedAt || resolvedPermissions?.updatedAt || Date.now(),
      updatedBy: latestBoardUpdatedBy,
      orderUpdatedAt: boardOrder?.updatedAt ?? boardMeta?.updatedAt ?? latestBoardUpdatedAt,
      orderUpdatedBy: boardOrder?.updatedBy ?? boardMeta?.updatedBy ?? latestBoardUpdatedBy,
    }
    : null;

  const tombstones = {
    version: 1,
    entries: liveTombstones.filter(entry => {
      const winnerUpdatedAt = entryUpdatedAtByPath.get(entry.path);
      return winnerUpdatedAt === undefined || entry.updatedAt > winnerUpdatedAt;
    }),
  };

  return {
    board,
    permissions: resolvedPermissions,
    tombstones: tombstones.entries.length > 0 ? tombstones : createInitialBoardTombstones(),
    hidden: merged.hidden,
  };
}
