import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const boardViewPath = path.resolve(process.cwd(), 'src/components/Boards/BoardView.svelte');
const boardViewSource = fs.readFileSync(boardViewPath, 'utf8');

describe('boards comment form markup', () => {
  it('uses Add comment placeholder and no top comment label text', () => {
    expect(boardViewSource).toContain('placeholder="Add comment."');
    expect(boardViewSource).not.toContain('for="board-card-comment-markdown">Add comment</label>');
  });

  it('renders textarea action buttons inside the textarea container', () => {
    expect(boardViewSource).toContain('pb-14');
    expect(boardViewSource).toContain('absolute inset-x-0 bottom-0');
  });
});
