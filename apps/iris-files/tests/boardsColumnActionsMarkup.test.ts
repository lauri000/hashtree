import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const boardViewPath = path.resolve(process.cwd(), 'src/components/Boards/BoardView.svelte');
const boardViewSource = fs.readFileSync(boardViewPath, 'utf8');

describe('boards column action markup', () => {
  it('renders edit column button with hover-reveal behavior', () => {
    expect(boardViewSource).toMatch(
      /<button[\s\S]*class="[^"]*opacity-0[^"]*group-hover:opacity-100[^"]*"[\s\S]*aria-label="Edit column"/
    );
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
