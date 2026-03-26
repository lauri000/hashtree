import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const readableVideoRootPath = path.resolve(process.cwd(), 'src/lib/readableVideoRoot.ts');
const readableVideoRootSource = fs.readFileSync(readableVideoRootPath, 'utf8');

describe('readable video root scheduling', () => {
  it('does not serialize historical root lookups behind a frontend concurrency pool', () => {
    expect(readableVideoRootSource).not.toContain('READABLE_ROOT_HISTORY_CONCURRENCY');
    expect(readableVideoRootSource).not.toContain('withReadableRootHistorySlot');
  });
});
