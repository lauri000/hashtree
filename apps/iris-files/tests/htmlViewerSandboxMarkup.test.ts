import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'src');
const htmlViewerSource = fs.readFileSync(path.join(root, 'components', 'Viewer', 'HtmlViewer.svelte'), 'utf8');

describe('html viewer sandbox markup', () => {
  it('keeps HTML preview in a locked-down sandbox instead of emulating an app runtime', () => {
    expect(htmlViewerSource).toContain('sandbox=""');
    expect(htmlViewerSource).not.toContain('allow-scripts');
    expect(htmlViewerSource).not.toContain('allow-forms');
    expect(htmlViewerSource).not.toContain('serviceWorker');
    expect(htmlViewerSource).not.toContain('indexedDB');
    expect(htmlViewerSource).not.toContain('localStorage');
    expect(htmlViewerSource).toContain("script-src 'none'");
  });

  it('keeps the preview copy focused on the sandbox instead of acting like the site launcher', () => {
    expect(htmlViewerSource).toContain('Secure preview only.');
    expect(htmlViewerSource).not.toContain('Open Isolated Site');
  });
});
