import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const boardViewPath = path.resolve(process.cwd(), 'src/components/Boards/BoardView.svelte');
const boardViewSource = fs.readFileSync(boardViewPath, 'utf8');

describe('boards column drag markup', () => {
  it('wires draggable column sections to the column reorder handlers', () => {
    expect(boardViewSource).toContain('function handleColumnDragStart(event: DragEvent, columnId: string)');
    expect(boardViewSource).toContain('function handleColumnReorderDrop(event: DragEvent, columnId: string)');
    expect(boardViewSource).toMatch(
      /<section[\s\S]*draggable=\{canWrite\}[\s\S]*ondragstart=\{\(event\) => handleColumnDragStart\(event as DragEvent, column\.id\)\}[\s\S]*ondrop=\{\(event\) => handleColumnReorderDrop\(event as DragEvent, column\.id\)\}/
    );
  });

  it('guards column drags from card drag events and preserves card identifiers', () => {
    expect(boardViewSource).toContain("if (target.closest('[data-card-id]')) return;");
    expect(boardViewSource).toContain('data-card-id={card.id}');
  });

  it('focuses the card title input when the card modal opens', () => {
    expect(boardViewSource).toContain('let cardTitleInputRef = $state<HTMLInputElement | null>(null);');
    expect(boardViewSource).toContain('if (showCardModal && cardTitleInputRef) {');
    expect(boardViewSource).toContain('cardTitleInputRef.focus();');
    expect(boardViewSource).toContain('cardTitleInputRef.select();');
    expect(boardViewSource).toContain('bind:this={cardTitleInputRef}');
  });
});
