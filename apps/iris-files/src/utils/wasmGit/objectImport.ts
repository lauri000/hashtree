import type { CID } from '@hashtree/core';
import { LinkType } from '@hashtree/core';
import { getTree } from '../../store';
import type { WasmGitModule } from './core';

const LOOSE_OBJECT_DIR_RE = /^[0-9a-f]{2}$/i;
const LOOSE_OBJECT_FILE_RE = /^[0-9a-f]{38}$/i;
const PACK_PAYLOAD_FILE_RE = /^pack-[0-9a-f]{40}\.(pack|idx|rev)$/i;

function splitObjectPath(relativePath: string): string[] {
  return relativePath.split('/').filter(Boolean);
}

function isLooseObjectDirName(name: string): boolean {
  return LOOSE_OBJECT_DIR_RE.test(name);
}

export function shouldTraverseGitObjectPayloadDir(relativePath: string): boolean {
  const parts = splitObjectPath(relativePath);
  if (parts.length === 0) return false;
  if (parts.length === 1) {
    return isLooseObjectDirName(parts[0]) || parts[0] === 'pack';
  }
  return isLooseObjectDirName(parts[0]);
}

export function shouldCopyGitObjectPayloadFile(relativePath: string): boolean {
  const parts = splitObjectPath(relativePath);
  if (parts.length !== 2) return false;

  if (isLooseObjectDirName(parts[0])) {
    return LOOSE_OBJECT_FILE_RE.test(parts[1]);
  }

  if (parts[0] !== 'pack') return false;
  return PACK_PAYLOAD_FILE_RE.test(parts[1]);
}

function mkdirIfNeeded(module: WasmGitModule, path: string): void {
  try {
    module.FS.mkdir(path);
  } catch {
    // Directory may already exist
  }
}

async function copyGitObjectPayloadDir(
  module: WasmGitModule,
  srcDirCid: CID,
  destDirPath: string,
  relativeDirPath: string
): Promise<void> {
  const tree = getTree();
  const entries = await tree.listDirectory(srcDirCid);

  for (const entry of entries) {
    const relativePath = relativeDirPath ? `${relativeDirPath}/${entry.name}` : entry.name;
    const destPath = `${destDirPath}/${entry.name}`;

    if (entry.type === LinkType.Dir) {
      if (!shouldTraverseGitObjectPayloadDir(relativePath)) continue;
      mkdirIfNeeded(module, destPath);
      await copyGitObjectPayloadDir(module, entry.cid, destPath, relativePath);
      continue;
    }

    if (!shouldCopyGitObjectPayloadFile(relativePath)) continue;
    const data = await tree.readFile(entry.cid);
    if (data) {
      module.FS.writeFile(destPath, data);
    }
  }
}

export async function copyGitObjectPayloadsToWasmFS(
  module: WasmGitModule,
  objectsCid: CID,
  destGitObjectsPath: string
): Promise<void> {
  mkdirIfNeeded(module, destGitObjectsPath);
  await copyGitObjectPayloadDir(module, objectsCid, destGitObjectsPath, '');
}
