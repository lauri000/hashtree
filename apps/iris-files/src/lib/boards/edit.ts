import { BOARD_COLUMNS_DIR } from './constants';
import {
  boardCardPath,
  boardColumnPath,
  clearBoardPathDeletions,
  recordBoardPathDeletion,
  recordBoardPathDeletions,
} from './merge';
import {
  cloneBoardState,
  cloneBoardTombstones,
  type BoardCard,
  type BoardState,
  type BoardTombstones,
} from './state';

export interface BoardEditResult {
  board: BoardState;
  tombstones: BoardTombstones;
  changed: boolean;
}

interface BoardEditContext {
  actor: string;
  updatedAt?: number;
}

interface AddBoardColumnInput extends BoardEditContext {
  columnId: string;
  title: string;
}

interface UpdateBoardColumnTitleInput extends BoardEditContext {
  columnId: string;
  title: string;
}

interface RemoveBoardColumnInput extends BoardEditContext {
  columnId: string;
}

interface AddBoardCardInput extends BoardEditContext {
  columnId: string;
  card: BoardCard;
}

interface MutateBoardCardInput extends BoardEditContext {
  columnId: string;
  cardId: string;
  mutate: (card: BoardCard) => void;
}

interface RemoveBoardCardInput extends BoardEditContext {
  columnId: string;
  cardId: string;
}

interface MoveBoardCardInput extends BoardEditContext {
  fromColumnId: string;
  cardId: string;
  toColumnId: string;
  beforeCardId: string | null;
  position: 'before' | 'after' | 'end';
}

interface MoveBoardColumnInput extends BoardEditContext {
  fromColumnId: string;
  toColumnId: string;
  position: 'before' | 'after';
}

function changeAt(context: BoardEditContext): number {
  return context.updatedAt ?? Date.now();
}

function touchBoard(board: BoardState, actor: string, updatedAt: number): void {
  board.updatedAt = updatedAt;
  board.updatedBy = actor;
}

function touchOrder(board: BoardState, actor: string, updatedAt: number): void {
  touchBoard(board, actor, updatedAt);
  board.orderUpdatedAt = updatedAt;
  board.orderUpdatedBy = actor;
}

function touchCard(board: BoardState, card: BoardCard, actor: string, updatedAt: number): void {
  card.updatedAt = updatedAt;
  card.updatedBy = actor;
  touchBoard(board, actor, updatedAt);
}

