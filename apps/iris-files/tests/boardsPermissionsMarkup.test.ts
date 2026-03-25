import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const boardViewPath = path.resolve(process.cwd(), 'src/components/Boards/BoardView.svelte');
const boardViewSource = fs.readFileSync(boardViewPath, 'utf8');

describe('boards permissions modal markup', () => {
  it('renders visibility controls in the permissions modal', () => {
    expect(boardViewSource).toContain('<VisibilityPicker value={visibilityDraft}');
    expect(boardViewSource).toContain('Update Visibility');
  });

  it('explains that only the owner can change visibility on shared boards', () => {
    expect(boardViewSource).toContain('Only the board owner can change visibility for the shared board link.');
  });
});
