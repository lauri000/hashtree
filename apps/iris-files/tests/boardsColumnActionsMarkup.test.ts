import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const boardViewPath = path.resolve(process.cwd(), 'src/components/Boards/BoardView.svelte');
const boardViewSource = fs.readFileSync(boardViewPath, 'utf8');

describe('boards column action markup', () => {
  it('uses separate hover scopes for columns and cards', () => {
    expect(boardViewSource).toContain('board-column-hover');
    expect(boardViewSource).toContain('board-column-action');
    expect(boardViewSource).toContain('board-card-hover');
    expect(boardViewSource).toContain('board-card-action');
    expect(boardViewSource).not.toContain('group-hover:opacity-100');
    expect(boardViewSource).not.toContain('group-focus-within:opacity-100');
  });

  it('does not render a remove column button in the column header', () => {
    expect(boardViewSource).not.toContain('aria-label="Remove column"');
    expect(boardViewSource).not.toContain('title="Remove column"');
  });

  it('shows a delete column action inside the edit column modal', () => {
    expect(boardViewSource).toMatch(
      /\{#if columnModalMode === 'edit'\}[\s\S]*Delete column[\s\S]*\{\/if\}/
    );
  });
});