function columnDirPath(columnId: string): string {
  return `${BOARD_COLUMNS_DIR}/${columnId}`;
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

function resolveCardInsertIndex(
  targetCards: BoardCard[],
  beforeCardId: string | null,
  position: 'before' | 'after' | 'end',
): number {
  if (!beforeCardId || position === 'end') return targetCards.length;
  const anchorIndex = targetCards.findIndex(card => card.id === beforeCardId);
  if (anchorIndex === -1) return targetCards.length;
  return position === 'after' ? anchorIndex + 1 : anchorIndex;
}

export function addBoardColumn(
  board: BoardState,
  tombstones: BoardTombstones,
  input: AddBoardColumnInput,
): BoardEditResult {
  const updatedAt = changeAt(input);
  const nextBoard = cloneBoardState(board);
  let nextTombstones = cloneBoardTombstones(tombstones);

  nextBoard.columns.push({
    id: input.columnId,
    title: input.title,
    cards: [],
    updatedAt,
    updatedBy: input.actor,
  });

  touchOrder(nextBoard, input.actor, updatedAt);
  nextTombstones = clearBoardPathDeletions(nextTombstones, columnDirPath(input.columnId));

  return { board: nextBoard, tombstones: nextTombstones, changed: true };
}

export function updateBoardColumnTitle(
  board: BoardState,
  tombstones: BoardTombstones,
  input: UpdateBoardColumnTitleInput,
): BoardEditResult {
  const nextBoard = cloneBoardState(board);
  let nextTombstones = cloneBoardTombstones(tombstones);
  const column = nextBoard.columns.find(item => item.id === input.columnId);
  if (!column) return { board, tombstones, changed: false };

  const updatedAt = changeAt(input);
  column.title = input.title;
  column.updatedAt = updatedAt;
  column.updatedBy = input.actor;
  touchBoard(nextBoard, input.actor, updatedAt);
  nextTombstones = clearBoardPathDeletions(nextTombstones, boardColumnPath(input.columnId));

  return { board: nextBoard, tombstones: nextTombstones, changed: true };
}

export function removeBoardColumn(
  board: BoardState,
  tombstones: BoardTombstones,
  input: RemoveBoardColumnInput,
): BoardEditResult {
  const nextBoard = cloneBoardState(board);
  const columnIndex = nextBoard.columns.findIndex(column => column.id === input.columnId);
  if (columnIndex === -1) return { board, tombstones, changed: false };

  const updatedAt = changeAt(input);
  const [removedColumn] = nextBoard.columns.splice(columnIndex, 1);
  const deletedPaths = [
    boardColumnPath(input.columnId),
    ...removedColumn.cards.map(card => boardCardPath(input.columnId, card.id)),
  ];
  const nextTombstones = recordBoardPathDeletions(
    cloneBoardTombstones(tombstones),
    deletedPaths,
    input.actor,
    updatedAt,
  );

  touchOrder(nextBoard, input.actor, updatedAt);
  return { board: nextBoard, tombstones: nextTombstones, changed: true };
}

export function addBoardCard(
  board: BoardState,
  tombstones: BoardTombstones,
  input: AddBoardCardInput,
): BoardEditResult {
  const nextBoard = cloneBoardState(board);
  let nextTombstones = cloneBoardTombstones(tombstones);
  const column = nextBoard.columns.find(item => item.id === input.columnId);
  if (!column) return { board, tombstones, changed: false };

  const updatedAt = changeAt(input);
  const nextCard = cloneCard(input.card);
  nextCard.updatedAt = updatedAt;
  nextCard.updatedBy = input.actor;
  column.cards.push(nextCard);
  touchOrder(nextBoard, input.actor, updatedAt);
  nextTombstones = clearBoardPathDeletions(nextTombstones, boardCardPath(input.columnId, nextCard.id));

  return { board: nextBoard, tombstones: nextTombstones, changed: true };
}

export function mutateBoardCard(
  board: BoardState,
  tombstones: BoardTombstones,
  input: MutateBoardCardInput,
): BoardEditResult {
  const nextBoard = cloneBoardState(board);
  let nextTombstones = cloneBoardTombstones(tombstones);
  const column = nextBoard.columns.find(item => item.id === input.columnId);
  const card = column?.cards.find(item => item.id === input.cardId);
  if (!card) return { board, tombstones, changed: false };

  const updatedAt = changeAt(input);
  input.mutate(card);
  touchCard(nextBoard, card, input.actor, updatedAt);
  nextTombstones = clearBoardPathDeletions(nextTombstones, boardCardPath(input.columnId, input.cardId));

  return { board: nextBoard, tombstones: nextTombstones, changed: true };
}

export function removeBoardCard(
  board: BoardState,
  tombstones: BoardTombstones,
  input: RemoveBoardCardInput,
): BoardEditResult {
  const nextBoard = cloneBoardState(board);
  const column = nextBoard.columns.find(item => item.id === input.columnId);
  if (!column) return { board, tombstones, changed: false };

  const cardIndex = column.cards.findIndex(card => card.id === input.cardId);
  if (cardIndex === -1) return { board, tombstones, changed: false };

  const updatedAt = changeAt(input);
  column.cards.splice(cardIndex, 1);
  const nextTombstones = recordBoardPathDeletion(
    cloneBoardTombstones(tombstones),
    boardCardPath(input.columnId, input.cardId),
    input.actor,
    updatedAt,
  );

  touchOrder(nextBoard, input.actor, updatedAt);
  return { board: nextBoard, tombstones: nextTombstones, changed: true };
}

export function moveBoardCard(
  board: BoardState,
  tombstones: BoardTombstones,
  input: MoveBoardCardInput,
): BoardEditResult {
  const nextBoard = cloneBoardState(board);
  let nextTombstones = cloneBoardTombstones(tombstones);
  const sourceColumn = nextBoard.columns.find(column => column.id === input.fromColumnId);
  const targetColumn = nextBoard.columns.find(column => column.id === input.toColumnId);
  if (!sourceColumn || !targetColumn) return { board, tombstones, changed: false };

  const sourceOrderBefore = sourceColumn.cards.map(card => card.id);
  const targetOrderBefore = targetColumn.cards.map(card => card.id);
  const cardIndex = sourceColumn.cards.findIndex(card => card.id === input.cardId);
  if (cardIndex === -1) return { board, tombstones, changed: false };

  const updatedAt = changeAt(input);
  const [card] = sourceColumn.cards.splice(cardIndex, 1);
  let insertIndex = resolveCardInsertIndex(targetColumn.cards, input.beforeCardId, input.position);
  insertIndex = Math.max(0, Math.min(insertIndex, targetColumn.cards.length));
  targetColumn.cards.splice(insertIndex, 0, card);

  if (input.fromColumnId === input.toColumnId) {
    const targetOrderAfter = targetColumn.cards.map(item => item.id);
    if (targetOrderBefore.length === targetOrderAfter.length
      && targetOrderBefore.every((cardId, index) => cardId === targetOrderAfter[index])) {
      return { board, tombstones, changed: false };
    }

    touchOrder(nextBoard, input.actor, updatedAt);
    return { board: nextBoard, tombstones: nextTombstones, changed: true };
  }

  const sourceOrderAfter = sourceColumn.cards.map(item => item.id);
  const targetOrderAfter = targetColumn.cards.map(item => item.id);
  const movedWithinDifferentColumns = sourceOrderBefore.some((cardId, index) => cardId !== sourceOrderAfter[index])
    || targetOrderBefore.some((cardId, index) => cardId !== targetOrderAfter[index])
    || targetOrderBefore.length !== targetOrderAfter.length;

  if (!movedWithinDifferentColumns) {
    return { board, tombstones, changed: false };
  }

  touchCard(nextBoard, card, input.actor, updatedAt);
  nextTombstones = recordBoardPathDeletion(
    nextTombstones,
    boardCardPath(input.fromColumnId, input.cardId),
    input.actor,
    updatedAt,
  );
  nextTombstones = clearBoardPathDeletions(nextTombstones, boardCardPath(input.toColumnId, input.cardId));
  nextBoard.orderUpdatedAt = updatedAt;
  nextBoard.orderUpdatedBy = input.actor;

  return { board: nextBoard, tombstones: nextTombstones, changed: true };
}

export function moveBoardColumn(
  board: BoardState,
  tombstones: BoardTombstones,
  input: MoveBoardColumnInput,
): BoardEditResult {
  if (input.fromColumnId === input.toColumnId) {
    return { board, tombstones, changed: false };
  }

  const nextBoard = cloneBoardState(board);
  const fromIndex = nextBoard.columns.findIndex(column => column.id === input.fromColumnId);
  const toIndex = nextBoard.columns.findIndex(column => column.id === input.toColumnId);
  if (fromIndex === -1 || toIndex === -1) return { board, tombstones, changed: false };

  const orderBefore = nextBoard.columns.map(column => column.id);
  const [column] = nextBoard.columns.splice(fromIndex, 1);
  const targetIndex = nextBoard.columns.findIndex(item => item.id === input.toColumnId);
  const insertIndex = input.position === 'after' ? targetIndex + 1 : targetIndex;
  nextBoard.columns.splice(insertIndex, 0, column);

  const orderAfter = nextBoard.columns.map(item => item.id);
  if (orderBefore.length === orderAfter.length && orderBefore.every((columnId, index) => columnId === orderAfter[index])) {
    return { board, tombstones, changed: false };
  }

  touchOrder(nextBoard, input.actor, changeAt(input));
  return { board: nextBoard, tombstones: cloneBoardTombstones(tombstones), changed: true };
}
