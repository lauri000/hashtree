import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import {
  addBoardPermission,
  canManageBoard,
  canWriteBoard,
  createInitialBoardPermissions,
  parseBoardPermissions,
  removeBoardPermission,
  type BoardPermissions,
} from '../src/lib/boards/permissions';

const ownerNpub = nip19.npubEncode('1'.repeat(64));
const adminNpub = nip19.npubEncode('2'.repeat(64));
const writerNpub = nip19.npubEncode('3'.repeat(64));
const outsiderNpub = nip19.npubEncode('4'.repeat(64));

function makePermissions(): BoardPermissions {
  return createInitialBoardPermissions('board-1', 'Roadmap', ownerNpub, 1234);
}

describe('board permissions', () => {
  it('creates initial permissions with owner as sole admin', () => {
    const permissions = makePermissions();

    expect(permissions.version).toBe(1);
    expect(permissions.admins).toEqual([ownerNpub]);
    expect(permissions.writers).toEqual([]);
  });

  it('parses and normalizes persisted permissions', () => {
    const raw = JSON.stringify({
      version: 1,
      boardId: 'board-1',
      title: 'Roadmap',
      updatedAt: 777,
      updatedBy: adminNpub,
      admins: [ownerNpub, adminNpub, ownerNpub, 'not-an-npub'],
      writers: [writerNpub, adminNpub, ownerNpub, 'npub1invalid'],
    });

    const parsed = parseBoardPermissions(raw, ownerNpub);
    expect(parsed).not.toBeNull();
    expect(parsed?.admins).toEqual([ownerNpub, adminNpub]);
    expect(parsed?.writers).toEqual([writerNpub]);
  });

  it('parses persisted permissions from ArrayBuffer payload', () => {
    const raw = JSON.stringify({
      version: 1,
      boardId: 'board-1',
      title: 'Roadmap',
      updatedAt: 777,
      updatedBy: adminNpub,
      admins: [ownerNpub, adminNpub],
      writers: [writerNpub],
    });
    const payload = new TextEncoder().encode(raw).buffer;
    const parsed = parseBoardPermissions(payload, ownerNpub);
    expect(parsed).not.toBeNull();
    expect(parsed?.admins).toEqual([ownerNpub, adminNpub]);
    expect(parsed?.writers).toEqual([writerNpub]);
  });

  it('assigns and revokes roles deterministically', () => {
    let permissions = makePermissions();

    permissions = addBoardPermission(permissions, 'writer', writerNpub, adminNpub, 2000);
    expect(permissions.writers).toEqual([writerNpub]);

    permissions = addBoardPermission(permissions, 'admin', writerNpub, adminNpub, 3000);
    expect(permissions.admins).toEqual([ownerNpub, writerNpub]);
    expect(permissions.writers).toEqual([]);

    permissions = removeBoardPermission(permissions, 'admin', writerNpub, ownerNpub, 4000);
    expect(permissions.admins).toEqual([ownerNpub]);

    // Cannot remove the last admin
    const blocked = removeBoardPermission(permissions, 'admin', ownerNpub, ownerNpub, 5000);
    expect(blocked.admins).toEqual([ownerNpub]);
  });

  it('computes manage/write access correctly', () => {
    let permissions = makePermissions();
    permissions = addBoardPermission(permissions, 'admin', adminNpub, ownerNpub, 2000);
    permissions = addBoardPermission(permissions, 'writer', writerNpub, ownerNpub, 3000);

    expect(canManageBoard(permissions, ownerNpub, ownerNpub)).toBe(true);
    expect(canManageBoard(permissions, adminNpub, ownerNpub)).toBe(true);
    expect(canManageBoard(permissions, writerNpub, ownerNpub)).toBe(false);

    expect(canWriteBoard(permissions, ownerNpub, ownerNpub)).toBe(true);
    expect(canWriteBoard(permissions, adminNpub, ownerNpub)).toBe(true);
    expect(canWriteBoard(permissions, writerNpub, ownerNpub)).toBe(true);
    expect(canWriteBoard(permissions, outsiderNpub, ownerNpub)).toBe(false);
  });
});
