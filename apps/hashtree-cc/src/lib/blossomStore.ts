import { BlossomStore, nhashEncode, sha256, toHex, fromHex } from '@hashtree/core';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import type { BlossomSigner } from '@hashtree/core';
import { cacheBlob } from './blobCache';

const BLOSSOM_SERVERS = [
  { url: 'https://blossom.primal.net', write: true },
  { url: 'https://upload.iris.to', write: true, read: false },
];

// Generate ephemeral Nostr keypair (in-memory only)
const secretKey = generateSecretKey();

const signer: BlossomSigner = async (template) => {
  const event = finalizeEvent({
    ...template,
    kind: template.kind as 24242,
    created_at: template.created_at,
    content: template.content,
    tags: template.tags,
  }, secretKey);
  return {
    kind: event.kind,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags,
    pubkey: event.pubkey,
    id: event.id,
    sig: event.sig,
  };
};

export const store = new BlossomStore({
  servers: BLOSSOM_SERVERS,
  signer,
});

/**
 * Hash data, cache it locally, navigate to the viewer, and upload to Blossom in background.
 * Returns the nhash-based URL fragment.
 */
export async function uploadBuffer(data: Uint8Array, fileName: string, mimeType: string): Promise<string> {
  const hash = await sha256(data);
  const hashHex = toHex(hash);
  const nhash = nhashEncode(hashHex);

  // Cache locally so viewer can display immediately
  cacheBlob(hashHex, data, mimeType);

  // Navigate to viewer
  const fragment = `/${nhash}/${encodeURIComponent(fileName)}`;
  window.location.hash = fragment;

  // Upload to Blossom in background
  store.put(fromHex(hashHex), data, mimeType).catch(() => {});

  return fragment;
}
