import { describe, expect, it, vi } from 'vitest';
import { WorkerAdapter } from '../src/workerAdapter';

describe('WorkerAdapter pushToBlossom', () => {
  it('uses an extended request timeout for large Blossom pushes', async () => {
    const adapter = new WorkerAdapter('worker.js', {} as never);
    const requestSpy = vi.spyOn(adapter as never, 'request').mockResolvedValue({
      pushed: 2,
      skipped: 5,
      failed: 0,
    });

    const result = await adapter.pushToBlossom(Uint8Array.of(1, 2, 3), undefined, 'videos/Music');

    expect(result).toEqual({
      pushed: 2,
      skipped: 5,
      failed: 0,
      errors: undefined,
    });
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pushToBlossom',
        treeName: 'videos/Music',
      }),
      undefined,
      600000,
    );
  });
});
