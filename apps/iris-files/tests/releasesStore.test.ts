import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReleaseTreeName, isListedReleaseEntryName, sanitizeReleaseId } from '../src/stores/releaseHelpers';

describe('releases store helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the repo release tree name under releases/<repo>', () => {
    expect(buildReleaseTreeName('nostr-vpn')).toBe('releases/nostr-vpn');
    expect(buildReleaseTreeName('/nostr-vpn/')).toBe('releases/nostr-vpn');
  });

  it('builds release asset urls on the app /htree route instead of upload.iris.to', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        hostname: 'git.iris.to',
        search: '',
      },
    });
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    });
    vi.stubGlobal('crypto', {
      randomUUID: () => 'test-media-client',
    });

    const { getReleaseAssetUrl } = await import('../src/stores/releaseHelpers');
    const url = getReleaseAssetUrl(
      'npub1example',
      'nostr-vpn',
      'v0.3.3',
      'assets/nostr-vpn-v0.3.3-macos-arm64.zip',
    );

    expect(url).toBe(
      '/htree/npub1example/releases%2Fnostr-vpn/v0.3.3/assets/nostr-vpn-v0.3.3-macos-arm64.zip?htree_c=test-media-client',
    );
    expect(url).not.toContain('upload.iris.to');
  });

  it('preserves the link key on release asset urls', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        hostname: 'git.iris.to',
        search: '',
      },
    });
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    });
    vi.stubGlobal('crypto', {
      randomUUID: () => 'test-media-client',
    });

    const { getReleaseAssetUrl } = await import('../src/stores/releaseHelpers');
    const url = getReleaseAssetUrl(
      'npub1example',
      'nostr-vpn',
      'v0.3.3',
      'assets/nostr-vpn-v0.3.3-macos-arm64.zip',
      'ab'.repeat(32),
    );

    expect(url).toBe(
      '/htree/npub1example/releases%2Fnostr-vpn/v0.3.3/assets/nostr-vpn-v0.3.3-macos-arm64.zip?htree_c=test-media-client&k=' + 'ab'.repeat(32),
    );
  });

  it('sanitizes release ids for tree entries', () => {
    expect(sanitizeReleaseId(' v0.2.27 beta / 1 ')).toBe('v0.2.27-beta-1');
  });

  it('hides the synthetic latest pointer from release listings', () => {
    expect(isListedReleaseEntryName('v0.2.27')).toBe(true);
    expect(isListedReleaseEntryName('latest')).toBe(false);
  });
});
