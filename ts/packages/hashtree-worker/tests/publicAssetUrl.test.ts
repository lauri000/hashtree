import { describe, expect, it } from 'vitest';
import { resolveWorkerPublicAssetUrl } from '../src/iris/publicAssetUrl';

describe('resolveWorkerPublicAssetUrl', () => {
  it('resolves portable relative-base assets from the app root instead of the worker chunk directory', () => {
    expect(
      resolveWorkerPublicAssetUrl('./', 'secp256k1.wasm', {
        importMetaUrl: 'https://example.com/assets/worker-abc123.js',
        origin: 'https://example.com',
      }),
    ).toBe('https://example.com/secp256k1.wasm');
  });

  it('resolves rooted base urls against the current origin', () => {
    expect(
      resolveWorkerPublicAssetUrl('/video/', 'secp256k1.wasm', {
        importMetaUrl: 'https://example.com/assets/worker-abc123.js',
        origin: 'https://example.com',
      }),
    ).toBe('https://example.com/video/secp256k1.wasm');
  });
});
