export type StreamUploadPhase = 'reading' | 'writing' | 'finalizing';

export interface StreamUploadProgress {
  phase: StreamUploadPhase;
  bytesProcessed: number;
  totalBytes: number;
}

export interface StreamUploadFile {
  size: number;
  stream(): ReadableStream<Uint8Array>;
}

export interface StreamUploadWriter<Result> {
  append(data: Uint8Array): Promise<void>;
  finalize(): Promise<Result>;
}

export interface StreamUploadOptions<Result> {
  /**
   * Optional batch size for writer.append() calls.
   * Useful when the source stream yields very small chunks.
   */
  batchBytes?: number;
  onProgress?: (progress: StreamUploadProgress) => void;
  readChunk?: (
    reader: ReadableStreamDefaultReader<Uint8Array>
  ) => Promise<ReadableStreamReadResult<Uint8Array>>;
  appendChunk?: (writer: StreamUploadWriter<Result>, chunk: Uint8Array) => Promise<void>;
  finalizeWriter?: (writer: StreamUploadWriter<Result>) => Promise<Result>;
}

function mergeChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function clampBytes(bytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return Math.max(0, bytes);
  return Math.max(0, Math.min(bytes, totalBytes));
}

export async function streamUploadWithProgress<Result>(
  file: StreamUploadFile,
  writer: StreamUploadWriter<Result>,
  options: StreamUploadOptions<Result> = {}
): Promise<Result> {
  const totalBytes = Math.max(0, file.size);
  const batchBytes = Math.max(0, options.batchBytes ?? 0);
  const readChunk = options.readChunk ?? (reader => reader.read());
  const appendChunk = options.appendChunk ?? ((target, chunk) => target.append(chunk));
  const finalizeWriter = options.finalizeWriter ?? (target => target.finalize());

  let bytesWritten = 0;
  let bufferedChunks: Uint8Array[] = [];
  let bufferedBytes = 0;

  const emit = (phase: StreamUploadPhase, bytes: number): void => {
    options.onProgress?.({
      phase,
      bytesProcessed: clampBytes(bytes, totalBytes),
      totalBytes,
    });
  };

  const takeBuffered = (maxBytes?: number): Uint8Array | null => {
    if (bufferedBytes === 0) return null;

    if (!maxBytes || maxBytes <= 0 || bufferedBytes <= maxBytes) {
      const batch = mergeChunks(bufferedChunks, bufferedBytes);
      bufferedChunks = [];
      bufferedBytes = 0;
      return batch;
    }

    const parts: Uint8Array[] = [];
    let collected = 0;
    let remaining = maxBytes;

    while (remaining > 0 && bufferedChunks.length > 0) {
      const head = bufferedChunks[0];
      if (head.byteLength <= remaining) {
        parts.push(head);
        bufferedChunks.shift();
        collected += head.byteLength;
        bufferedBytes -= head.byteLength;
        remaining -= head.byteLength;
      } else {
        parts.push(head.subarray(0, remaining));
        bufferedChunks[0] = head.subarray(remaining);
        collected += remaining;
        bufferedBytes -= remaining;
        remaining = 0;
      }
    }

    return mergeChunks(parts, collected);
  };

  const flushOneBatch = async (maxBytes?: number): Promise<boolean> => {
    const batch = takeBuffered(maxBytes);
    if (!batch) return false;
    emit('writing', bytesWritten + batch.byteLength);
    await appendChunk(writer, batch);
    bytesWritten += batch.byteLength;
    return true;
  };

  const flushBuffered = async (): Promise<void> => {
    if (batchBytes > 0) {
      while (bufferedBytes >= batchBytes) {
        await flushOneBatch(batchBytes);
      }
      return;
    }
    while (await flushOneBatch()) {
      // Flush all pending bytes when batching is disabled.
    }
  };

  const reader = file.stream().getReader();
  while (true) {
    emit('reading', bytesWritten + bufferedBytes);
    const readResult = await readChunk(reader);
    if (readResult.done) break;

    bufferedChunks.push(readResult.value);
    bufferedBytes += readResult.value.byteLength;
    emit('writing', bytesWritten + bufferedBytes);

    if (batchBytes > 0 && bufferedBytes >= batchBytes) {
      await flushBuffered();
    }
    if (batchBytes === 0) {
      await flushBuffered();
    }
  }

  while (await flushOneBatch(batchBytes > 0 ? batchBytes : undefined)) {
    // Flush any remainder after stream end.
  }
  emit('finalizing', totalBytes);
  const result = await finalizeWriter(writer);
  return result;
}
