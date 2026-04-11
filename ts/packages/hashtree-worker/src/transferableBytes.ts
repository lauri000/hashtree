// Worker replies may reuse bytes from caches or stores. Copy them before
// transfer so postMessage ownership changes do not detach the source buffer.
export function cloneTransferableBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}
