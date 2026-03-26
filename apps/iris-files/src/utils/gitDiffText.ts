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

export interface UnifiedDiffRenderedFile {
  path: string;
  status: UnifiedDiffFile['status'];
  text: string;
  patch: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface UnifiedDiffResult {
  text: string;
  stats: UnifiedDiffStats;
  files: UnifiedDiffRenderedFile[];
}

type DiffOp =
  | { type: 'context'; line: string }
  | { type: 'add'; line: string }
  | { type: 'remove'; line: string };

const DEFAULT_FILE_MODE = '100644';
const MAX_LCS_CELLS = 200_000;
const DEFAULT_CONTEXT_LINES = 3;

export function buildUnifiedDiff(files: UnifiedDiffFile[]): UnifiedDiffResult {
  const parts: string[] = [];
  const renderedFiles: UnifiedDiffRenderedFile[] = [];
  const stats: UnifiedDiffStats = {
    additions: 0,
    deletions: 0,
    files: files.length,
  };

  for (const file of files) {
    const rendered = renderFileDiff(file);
    renderedFiles.push(rendered);
    parts.push(rendered.text);
    stats.additions += rendered.additions;
    stats.deletions += rendered.deletions;
  }

  return {
    text: parts.filter(Boolean).join('\n'),
    stats,
    files: renderedFiles,
  };
}

function renderFileDiff(file: UnifiedDiffFile): UnifiedDiffRenderedFile {
  const oldMode = file.oldMode ?? DEFAULT_FILE_MODE;
  const newMode = file.newMode ?? DEFAULT_FILE_MODE;

  if (file.status === 'added') {
    if (file.newText === undefined) {
      return renderBinaryDiff(file.path, 'added');
    }
    const newLines = splitLines(file.newText);
    const patch = [
      `new file mode ${newMode}`,
      '--- /dev/null',
      `+++ b/${file.path}`,
      renderHunks([], newLines),
    ].join('\n');
    return {
      path: file.path,
      status: file.status,
      text: [`diff --git a/${file.path} b/${file.path}`, patch].join('\n'),
      patch,
      additions: newLines.length,
      deletions: 0,
      isBinary: false,
    };
  }

  if (file.status === 'deleted') {
    if (file.oldText === undefined) {
      return renderBinaryDiff(file.path, 'deleted');
    }
    const oldLines = splitLines(file.oldText);
    const patch = [
      `deleted file mode ${oldMode}`,
      `--- a/${file.path}`,
      '+++ /dev/null',
      renderHunks(oldLines, []),
    ].join('\n');
    return {
      path: file.path,
      status: file.status,
      text: [`diff --git a/${file.path} b/${file.path}`, patch].join('\n'),
      patch,
      additions: 0,
      deletions: oldLines.length,
      isBinary: false,
    };
  }

  if (file.oldText === undefined || file.newText === undefined) {
    return renderBinaryDiff(file.path, 'modified');
  }

  const oldLines = splitLines(file.oldText);
  const newLines = splitLines(file.newText);
  const operations = diffLines(oldLines, newLines);
  let additions = 0;
  let deletions = 0;

  for (const op of operations) {
    if (op.type === 'add') additions += 1;
    if (op.type === 'remove') deletions += 1;
  }

  const patch = [
    `--- a/${file.path}`,
    `+++ b/${file.path}`,
    renderHunks(oldLines, newLines, operations),
  ].join('\n');

  return {
    path: file.path,
    status: file.status,
    text: [`diff --git a/${file.path} b/${file.path}`, patch].join('\n'),
    patch,
    additions,
    deletions,
    isBinary: false,
  };
}

function renderBinaryDiff(path: string, status: UnifiedDiffFile['status']): UnifiedDiffRenderedFile {
  const patchLines: string[] = [];
  if (status === 'added') {
    patchLines.push('Binary files /dev/null and b/' + path + ' differ');
  } else if (status === 'deleted') {
    patchLines.push('Binary files a/' + path + ' and /dev/null differ');
  } else {
    patchLines.push('Binary files a/' + path + ' and b/' + path + ' differ');
  }
  const patch = patchLines.join('\n');
  return {
    path,
    status,
    text: [`diff --git a/${path} b/${path}`, patch].join('\n'),
    patch,
    additions: 0,
    deletions: 0,
    isBinary: true,
  };
}

function renderHunks(oldLines: string[], newLines: string[], operations?: DiffOp[]): string {
  const effectiveOperations = operations ?? diffLines(oldLines, newLines);
  if (effectiveOperations.length === 0) {
    const oldStart = oldLines.length === 0 ? 0 : 1;
    const newStart = newLines.length === 0 ? 0 : 1;
    return `@@ -${formatRange(oldStart, oldLines.length)} +${formatRange(newStart, newLines.length)} @@`;
  }

  const positions = buildLinePositions(effectiveOperations);
  const ranges = buildHunkRanges(effectiveOperations, DEFAULT_CONTEXT_LINES);
  return ranges.map(([start, end]) => renderHunkRange(effectiveOperations, positions, start, end)).join('\n');
}

function buildHunkRanges(operations: DiffOp[], contextLines: number): Array<[number, number]> {
  const changeIndices = operations.flatMap((op, index) => op.type === 'context' ? [] : [index]);
  if (changeIndices.length === 0) {
    return [[0, operations.length - 1]];
  }

  const ranges: Array<[number, number]> = [];
  let rangeStart = Math.max(0, changeIndices[0] - contextLines);
  let rangeEnd = Math.min(operations.length - 1, changeIndices[0] + contextLines);

  for (let index = 1; index < changeIndices.length; index += 1) {
    const changeIndex = changeIndices[index];
    const nextStart = Math.max(0, changeIndex - contextLines);
    const nextEnd = Math.min(operations.length - 1, changeIndex + contextLines);

    if (nextStart <= rangeEnd + 1) {
      rangeEnd = Math.max(rangeEnd, nextEnd);
      continue;
    }

    ranges.push([rangeStart, rangeEnd]);
    rangeStart = nextStart;
    rangeEnd = nextEnd;
  }

  ranges.push([rangeStart, rangeEnd]);
  return ranges;
}

function buildLinePositions(operations: DiffOp[]): Array<{ oldLine: number; newLine: number }> {
  let oldLine = 1;
  let newLine = 1;

  return operations.map((op) => {
    const position = { oldLine, newLine };
    if (op.type !== 'add') {
      oldLine += 1;
    }
    if (op.type !== 'remove') {
      newLine += 1;
    }
    return position;
  });
}

function renderHunkRange(
  operations: DiffOp[],
  positions: Array<{ oldLine: number; newLine: number }>,
  startIndex: number,
  endIndex: number
): string {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const op = operations[index];
    if (op.type === 'context') {
      body.push(` ${op.line}`);
      oldCount += 1;
      newCount += 1;
      continue;
    }

    if (op.type === 'add') {
      body.push(`+${op.line}`);
      newCount += 1;
      continue;
    }

    body.push(`-${op.line}`);
    oldCount += 1;
  }

  const startPosition = positions[startIndex] ?? { oldLine: 1, newLine: 1 };
  const oldStart = oldCount === 0 ? 0 : startPosition.oldLine;
  const newStart = newCount === 0 ? 0 : startPosition.newLine;
  const header = `@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@`;

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
