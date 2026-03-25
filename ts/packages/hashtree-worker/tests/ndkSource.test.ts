import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const ndkSource = readFileSync(new URL('../src/iris/ndk.ts', import.meta.url), 'utf8');

describe('worker NDK source', () => {
  it('does not hardcode root wasm paths', () => {
    expect(ndkSource).not.toContain('/secp256k1.wasm');
  });

  it('does not log per-subscription subscribe or unsubscribe churn', () => {
    expect(ndkSource).not.toContain("[Worker NDK] Subscribed:");
    expect(ndkSource).not.toContain("[Worker NDK] Unsubscribed:");
  });
});
