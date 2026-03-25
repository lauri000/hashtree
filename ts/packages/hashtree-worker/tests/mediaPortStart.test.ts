import { describe, expect, it, vi } from 'vitest';
import { registerMediaPort } from '../src/iris/mediaHandler';

describe('media worker port startup', () => {
  it('starts the worker-side message port after registration', () => {
    const port = {
      onmessage: null,
      postMessage: vi.fn(),
      start: vi.fn(),
    } as unknown as MessagePort;

    registerMediaPort(port);

    expect(port.start).toHaveBeenCalledTimes(1);
  });
});
