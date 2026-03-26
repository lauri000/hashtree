export interface UnifiedDiffFile {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  oldText?: string;
  newText?: string;
  oldBytes?: Uint8Array;
  newBytes?: Uint8Array;
  oldMode?: string;
  newMode?: string;
}

export interface UnifiedDiffStats {
  additions: number;
  deletions: number;
  files: number;
}

export interface UnifiedDiffResult {
  text: string;
  stats: UnifiedDiffStats;
}

type DiffOp =
  | { type: 'context'; line: string }
  | { type: 'add'; line: string }
  | { type: 'remove'; line: string };

const DEFAULT_FILE_MODE = '100644';
const MAX_LCS_CELLS = 200_000;

export function buildUnifiedDiff(files: UnifiedDiffFile[]): UnifiedDiffResult {
  const parts: string[] = [];
  const stats: UnifiedDiffStats = {
    additions: 0,
    deletions: 0,
    files: files.length,
  };

  for (const file of files) {
    parts.push(renderFileDiff(file, stats));
  }

  return {
    text: parts.filter(Boolean).join('\n'),
    stats,
  };
}

function renderFileDiff(file: UnifiedDiffFile, stats: UnifiedDiffStats): string {
  const oldMode = file.oldMode ?? DEFAULT_FILE_MODE;
  const newMode = file.newMode ?? DEFAULT_FILE_MODE;

  if (file.status === 'added') {
    if (file.newText === undefined) {
      return renderBinaryDiff(file.path, 'added');
    }
    const newLines = splitLines(file.newText);
    stats.additions += newLines.length;
    return [
      `diff --git a/${file.path} b/${file.path}`,
      `new file mode ${newMode}`,
      '--- /dev/null',
      `+++ b/${file.path}`,
      renderHunk([], newLines),
    ].join('\n');
  }

  if (file.status === 'deleted') {
    if (file.oldText === undefined) {
      return renderBinaryDiff(file.path, 'deleted');
    }
    const oldLines = splitLines(file.oldText);
    stats.deletions += oldLines.length;
    return [
      `diff --git a/${file.path} b/${file.path}`,
      `deleted file mode ${oldMode}`,
      `--- a/${file.path}`,
      '+++ /dev/null',
      renderHunk(oldLines, []),
    ].join('\n');
  }

  if (file.oldText === undefined || file.newText === undefined) {
    return renderBinaryDiff(file.path, 'modified');
  }

  const oldLines = splitLines(file.oldText);
  const newLines = splitLines(file.newText);
  const operations = diffLines(oldLines, newLines);

  for (const op of operations) {
    if (op.type === 'add') stats.additions += 1;
    if (op.type === 'remove') stats.deletions += 1;
  }

  return [
    `diff --git a/${file.path} b/${file.path}`,
    `--- a/${file.path}`,
    `+++ b/${file.path}`,
    renderHunk(oldLines, newLines, operations),
  ].join('\n');
}

function renderBinaryDiff(path: string, status: UnifiedDiffFile['status']): string {
  const lines = [`diff --git a/${path} b/${path}`];
  if (status === 'added') {
    lines.push('Binary files /dev/null and b/' + path + ' differ');
  } else if (status === 'deleted') {
    lines.push('Binary files a/' + path + ' and /dev/null differ');
  } else {
    lines.push('Binary files a/' + path + ' and b/' + path + ' differ');
  }
  return lines.join('\n');
}

function renderHunk(oldLines: string[], newLines: string[], operations?: DiffOp[]): string {
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  const header = `@@ -${formatRange(oldStart, oldLines.length)} +${formatRange(newStart, newLines.length)} @@`;
  const body = (operations ?? diffLines(oldLines, newLines)).map((op) => {
    if (op.type === 'context') return ` ${op.line}`;
    if (op.type === 'add') return `+${op.line}`;
    return `-${op.line}`;
  });
  return [header, ...body].join('\n');
}

function formatRange(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  if (count === 1) return String(start);
  return `${start},${count}`;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let oldSuffix = oldLines.length;
  let newSuffix = newLines.length;
  while (oldSuffix > prefix && newSuffix > prefix && oldLines[oldSuffix - 1] === newLines[newSuffix - 1]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const operations: DiffOp[] = [];
  for (let i = 0; i < prefix; i += 1) {
    operations.push({ type: 'context', line: oldLines[i] });
  }

  const oldMiddle = oldLines.slice(prefix, oldSuffix);
  const newMiddle = newLines.slice(prefix, newSuffix);
  operations.push(...diffMiddle(oldMiddle, newMiddle));

  for (let i = oldSuffix; i < oldLines.length; i += 1) {
    operations.push({ type: 'context', line: oldLines[i] });
  }

  return operations;
}

function diffMiddle(oldLines: string[], newLines: string[]): DiffOp[] {
  if (oldLines.length === 0) {
    return newLines.map((line) => ({ type: 'add', line }));
  }

  if (newLines.length === 0) {
    return oldLines.map((line) => ({ type: 'remove', line }));
  }

  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return [
      ...oldLines.map((line) => ({ type: 'remove' as const, line })),
      ...newLines.map((line) => ({ type: 'add' as const, line })),
    ];
  }

  const table: Uint16Array[] = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint16Array(newLines.length + 1)
  );

  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        table[i][j] = table[i + 1][j + 1] + 1;
      } else {
        table[i][j] = Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
  }

  const operations: DiffOp[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      operations.push({ type: 'context', line: oldLines[i] });
      i += 1;
      j += 1;
      continue;
    }

    if (table[i + 1][j] >= table[i][j + 1]) {
      operations.push({ type: 'remove', line: oldLines[i] });
      i += 1;
    } else {
      operations.push({ type: 'add', line: newLines[j] });
      j += 1;
    }
  }

  while (i < oldLines.length) {
    operations.push({ type: 'remove', line: oldLines[i] });
    i += 1;
  }

  while (j < newLines.length) {
    operations.push({ type: 'add', line: newLines[j] });
    j += 1;
  }

  return operations;
}
