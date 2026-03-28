import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import type { BoardCard, BoardColumn, BoardState } from '../src/lib/boards/state';
import {
  addBoardCard,
  addBoardColumn,
  boardCardPath,
  boardColumnPath,
  createInitialBoardTombstones,
  moveBoardCard,
  moveBoardColumn,
  mutateBoardCard,
  recordBoardPathDeletion,
  removeBoardCard,
  removeBoardColumn,
  updateBoardColumnTitle,
} from '../src/lib/boards';

const ownerNpub = nip19.npubEncode('4'.repeat(64));
const writerNpub = nip19.npubEncode('5'.repeat(64));

function makeCard(id: string, title: string, updatedAt = 10, updatedBy = ownerNpub): BoardCard {
  return {
    id,
    title,
    description: '',
    assigneeNpubs: [],
    attachments: [],
    comments: [],
    updatedAt,
    updatedBy,
  };
}

function makeColumn(id: string, title: string, cards: BoardCard[], updatedAt = 10, updatedBy = ownerNpub): BoardColumn {
  return {
    id,
    title,
    cards,
    updatedAt,
    updatedBy,
  };
}

function makeBoard(): BoardState {
  return {
    version: 1,
    boardId: 'board-1',
    title: 'Roadmap',
    updatedAt: 10,
    updatedBy: ownerNpub,
    orderUpdatedAt: 10,
    orderUpdatedBy: ownerNpub,
    columns: [
      makeColumn('todo', 'Todo', [
        makeCard('card-a', 'Card A'),
        makeCard('card-b', 'Card B'),
      ]),
      makeColumn('done', 'Done', []),
    ],
  };
}

