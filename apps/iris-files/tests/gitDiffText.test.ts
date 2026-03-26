import { describe, expect, it } from 'vitest';
import { buildUnifiedDiff } from '../src/utils/gitDiffText';

describe('buildUnifiedDiff', () => {
  it('renders added files as unified diffs with stats', () => {
    const result = buildUnifiedDiff([
      {
        path: 'README.md',
        status: 'added',
        newText: 'hello\nworld\n',
      },
    ]);

    expect(result.text).toContain('diff --git a/README.md b/README.md');
    expect(result.text).toContain('new file mode 100644');
    expect(result.text).toContain('@@ -0,0 +1,2 @@');
    expect(result.text).toContain('+hello');
    expect(result.text).toContain('+world');
    expect(result.stats).toEqual({ additions: 2, deletions: 0, files: 1 });
  });

  it('renders modified files as unified diffs with stats', () => {
    const result = buildUnifiedDiff([
      {
        path: 'src/app.ts',
        status: 'modified',
        oldText: 'one\ntwo\nthree\n',
        newText: 'one\nTWO\nthree\nfour\n',
      },
    ]);

    expect(result.text).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(result.text).toContain('@@ -1,3 +1,4 @@');
    expect(result.text).toContain('-two');
    expect(result.text).toContain('+TWO');
    expect(result.text).toContain('+four');
    expect(result.stats).toEqual({ additions: 2, deletions: 1, files: 1 });
  });

  it('limits modified diffs to hunks around changed lines', () => {
    const oldText = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    const newLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    newLines[1] = 'LINE 2';
    newLines[9] = 'LINE 10';
    const newText = newLines.join('\n') + '\n';

    const result = buildUnifiedDiff([
      {
        path: 'src/chunked.ts',
        status: 'modified',
        oldText,
        newText,
      },
    ]);

    expect(result.text).toContain('@@ -1,5 +1,5 @@');
    expect(result.text).toContain('@@ -7,6 +7,6 @@');
    expect(result.text).toContain('-line 2');
    expect(result.text).toContain('+LINE 2');
    expect(result.text).toContain('-line 10');
    expect(result.text).toContain('+LINE 10');
    expect(result.text).not.toContain('\n line 6\n');
    expect(result.stats).toEqual({ additions: 2, deletions: 2, files: 1 });
  });

  it('renders deleted files as unified diffs with stats', () => {
    const result = buildUnifiedDiff([
      {
        path: 'docs/old.md',
        status: 'deleted',
        oldText: 'legacy\ncopy\n',
      },
    ]);

    expect(result.text).toContain('diff --git a/docs/old.md b/docs/old.md');
    expect(result.text).toContain('deleted file mode 100644');
    expect(result.text).toContain('@@ -1,2 +0,0 @@');
    expect(result.text).toContain('-legacy');
    expect(result.text).toContain('-copy');
    expect(result.stats).toEqual({ additions: 0, deletions: 2, files: 1 });
  });

  it('falls back to a binary notice for non-text changes', () => {
    const result = buildUnifiedDiff([
      {
        path: 'image.png',
        status: 'modified',
        oldBytes: new Uint8Array([0, 255, 1, 2]),
        newBytes: new Uint8Array([0, 255, 1, 3]),
      },
    ]);

    expect(result.text).toContain('diff --git a/image.png b/image.png');
    expect(result.text).toContain('Binary files a/image.png and b/image.png differ');
    expect(result.stats).toEqual({ additions: 0, deletions: 0, files: 1 });
  });
});
