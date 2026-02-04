import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { getPublicKey } from 'nostr-tools';

import { fromBinary } from '../src/SocialGraphBinary';

const rootSk = '01'.repeat(32);
const bobSk = '02'.repeat(32);
const carolSk = '03'.repeat(32);
const daveSk = '04'.repeat(32);

const rootPk = getPublicKey(rootSk);
const bobPk = getPublicKey(bobSk);
const carolPk = getPublicKey(carolSk);
const davePk = getPublicKey(daveSk);

const rootFollowTs = 1_700_000_111;
const bobFollowTs = 1_700_000_222;
const rootMuteTs = 1_700_000_333;

describe('Rust snapshot interop', () => {
  it('loads rust-generated binary snapshot with timestamps', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const cargoRoot = path.join(repoRoot, 'rust');
    const outDir = mkdtempSync(path.join(tmpdir(), 'htree-sg-'));
    const outFile = path.join(outDir, 'socialgraph.bin');

    execFileSync(
      'cargo',
      ['run', '-p', 'hashtree-cli', '--bin', 'socialgraph-snapshot-fixture', '--', outFile],
      { cwd: cargoRoot, stdio: 'inherit' }
    );

    const data = new Uint8Array(readFileSync(outFile));
    const graph = await fromBinary(rootPk, data);

    expect(graph.isFollowing(rootPk, bobPk)).toBe(true);
    expect(graph.isFollowing(bobPk, carolPk)).toBe(true);
    expect(graph.getMutedByUser(rootPk)).toContain(davePk);

    expect(graph.getFollowListCreatedAt(rootPk)).toBe(rootFollowTs);
    const internal = graph.getInternalData();
    const rootId = internal.ids.id(rootPk);
    expect(internal.muteListCreatedAt.get(rootId)).toBe(rootMuteTs);

    // Sanity check that bob's follow timestamp came through
    expect(graph.getFollowListCreatedAt(bobPk)).toBe(bobFollowTs);
  }, 120000);
});
