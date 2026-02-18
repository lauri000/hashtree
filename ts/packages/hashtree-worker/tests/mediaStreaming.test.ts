import { describe, expect, it } from 'vitest';
import { HashTree, MemoryStore } from '@hashtree/core';
import { streamFileRangeChunks } from '../src/mediaStreaming.js';

function makeData(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = i % 251;
  }
  return out;
}

async function collectChunks(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe('streamFileRangeChunks', () => {
  it('splits full reads into bounded chunks', async () => {
    const data = makeData(300_000);
    const tree = new HashTree({ store: new MemoryStore() });
    const { cid } = await tree.putFile(data);

    const chunks = await collectChunks(streamFileRangeChunks(tree, cid, 0, data.length - 1, 64 * 1024));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
    }
    expect(concat(chunks)).toEqual(data);
  });

  it('respects range start/end boundaries', async () => {
    const data = makeData(180_000);
    const tree = new HashTree({ store: new MemoryStore() });
    const { cid } = await tree.putFile(data);

    const start = 12_345;
    const end = 98_765;
    const chunks = await collectChunks(streamFileRangeChunks(tree, cid, start, end, 10_000));
    expect(concat(chunks)).toEqual(data.slice(start, end + 1));
  });

  it('works across internal hashtree chunk boundaries', async () => {
    const data = makeData(3 * 1024 * 1024 + 137);
    const tree = new HashTree({ store: new MemoryStore() });
    const { cid } = await tree.putFile(data);

    const start = 2 * 1024 * 1024 - 111;
    const end = 2 * 1024 * 1024 + 111_111;
    const chunks = await collectChunks(streamFileRangeChunks(tree, cid, start, end, 32 * 1024));
    expect(concat(chunks)).toEqual(data.slice(start, end + 1));
  });
});

