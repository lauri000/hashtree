import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import type { BoardPermissions } from '../src/lib/boards/permissions';
import type { BoardCard, BoardColumn, BoardState } from '../src/lib/boards/state';
import {
  boardCardPath,
  createInitialBoardTombstones,
  mergeBoardSnapshots,
  recordBoardPathDeletion,
  type BoardMergeSource,
} from '../src/lib/boards';

const ownerNpub = nip19.npubEncode('1'.repeat(64));
const writerANpub = nip19.npubEncode('2'.repeat(64));
const writerBNpub = nip19.npubEncode('3'.repeat(64));

function makeCard(id: string, title: string, updatedAt: number, updatedBy: string): BoardCard {
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

function makeColumn(id: string, title: string, updatedAt: number, updatedBy: string, cards: BoardCard[]): BoardColumn {
  return {
    id,
    title,
    cards,
    updatedAt,
    updatedBy,
  };
}

function makeBoard(overrides: Partial<BoardState> = {}): BoardState {
  return {
    version: 1,
    boardId: 'board-1',
    title: 'Roadmap',
    updatedAt: 10,
    updatedBy: ownerNpub,
    orderUpdatedAt: 10,
    orderUpdatedBy: ownerNpub,
    columns: [
      makeColumn('todo', 'Todo', 10, ownerNpub, [
        makeCard('card-a', 'Card A', 10, ownerNpub),
        makeCard('card-b', 'Card B', 10, ownerNpub),
      ]),
      makeColumn('done', 'Done', 10, ownerNpub, []),
    ],
    ...overrides,
  };
}

function makePermissions(updatedAt = 10, updatedBy = ownerNpub): BoardPermissions {
  return {
    version: 1,
    boardId: 'board-1',
    title: 'Roadmap',
    admins: [ownerNpub],
    writers: [writerANpub, writerBNpub],
    updatedAt,
    updatedBy,
  };
}

function source(source: string, board: BoardState, permissions = makePermissions(), tombstones = createInitialBoardTombstones()): BoardMergeSource {
  return { source, board, permissions, tombstones };
}

describe('board multiuser merge', () => {
  it('keeps independent card edits from different writers', () => {
    const base = makeBoard();

    const writerA = makeBoard({
      updatedAt: 100,
      updatedBy: writerANpub,
      columns: [
        makeColumn('todo', 'Todo', 10, ownerNpub, [
          makeCard('card-a', 'Card A from writer A', 100, writerANpub),
          makeCard('card-b', 'Card B', 10, ownerNpub),
        ]),
        makeColumn('done', 'Done', 10, ownerNpub, []),
      ],
    });

    const writerB = makeBoard({
      updatedAt: 120,
      updatedBy: writerBNpub,
      columns: [
        makeColumn('todo', 'Todo', 10, ownerNpub, [
          makeCard('card-a', 'Card A', 10, ownerNpub),
          makeCard('card-b', 'Card B from writer B', 120, writerBNpub),
        ]),
        makeColumn('done', 'Done', 10, ownerNpub, []),
      ],
    });

    const merged = mergeBoardSnapshots(
      [source('base', base), source('writer-a', writerA), source('writer-b', writerB)],
      { ownerNpub, fallbackBoardId: 'fallback-board', fallbackTitle: 'Fallback' },
    );

    expect(merged.board?.columns[0].cards.map((card) => card.title)).toEqual([
      'Card A from writer A',
      'Card B from writer B',
    ]);
    expect(merged.board?.updatedAt).toBe(120);
  });

  it('keeps a newer order change while still merging a newer card edit', () => {
    const moved = makeBoard({
      updatedAt: 200,
      updatedBy: writerANpub,
      orderUpdatedAt: 200,
      orderUpdatedBy: writerANpub,
      columns: [
        makeColumn('todo', 'Todo', 10, ownerNpub, [
          makeCard('card-b', 'Card B', 10, ownerNpub),
          makeCard('card-a', 'Card A', 10, ownerNpub),
        ]),
        makeColumn('done', 'Done', 10, ownerNpub, []),
      ],
    });

    const edited = makeBoard({
      updatedAt: 300,
      updatedBy: writerBNpub,
      orderUpdatedAt: 10,
      orderUpdatedBy: ownerNpub,
      columns: [
        makeColumn('todo', 'Todo', 10, ownerNpub, [
          makeCard('card-a', 'Card A edited', 300, writerBNpub),
          makeCard('card-b', 'Card B', 10, ownerNpub),
        ]),
        makeColumn('done', 'Done', 10, ownerNpub, []),
      ],
    });

    const merged = mergeBoardSnapshots(
      [source('moved', moved), source('edited', edited)],
      { ownerNpub, fallbackBoardId: 'fallback-board', fallbackTitle: 'Fallback' },
    );

    expect(merged.board?.columns[0].cards.map((card) => card.id)).toEqual(['card-b', 'card-a']);
    expect(merged.board?.columns[0].cards.find((card) => card.id === 'card-a')?.title).toBe('Card A edited');
  });

  it('keeps newer column metadata while still merging later card additions', () => {
    const renamed = makeBoard({
      updatedAt: 100,
      updatedBy: writerANpub,
      columns: [
        makeColumn('todo', 'Ideas', 100, writerANpub, [
          makeCard('card-a', 'Card A', 10, ownerNpub),
          makeCard('card-b', 'Card B', 10, ownerNpub),
        ]),
        makeColumn('done', 'Done', 10, ownerNpub, []),
      ],
    });

    const addedCard = makeBoard({
      updatedAt: 120,
      updatedBy: writerBNpub,
      orderUpdatedAt: 120,
      orderUpdatedBy: writerBNpub,
      columns: [
        makeColumn('todo', 'Todo', 10, ownerNpub, [
          makeCard('card-a', 'Card A', 10, ownerNpub),
          makeCard('card-b', 'Card B', 10, ownerNpub),
          makeCard('card-c', 'Card C', 120, writerBNpub),
        ]),
        makeColumn('done', 'Done', 10, ownerNpub, []),
      ],
    });

    const merged = mergeBoardSnapshots(
      [source('renamed', renamed), source('added-card', addedCard)],
      { ownerNpub, fallbackBoardId: 'fallback-board', fallbackTitle: 'Fallback' },
    );

    expect(merged.board?.columns[0]?.title).toBe('Ideas');
    expect(merged.board?.columns[0]?.cards.map((card) => card.id)).toEqual(['card-a', 'card-b', 'card-c']);
  });

  it('keeps explicit tombstones so deleted cards stay deleted', () => {
    const stale = makeBoard();
    const tombstones = recordBoardPathDeletion(
      createInitialBoardTombstones(),
      boardCardPath('todo', 'card-a'),
      writerANpub,
      400,
    );
    const deleted = makeBoard({
      updatedAt: 400,
      updatedBy: writerANpub,
      orderUpdatedAt: 400,
      orderUpdatedBy: writerANpub,
      columns: [
        makeColumn('todo', 'Todo', 10, ownerNpub, [
          makeCard('card-b', 'Card B', 10, ownerNpub),
        ]),
        makeColumn('done', 'Done', 10, ownerNpub, []),
      ],
    });

    const merged = mergeBoardSnapshots(
      [source('stale', stale), source('deleted', deleted, makePermissions(), tombstones)],
      { ownerNpub, fallbackBoardId: 'fallback-board', fallbackTitle: 'Fallback' },
    );

    expect(merged.board?.columns[0].cards.map((card) => card.id)).toEqual(['card-b']);
    expect(merged.tombstones.entries.map((entry) => entry.path)).toContain(boardCardPath('todo', 'card-a'));
  });

  it('deduplicates moved cards by card id and keeps the newer location', () => {
    const movedTombstones = recordBoardPathDeletion(
      createInitialBoardTombstones(),
      boardCardPath('todo', 'card-a'),
      writerANpub,
      500,
    );

    const moved = makeBoard({
      updatedAt: 500,
      updatedBy: writerANpub,
      orderUpdatedAt: 500,
      orderUpdatedBy: writerANpub,
      columns: [
        makeColumn('todo', 'Todo', 10, ownerNpub, [
          makeCard('card-b', 'Card B', 10, ownerNpub),
        ]),
        makeColumn('done', 'Done', 10, ownerNpub, [
          makeCard('card-a', 'Card A moved', 500, writerANpub),
        ]),
      ],
    });

    const staleEdit = makeBoard({
      updatedAt: 450,
      updatedBy: writerBNpub,
      columns: [
        makeColumn('todo', 'Todo', 10, ownerNpub, [
          makeCard('card-a', 'Card A stale edit', 450, writerBNpub),
          makeCard('card-b', 'Card B', 10, ownerNpub),
        ]),
        makeColumn('done', 'Done', 10, ownerNpub, []),
      ],
    });

    const merged = mergeBoardSnapshots(
      [source('moved', moved, makePermissions(), movedTombstones), source('stale-edit', staleEdit)],
      { ownerNpub, fallbackBoardId: 'fallback-board', fallbackTitle: 'Fallback' },
    );

    expect(merged.board?.columns[0].cards.map((card) => card.id)).toEqual(['card-b']);
    expect(merged.board?.columns[1].cards.map((card) => card.id)).toEqual(['card-a']);
    expect(merged.board?.columns[1].cards[0]?.title).toBe('Card A moved');
  });
});
