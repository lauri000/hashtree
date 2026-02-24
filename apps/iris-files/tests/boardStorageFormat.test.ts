import { describe, it, expect } from 'vitest';
import {
  parseCardData,
  parseBoardMeta,
  parseBoardOrder,
  parseColumnMeta,
  serializeBoardMeta,
  serializeBoardOrder,
  serializeCardData,
  serializeColumnMeta,
  type BoardState,
} from '../src/lib/boards/state';
import {
  createInitialBoardPermissions,
  parseBoardPermissions,
  serializeBoardPermissions,
} from '../src/lib/boards/permissions';
import { nip19 } from 'nostr-tools';

const ownerNpub = nip19.npubEncode('a'.repeat(64));

function sampleBoard(): BoardState {
  return {
    version: 1,
    boardId: 'board-1',
    title: 'Roadmap',
    updatedAt: 1700000000000,
    updatedBy: ownerNpub,
    columns: [
      {
        id: 'todo-col',
        title: 'Todo',
        cards: [
          { id: 'card-a', title: 'Card A', description: 'first', assigneeNpubs: [], attachments: [], comments: [] },
          { id: 'card-b', title: 'Card B', description: 'second', assigneeNpubs: [ownerNpub], attachments: [], comments: [] },
        ],
      },
      {
        id: 'done-col',
        title: 'Done',
        cards: [
          { id: 'card-c', title: 'Card C', description: 'third', assigneeNpubs: [], attachments: [], comments: [] },
        ],
      },
    ],
  };
}

describe('board storage format', () => {
  it('serializes and parses board metadata json', () => {
    const board = sampleBoard();
    const json = serializeBoardMeta(board);
    const parsed = parseBoardMeta(json, 'fallback-id', 'Fallback', ownerNpub);
    expect(parsed).not.toBeNull();
    expect(parsed?.boardId).toBe(board.boardId);
    expect(parsed?.title).toBe(board.title);
    expect(parsed?.updatedAt).toBe(board.updatedAt);
    expect(parsed?.updatedBy).toBe(board.updatedBy);
  });

  it('serializes and parses board order json', () => {
    const orderJson = serializeBoardOrder(sampleBoard());
    const order = parseBoardOrder(orderJson);
    expect(order.columns).toEqual(['todo-col', 'done-col']);
    expect(order.cardsByColumn['todo-col']).toEqual(['card-a', 'card-b']);
    expect(order.cardsByColumn['done-col']).toEqual(['card-c']);
  });

  it('serializes and parses column metadata json', () => {
    const raw = serializeColumnMeta({ id: 'doing-col', title: 'Doing', cards: [] });
    const parsed = parseColumnMeta(raw, 'fallback-col');
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('doing-col');
    expect(parsed?.title).toBe('Doing');
  });

  it('parses json metadata from ArrayBuffer payloads', () => {
    const raw = serializeColumnMeta({ id: 'todo-col', title: 'Todo', cards: [] });
    const buffer = new TextEncoder().encode(raw).buffer;
    const parsed = parseColumnMeta(buffer, 'fallback-col');
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('todo-col');
    expect(parsed?.title).toBe('Todo');
  });

  it('serializes and parses card json', () => {
    const raw = serializeCardData({
      id: 'card-1',
      title: 'Ship it',
      description: 'Move to production\nwithout downtime.',
      assigneeNpubs: [ownerNpub],
      attachments: [
        {
          id: 'a-1',
          fileName: 'a-1-spec.png',
          displayName: 'spec.png',
          mimeType: 'image/png',
          size: 1024,
          uploaderNpub: ownerNpub,
          cidHash: 'ab'.repeat(32),
          cidKey: 'cd'.repeat(32),
        },
      ],
      comments: [
        {
          id: 'comment-1',
          authorNpub: ownerNpub,
          markdown: '**Looks good**',
          createdAt: 1700000000100,
          updatedAt: 1700000000100,
          attachments: [],
        },
      ],
    });
    const parsed = parseCardData(raw, 'card-1');
    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe('Ship it');
    expect(parsed?.description).toContain('without downtime.');
    expect(parsed?.assigneeNpubs).toEqual([ownerNpub]);
    expect(parsed?.attachments).toHaveLength(1);
    expect(parsed?.attachments[0].displayName).toBe('spec.png');
    expect(parsed?.comments).toHaveLength(1);
    expect(parsed?.comments[0].markdown).toContain('Looks good');
  });

  it('serializes and parses board permissions json', () => {
    const permissions = createInitialBoardPermissions('board-1', 'Roadmap', ownerNpub, 123);
    const raw = serializeBoardPermissions({
      ...permissions,
      writers: [nip19.npubEncode('b'.repeat(64))],
    });
    const parsed = parseBoardPermissions(raw, ownerNpub);
    expect(parsed).not.toBeNull();
    expect(parsed?.admins).toEqual([ownerNpub]);
    expect(parsed?.writers.length).toBe(1);
  });
});
