import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf8');
}

describe('worker NDK logging noise', () => {
  it('does not log per-subscription subscribe/unsubscribe churn', () => {
    const ndkWorker = read('src/worker/ndk.ts');

    expect(ndkWorker).not.toContain("[Worker NDK] Subscribed:");
    expect(ndkWorker).not.toContain("[Worker NDK] Unsubscribed:");
  });
});
