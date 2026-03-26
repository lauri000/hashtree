import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const boardViewPath = path.resolve(process.cwd(), 'src/components/Boards/BoardView.svelte');
const boardViewSource = fs.readFileSync(boardViewPath, 'utf8');

describe('boards header markup', () => {
  it('renders a linked owner identity row ahead of the board title', () => {
    expect(boardViewSource).toContain("href={`#/${ownerNpub}/profile`}");
    expect(boardViewSource).toContain('aria-label="View board owner profile"');
    expect(boardViewSource).toContain('<Avatar pubkey={ownerPubkey} size={20} showBadge');
    expect(boardViewSource).toContain('<Name pubkey={ownerPubkey}');
  });
});
