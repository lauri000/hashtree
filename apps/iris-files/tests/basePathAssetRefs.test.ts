import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf8');
}

describe('asset paths are base-url aware', () => {
  it('does not hardcode root asset paths in UI components', () => {
    const logo = read('src/components/Logo.svelte');
    const launcher = read('src/components/AppLauncher.svelte');

    expect(logo).not.toContain('/iris-logo.png');
    expect(launcher).not.toContain('/iris-logo.png');
  });

  it('does not hardcode root wasm paths in runtime loaders', () => {
    const wasmGit = read('src/utils/wasmGit/core.ts');
    const ndkWorker = read('src/worker/ndk.ts');

    expect(wasmGit).not.toContain('/lg2_async.wasm');
    expect(ndkWorker).not.toContain('/secp256k1.wasm');
  });
});