describe('board edit helpers', () => {
  it('adds cards without rewriting column metadata timestamps', () => {
    const board = makeBoard();
    const result = addBoardCard(board, createInitialBoardTombstones(), {
      actor: writerNpub,
      updatedAt: 100,
      columnId: 'todo',
      card: makeCard('card-c', 'Card C'),
    });

    expect(result.changed).toBe(true);
    expect(result.board.columns[0]?.updatedAt).toBe(10);
    expect(result.board.updatedAt).toBe(100);
    expect(result.board.orderUpdatedAt).toBe(100);
    expect(result.board.columns[0]?.cards.map(card => card.id)).toEqual(['card-a', 'card-b', 'card-c']);
    expect(result.board.columns[0]?.cards[2]?.updatedAt).toBe(100);
    expect(result.tombstones.entries).toEqual([]);
  });

  it('updates column titles without touching board order timestamps', () => {
    const board = makeBoard();
    const result = updateBoardColumnTitle(board, createInitialBoardTombstones(), {
      actor: writerNpub,
      updatedAt: 120,
      columnId: 'todo',
      title: 'Ideas',
    });

    expect(result.changed).toBe(true);
    expect(result.board.columns[0]?.title).toBe('Ideas');
    expect(result.board.columns[0]?.updatedAt).toBe(120);
    expect(result.board.orderUpdatedAt).toBe(10);
    expect(result.board.updatedAt).toBe(120);
  });

  it('keeps stale delete tombstones from resurrecting when a card is removed', () => {
    const board = makeBoard();
    const result = removeBoardCard(board, createInitialBoardTombstones(), {
      actor: writerNpub,
      updatedAt: 200,
      columnId: 'todo',
      cardId: 'card-a',
    });

    expect(result.changed).toBe(true);
    expect(result.board.columns[0]?.cards.map(card => card.id)).toEqual(['card-b']);
    expect(result.board.orderUpdatedAt).toBe(200);
    expect(result.tombstones.entries).toEqual([
      { path: boardCardPath('todo', 'card-a'), updatedAt: 200, updatedBy: writerNpub },
    ]);
  });

  it('moves cards across columns by tombstoning the old path and bumping the card timestamp', () => {
    const board = makeBoard();
    const result = moveBoardCard(board, createInitialBoardTombstones(), {
      actor: writerNpub,
      updatedAt: 300,
      fromColumnId: 'todo',
      cardId: 'card-a',
      toColumnId: 'done',
      beforeCardId: null,
      position: 'end',
    });

    expect(result.changed).toBe(true);
    expect(result.board.columns[0]?.cards.map(card => card.id)).toEqual(['card-b']);
    expect(result.board.columns[1]?.cards.map(card => card.id)).toEqual(['card-a']);
    expect(result.board.columns[1]?.cards[0]?.updatedAt).toBe(300);
    expect(result.board.orderUpdatedAt).toBe(300);
    expect(result.tombstones.entries).toEqual([
      { path: boardCardPath('todo', 'card-a'), updatedAt: 300, updatedBy: writerNpub },
    ]);
  });

  it('keeps same-column reorders as order-only changes', () => {
    const board = makeBoard();
    const result = moveBoardCard(board, createInitialBoardTombstones(), {
      actor: writerNpub,
      updatedAt: 400,
      fromColumnId: 'todo',
      cardId: 'card-b',
      toColumnId: 'todo',
      beforeCardId: 'card-a',
      position: 'before',
    });

    expect(result.changed).toBe(true);
    expect(result.board.columns[0]?.cards.map(card => card.id)).toEqual(['card-b', 'card-a']);
    expect(result.board.columns[0]?.cards[0]?.updatedAt).toBe(10);
    expect(result.board.orderUpdatedAt).toBe(400);
    expect(result.tombstones.entries).toEqual([]);
  });

  it('clears matching tombstones when a card is edited again', () => {
    const board = makeBoard();
    const tombstones = recordBoardPathDeletion(
      createInitialBoardTombstones(),
      boardCardPath('todo', 'card-a'),
      writerNpub,
      450,
    );

    const result = mutateBoardCard(board, tombstones, {
      actor: writerNpub,
      updatedAt: 500,
      columnId: 'todo',
      cardId: 'card-a',
      mutate(card) {
        card.title = 'Card A edited';
      },
    });

    expect(result.changed).toBe(true);
    expect(result.board.columns[0]?.cards[0]?.title).toBe('Card A edited');
    expect(result.board.columns[0]?.cards[0]?.updatedAt).toBe(500);
    expect(result.tombstones.entries).toEqual([]);
  });

  it('tombstones removed columns and every card path under them', () => {
    const board = makeBoard();
    const result = removeBoardColumn(board, createInitialBoardTombstones(), {
      actor: writerNpub,
      updatedAt: 600,
      columnId: 'todo',
    });

    expect(result.changed).toBe(true);
    expect(result.board.columns.map(column => column.id)).toEqual(['done']);
    expect(result.board.orderUpdatedAt).toBe(600);
    expect(result.tombstones.entries).toEqual([
      { path: boardCardPath('todo', 'card-a'), updatedAt: 600, updatedBy: writerNpub },
      { path: boardCardPath('todo', 'card-b'), updatedAt: 600, updatedBy: writerNpub },
      { path: boardColumnPath('todo'), updatedAt: 600, updatedBy: writerNpub },
    ]);
  });

  it('reorders columns without creating tombstones', () => {
    const board = makeBoard();
    const withExtra = addBoardColumn(board, createInitialBoardTombstones(), {
      actor: writerNpub,
      updatedAt: 700,
      columnId: 'later',
      title: 'Later',
    });

    const moved = moveBoardColumn(withExtra.board, withExtra.tombstones, {
      actor: writerNpub,
      updatedAt: 710,
      fromColumnId: 'later',
      toColumnId: 'todo',
      position: 'before',
    });

    expect(moved.changed).toBe(true);
    expect(moved.board.columns.map(column => column.id)).toEqual(['later', 'todo', 'done']);
    expect(moved.board.orderUpdatedAt).toBe(710);
    expect(moved.tombstones.entries).toEqual([]);
  });
});
