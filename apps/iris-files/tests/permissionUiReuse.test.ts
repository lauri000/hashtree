import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const componentsRoot = path.resolve(process.cwd(), 'src', 'components');
const boardViewSource = fs.readFileSync(path.join(componentsRoot, 'Boards', 'BoardView.svelte'), 'utf8');
const collaboratorsModalSource = fs.readFileSync(path.join(componentsRoot, 'Modals', 'CollaboratorsModal.svelte'), 'utf8');
const userIndexSource = fs.readFileSync(path.join(componentsRoot, 'User', 'index.ts'), 'utf8');

describe('permission UI identity rows', () => {
  it('reuses the shared npub row component across boards and collaborators', () => {
    expect(userIndexSource).toContain("export { default as NpubRow } from './NpubRow.svelte';");
    expect(boardViewSource).toContain('NpubRow');
    expect(boardViewSource).toContain('<NpubRow npub={adminNpub}');
    expect(boardViewSource).toContain('<NpubRow npub={writerNpub}');
    expect(collaboratorsModalSource).toContain('NpubRow');
    expect(collaboratorsModalSource).toContain('<NpubRow npub={npub}');
    expect(collaboratorsModalSource).toContain('<NpubRow npub={pendingNpub}');
  });
});
