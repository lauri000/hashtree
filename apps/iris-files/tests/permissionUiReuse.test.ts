import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const componentsRoot = path.resolve(process.cwd(), 'src', 'components');
const boardViewSource = fs.readFileSync(path.join(componentsRoot, 'Boards', 'BoardView.svelte'), 'utf8');
const collaboratorsModalSource = fs.readFileSync(path.join(componentsRoot, 'Modals', 'CollaboratorsModal.svelte'), 'utf8');
const accessModalSource = fs.readFileSync(path.join(componentsRoot, 'Modals', 'NpubAccessModal.svelte'), 'utf8');
const userIndexSource = fs.readFileSync(path.join(componentsRoot, 'User', 'index.ts'), 'utf8');

describe('permission UI reuse', () => {
  it('reuses the shared npub row component across boards and collaborators', () => {
    expect(userIndexSource).toContain("export { default as NpubRow } from './NpubRow.svelte';");
    expect(accessModalSource).toContain('NpubRow');
    expect(accessModalSource).toContain('<NpubRow npub={npub}');
    expect(accessModalSource).toContain('<NpubRow npub={pendingNpub}');
  });

  it('routes boards and collaborators through the shared access modal', () => {
    expect(boardViewSource).toContain('NpubAccessModal');
    expect(boardViewSource).toContain('<NpubAccessModal');
    expect(collaboratorsModalSource).toContain('NpubAccessModal');
    expect(collaboratorsModalSource).toContain('<NpubAccessModal');
  });
});
