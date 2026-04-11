import { describe, expect, it } from 'vitest';
import { cloneTransferableBytes } from '../src/transferableBytes.js';

describe('cloneTransferableBytes', () => {
  it('preserves the source bytes when the returned copy is transferred', () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const transferable = cloneTransferableBytes(source);

    expect(transferable).not.toBe(source);
    expect(transferable.buffer).not.toBe(source.buffer);
    expect(Array.from(transferable)).toEqual([1, 2, 3, 4]);

    const received = structuredClone(transferable, { transfer: [transferable.buffer] });

    expect(Array.from(received)).toEqual([1, 2, 3, 4]);
    expect(Array.from(source)).toEqual([1, 2, 3, 4]);
  });

  it('copies the visible bytes from a subarray before transfer', () => {
    const source = new Uint8Array([9, 8, 7, 6, 5]);
    const view = source.subarray(1, 4);
    const transferable = cloneTransferableBytes(view);

    expect(Array.from(transferable)).toEqual([8, 7, 6]);

    const received = structuredClone(transferable, { transfer: [transferable.buffer] });

    expect(Array.from(received)).toEqual([8, 7, 6]);
    expect(Array.from(source)).toEqual([9, 8, 7, 6, 5]);
  });
});
