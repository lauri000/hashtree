import type { CID } from '@hashtree/core';
import { decodeAsText, getTree } from '../store';

export interface ProjectMeta {
  about?: string;
  homepage?: string;
}

function parseTomlString(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function parseProjectMeta(tomlContent: string): ProjectMeta | null {
  const meta: ProjectMeta = {};
  let section: 'root' | 'project' | 'other' = 'root';

  for (const rawLine of tomlContent.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      section = line === '[project]' ? 'project' : 'other';
      continue;
    }

    if (section !== 'root' && section !== 'project') continue;

    const match = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.+)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = parseTomlString(rawValue);
    if (!value) continue;

    if ((key === 'about' || key === 'description') && !meta.about) {
      meta.about = value;
    }
    if ((key === 'homepage' || key === 'website') && !meta.homepage) {
      meta.homepage = value;
    }
  }

  return meta.about || meta.homepage ? meta : null;
}

export async function loadProjectMeta(repoCid: CID): Promise<ProjectMeta | null> {
  const tree = getTree();
  const candidatePaths = ['.hashtree/project.toml', '.hashtree/meta.toml'];

  for (const candidatePath of candidatePaths) {
    try {
      const result = await tree.resolvePath(repoCid, candidatePath);
      if (!result?.cid) continue;

      const data = await tree.readFile(result.cid);
      if (!data) continue;

      const content = decodeAsText(data) ?? new TextDecoder().decode(data);
      const parsed = parseProjectMeta(content);
      if (parsed) return parsed;
    } catch {
      // Ignore missing or malformed project metadata files and try the next candidate.
    }
  }

  return null;
}
