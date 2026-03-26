import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoProfileViewPath = path.resolve(process.cwd(), 'src/components/Video/VideoProfileView.svelte');
const videoProfileViewSource = fs.readFileSync(videoProfileViewPath, 'utf8');

describe('video profile scheduling', () => {
  it('does not batch video tree inspection behind a fixed frontend concurrency window', () => {
    expect(videoProfileViewSource).not.toContain('const CONCURRENCY = 4;');
    expect(videoProfileViewSource).not.toContain('for (let i = 0; i < treesToCheck.length; i += CONCURRENCY)');
    expect(videoProfileViewSource).toContain('await Promise.allSettled(treesToCheck.map(processTree));');
  });
});
