import { describe, expect, it } from 'vitest';
import { shouldInterceptHtreeRequestForWorker } from '../src/lib/swRoutePolicy';

describe('service worker htree route policy', () => {
  it('does not intercept ordinary htree app-shell asset requests without a client key', () => {
    expect(
      shouldInterceptHtreeRequestForWorker(
        '/htree/npub1example/video/assets/main.js',
        null,
        null,
      ),
    ).toBe(false);
  });

  it('intercepts client-keyed media requests', () => {
    expect(
      shouldInterceptHtreeRequestForWorker(
        '/htree/npub1example/videos%2FClip/video.mp4',
        'client-123',
        null,
      ),
    ).toBe(true);
  });

  it('intercepts byte-range requests even without a client key', () => {
    expect(
      shouldInterceptHtreeRequestForWorker(
        '/htree/nhash1example/video.mp4',
        null,
        'bytes=0-1023',
      ),
    ).toBe(true);
  });
});
