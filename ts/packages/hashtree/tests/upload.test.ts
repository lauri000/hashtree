import { describe, expect, it } from 'vitest';
import { streamUploadWithProgress } from '../src/upload.js';

function makeFile(chunks: Uint8Array[]): { size: number; stream: () => ReadableStream<Uint8Array> } {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return {
    size,
    stream: () => new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  };
}

describe('streamUploadWithProgress', () => {
  it('streams chunks and emits progress phases', async () => {
    const file = makeFile([
      new Uint8Array([1]),
      new Uint8Array([2, 3]),
      new Uint8Array([4, 5, 6]),
    ]);

    const appended: Uint8Array[] = [];
    const phases: string[] = [];

    const result = await streamUploadWithProgress(
      file,
      {
        append: async (chunk) => {
          appended.push(chunk);
        },
        finalize: async () => ({ ok: true }),
      },
      {
        onProgress: (progress) => {
          phases.push(progress.phase);
        },
      }
    );

    expect(result).toEqual({ ok: true });
    expect(appended.map(chunk => chunk.byteLength)).toEqual([1, 2, 3]);
    expect(phases).toContain('reading');
    expect(phases).toContain('writing');
    expect(phases.at(-1)).toBe('finalizing');
  });

  it('batches chunk writes and supports custom read/append/finalize hooks', async () => {
    const file = makeFile([
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3, 4, 5]),
    ]);

    const appended: Uint8Array[] = [];
    let readCalls = 0;
    let appendCalls = 0;
    let finalizeCalls = 0;
    const progressBytes: number[] = [];

    const result = await streamUploadWithProgress(
      file,
      {
        append: async (chunk) => {
          appended.push(chunk);
        },
        finalize: async () => ({ done: true }),
      },
      {
        batchBytes: 4,
        readChunk: async (reader) => {
          readCalls++;
          return reader.read();
        },
        appendChunk: async (writer, chunk) => {
          appendCalls++;
          await writer.append(chunk);
        },
        finalizeWriter: async (writer) => {
          finalizeCalls++;
          return writer.finalize();
        },
        onProgress: (progress) => {
          progressBytes.push(progress.bytesProcessed);
        },
      }
    );

    expect(result).toEqual({ done: true });
    expect(appended.map(chunk => chunk.byteLength)).toEqual([5]);
    expect(readCalls).toBe(4);
    expect(appendCalls).toBe(1);
    expect(finalizeCalls).toBe(1);
    expect(progressBytes.at(-1)).toBe(5);
  });
});
