import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const sidebarPath = path.resolve(process.cwd(), 'src/components/Video/PlaylistSidebar.svelte');
const sidebarSource = fs.readFileSync(sidebarPath, 'utf8');
const playlistStorePath = path.resolve(process.cwd(), 'src/stores/playlist.ts');
const playlistStoreSource = fs.readFileSync(playlistStorePath, 'utf8');

describe('playlist sidebar loading title markup', () => {
  it('renders a skeleton title while metadata is loading', () => {
    expect(sidebarSource).toContain('{#if item.title}');
    expect(sidebarSource).toContain('animate-pulse');
  });

  it('does not seed playlist items with synthetic folder ids as visible titles', () => {
    expect(playlistStoreSource).toContain('getInitialPlaylistItemTitle(entry.name)');
  });
});
