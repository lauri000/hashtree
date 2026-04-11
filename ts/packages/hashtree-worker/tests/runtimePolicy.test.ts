import { describe, expect, it } from 'vitest';
import {
  canUseInjectedHtreeServerUrl,
  canUseSameOriginHtreeProtocolStreaming,
  getInjectedHtreeServerUrl,
  resolveRuntimeHtreeBaseUrl,
  shouldEagerLoadMediaInNativeChildRuntime,
  shouldPreferSameOriginHtreeRoutes,
  type HtreeRuntimeWindowLike,
} from '../src/runtime';

function createWindowLike(
  protocol: string,
  hostname: string,
  search = '',
  serverUrl?: string,
): HtreeRuntimeWindowLike {
  return {
    location: {
      protocol,
      hostname,
      search,
    },
    __HTREE_SERVER_URL__: serverUrl,
  };
}

describe('native htree runtime policy', () => {
  it('keeps same-origin routes on https pages even when a local daemon URL is injected', () => {
    const windowLike = createWindowLike('https:', 'audio.example', '', 'http://127.0.0.1:21417');

    expect(getInjectedHtreeServerUrl(windowLike)).toBe('http://127.0.0.1:21417');
    expect(canUseInjectedHtreeServerUrl(windowLike)).toBe(false);
    expect(shouldPreferSameOriginHtreeRoutes(windowLike)).toBe(true);
    expect(resolveRuntimeHtreeBaseUrl({ windowLike })).toBe('');
    expect(
      resolveRuntimeHtreeBaseUrl({
        windowLike,
        fallbackBaseUrl: 'https://upload.example',
      }),
    ).toBe('https://upload.example');
  });

  it('uses the injected daemon URL directly inside loopback child runtimes', () => {
    const windowLike = createWindowLike(
      'http:',
      'audio.htree.localhost',
      '?htree_server=http%3A%2F%2F127.0.0.1%3A21417&htree_canonical=htree%3A%2F%2Fnpub1example%2Faudio%2Findex.html',
    );

    expect(getInjectedHtreeServerUrl(windowLike)).toBe('http://127.0.0.1:21417');
    expect(canUseInjectedHtreeServerUrl(windowLike)).toBe(true);
    expect(shouldPreferSameOriginHtreeRoutes(windowLike)).toBe(false);
    expect(shouldEagerLoadMediaInNativeChildRuntime(windowLike)).toBe(true);
    expect(
      resolveRuntimeHtreeBaseUrl({
        windowLike,
        fallbackBaseUrl: 'https://upload.example',
      }),
    ).toBe('http://127.0.0.1:21417');
  });

  it('treats htree protocol pages as same-origin streaming runtimes', () => {
    const windowLike = createWindowLike('htree:', 'npub1example', '', 'http://127.0.0.1:21417');

    expect(canUseInjectedHtreeServerUrl(windowLike)).toBe(false);
    expect(canUseSameOriginHtreeProtocolStreaming(windowLike)).toBe(true);
    expect(shouldPreferSameOriginHtreeRoutes(windowLike)).toBe(true);
    expect(resolveRuntimeHtreeBaseUrl({ windowLike })).toBe('');
  });
});
