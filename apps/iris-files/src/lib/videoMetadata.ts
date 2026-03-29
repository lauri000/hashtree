import type { CID } from '@hashtree/core';

import { findPlayableMediaEntry } from './playableMedia';
import { decodeVideoTextFile, sanitizeVideoDescription, sanitizeVideoTitle } from './videoText';

interface DirectoryEntry {
  name: string;
  cid: CID;
  meta?: unknown;
}

interface ResolvedPath {
  cid: CID;
}

interface VideoMetadataTree {
  listDirectory(cid: CID): Promise<DirectoryEntry[] | null | undefined>;
  resolvePath(cid: CID, path: string): Promise<ResolvedPath | null | undefined>;
  readFile(cid: CID): Promise<Uint8Array | null | undefined>;
}

export interface VideoDirectoryMetadata {
  videoEntry?: DirectoryEntry;
  thumbnailEntry?: DirectoryEntry;
  title: string;
  description: string;
  createdAt: number | null;
}

function isThumbnailEntry(entry: { name: string }): boolean {
  return (
    entry.name.startsWith('thumbnail.') ||
    entry.name.endsWith('.jpg') ||
    entry.name.endsWith('.webp') ||
    entry.name.endsWith('.png')
  );
}

async function readOptionalTextFile(
  tree: VideoMetadataTree,
  rootCid: CID,
  path: string,
): Promise<string> {
  try {
    const resolved = await tree.resolvePath(rootCid, path);
    if (!resolved) return '';
    const data = await tree.readFile(resolved.cid);
    return decodeVideoTextFile(data);
  } catch {
    return '';
  }
}

export async function readVideoDirectoryMetadata(
  tree: VideoMetadataTree,
  rootCid: CID,
): Promise<VideoDirectoryMetadata> {
  let title = '';
  let description = '';
  let createdAt: number | null = null;
  let videoEntry: DirectoryEntry | undefined;
  let thumbnailEntry: DirectoryEntry | undefined;

  try {
    const entries = await tree.listDirectory(rootCid);
    if (entries?.length) {
      videoEntry = findPlayableMediaEntry(entries);
      thumbnailEntry = entries.find(isThumbnailEntry);

      const meta = (videoEntry?.meta as Record<string, unknown> | undefined) ?? undefined;
      title = sanitizeVideoTitle(meta?.title);
      description = sanitizeVideoDescription(meta?.description);
      if (typeof meta?.createdAt === 'number') {
        createdAt = meta.createdAt;
      }
    }
  } catch {}

  if (!title || !description || createdAt === null) {
    try {
      const metadataResult = await tree.resolvePath(rootCid, 'metadata.json');
      if (metadataResult) {
        const metadataData = await tree.readFile(metadataResult.cid);
        if (metadataData) {
          const metadata = JSON.parse(new TextDecoder().decode(metadataData)) as Record<string, unknown>;
          if (!title) {
            title = sanitizeVideoTitle(metadata.title);
          }
          if (!description) {
            description = sanitizeVideoDescription(metadata.description);
          }
          if (createdAt === null && typeof metadata.createdAt === 'number') {
            createdAt = metadata.createdAt;
          }
        }
      }
    } catch {}
  }

  if (!title) {
    title = await readOptionalTextFile(tree, rootCid, 'title.txt');
  }

  if (!description) {
    description = await readOptionalTextFile(tree, rootCid, 'description.txt');
  }

  return {
    videoEntry,
    thumbnailEntry,
    title,
    description,
    createdAt,
  };
}
