import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const feedStorePath = path.resolve(process.cwd(), 'src/stores/feedStore.ts');
const feedStoreSource = fs.readFileSync(feedStorePath, 'utf8');

describe('feed store media scheduling', () => {
  it('does not gate feed media resolution behind a fixed frontend concurrency constant', () => {
    expect(feedStoreSource).not.toContain('FEED_MEDIA_RESOLUTION_CONCURRENCY');
    expect(feedStoreSource).not.toContain('for (let i = 0; i < pending.length; i += FEED_MEDIA_RESOLUTION_CONCURRENCY)');
  });
});
