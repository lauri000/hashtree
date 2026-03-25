import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const videoViewPath = path.resolve(process.cwd(), 'src/components/Video/VideoView.svelte');
const videoViewSource = fs.readFileSync(videoViewPath, 'utf8');

describe('video view title fallback wiring', () => {
  it('uses the shared display title helper instead of raw playlist folder ids', () => {
    expect(videoViewSource).toContain("import { getVideoDisplayTitle } from '../../lib/videoDisplayTitle';");
    expect(videoViewSource).toContain("let title = $derived(getVideoDisplayTitle({");
    expect(videoViewSource).toContain('label: getVideoDisplayTitle({');
  });
});
