import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type PortableFileOps = Pick<typeof import('node:fs/promises'), 'readFile' | 'writeFile' | 'unlink'>;

const portableVendorLibs = [
  'svelte',
  'nostr-tools',
  '@noble/hashes',
  '@noble/curves',
  '@scure/base',
  'idb-keyval',
];

export const portableAssetBase = './';

export const filesPortableBuild = {
  modulePreload: false,
} as const;

export const docsPortableBuild = {
  outDir: 'dist-docs',
  modulePreload: false,
} as const;

export const gitPortableBuild = {
  outDir: 'iris-git',
  modulePreload: false,
} as const;

export const videoPortableBuild = {
  outDir: 'dist-video',
  modulePreload: false,
} as const;

export const mapsPortableBuild = {
  outDir: 'dist-maps',
  modulePreload: false,
} as const;

export const boardsPortableBuild = {
  outDir: 'dist-boards',
  modulePreload: false,
} as const;

export function getFilesBase(env: Record<string, string | undefined> = process.env): string {
  return env.GITHUB_PAGES === 'true' ? '/hashtree/' : portableAssetBase;
}

export function sanitizePortableHtml(html: string): string {
  return html
    .replace(/^\s*<link rel="modulepreload".*$/gm, '')
    .replace(/\s+crossorigin(?=[\s>])/g, '');
}

export async function rewritePortableEntryHtml(
  buildDir: string,
  sourceName: string,
  fileOps: PortableFileOps = {
    readFile,
    writeFile,
    unlink,
  },
): Promise<void> {
  const source = resolve(buildDir, sourceName);
  const target = resolve(buildDir, 'index.html');
  const html = await fileOps.readFile(source, 'utf8');
  await fileOps.writeFile(target, sanitizePortableHtml(html), 'utf8');
  if (source !== target) {
    await fileOps.unlink(source);
  }
}

export function portableAssetFileNames(assetInfo: { name?: string | undefined }): string {
  if (assetInfo.name?.endsWith('.wasm')) {
    return 'assets/[name][extname]';
  }
  return 'assets/[name]-[hash][extname]';
}

function resolveSharedVendorChunk(id: string): string | undefined {
  return portableVendorLibs.some((lib) => id.includes(`node_modules/${lib}`)) ? 'vendor' : undefined;
}

export function filesManualChunks(id: string): string | undefined {
  if (id.includes('marked')) {
    return 'markdown';
  }
  if (id.includes('fflate')) {
    return 'compression';
  }
  if (id.includes('hls.js')) {
    return 'media';
  }
  if (id.includes('coco-cashu') || id.includes('cashu-ts')) {
    return 'wallet';
  }
  if (id.includes('@nostr-dev-kit/ndk')) {
    return 'ndk';
  }
  if (id.includes('dexie')) {
    return 'dexie';
  }
  return resolveSharedVendorChunk(id);
}

export function docsManualChunks(id: string): string | undefined {
  if (id.includes('marked')) {
    return 'markdown';
  }
  if (id.includes('coco-cashu') || id.includes('cashu-ts')) {
    return 'wallet';
  }
  if (id.includes('@nostr-dev-kit/ndk')) {
    return 'ndk';
  }
  if (id.includes('dexie')) {
    return 'dexie';
  }
  if (id.includes('@tiptap') || id.includes('yjs') || id.includes('prosemirror')) {
    return 'editor';
  }
  return resolveSharedVendorChunk(id);
}

export function gitManualChunks(id: string): string | undefined {
  if (id.includes('marked')) {
    return 'markdown';
  }
  if (id.includes('coco-cashu') || id.includes('cashu-ts')) {
    return 'wallet';
  }
  if (id.includes('@nostr-dev-kit/ndk')) {
    return 'ndk';
  }
  if (id.includes('dexie')) {
    return 'dexie';
  }
  return resolveSharedVendorChunk(id);
}

export function videoManualChunks(id: string): string | undefined {
  if (id.includes('@nostr-dev-kit/ndk')) {
    return 'ndk';
  }
  if (id.includes('dexie')) {
    return 'dexie';
  }
  return resolveSharedVendorChunk(id);
}

export function mapsManualChunks(id: string): string | undefined {
  if (id.includes('leaflet')) {
    return 'leaflet';
  }
  if (id.includes('marked')) {
    return 'markdown';
  }
  if (id.includes('coco-cashu') || id.includes('cashu-ts')) {
    return 'wallet';
  }
  if (id.includes('@nostr-dev-kit/ndk')) {
    return 'ndk';
  }
  if (id.includes('dexie')) {
    return 'dexie';
  }
  return resolveSharedVendorChunk(id);
}

export function boardsManualChunks(id: string): string | undefined {
  if (id.includes('marked')) {
    return 'markdown';
  }
  if (id.includes('coco-cashu') || id.includes('cashu-ts')) {
    return 'wallet';
  }
  if (id.includes('@nostr-dev-kit/ndk')) {
    return 'ndk';
  }
  if (id.includes('dexie')) {
    return 'dexie';
  }
  return resolveSharedVendorChunk(id);
}
