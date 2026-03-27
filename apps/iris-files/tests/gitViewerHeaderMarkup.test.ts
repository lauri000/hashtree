import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'src');
const directoryActionsSource = fs.readFileSync(path.join(root, 'components', 'Viewer', 'DirectoryActions.svelte'), 'utf8');
const gitRepoViewSource = fs.readFileSync(path.join(root, 'components', 'Git', 'GitRepoView.svelte'), 'utf8');

describe('git viewer header markup', () => {
  it('renders repo identity and folder actions in the same wrapping repo header row', () => {
    expect(gitRepoViewSource).toContain('data-testid="repo-header-row"');
    expect(gitRepoViewSource).toContain('<FolderActions {dirCid} {canEdit} />');
    expect(gitRepoViewSource).toContain('<Avatar pubkey={ownerPubkey} size={20} showBadge={true} />');
    expect(gitRepoViewSource).toContain('<Name pubkey={ownerPubkey}');
    expect(gitRepoViewSource).toContain('<span class="shrink-0 text-text-3">/</span>');
    expect(gitRepoViewSource).toContain('justify-between');
    expect(gitRepoViewSource).toContain('href={repoRootHref}');
    expect(gitRepoViewSource).not.toContain('data-testid="viewer-context"');
  });

  it('lets git repo view own the combined header row instead of rendering a separate viewer header above tabs', () => {
    expect(directoryActionsSource).toContain('<GitRepoView');
    expect(directoryActionsSource).not.toContain('showOwnerIdentity={true}');
    expect(directoryActionsSource).not.toContain('{#snippet actions()}');
  });
});
