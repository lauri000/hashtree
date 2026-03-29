import { LinkType, type CID } from '@hashtree/core';
import { decodeAsText, getTree } from '../store';

export interface ProjectMeta {
  about?: string;
  homepage?: string;
  forkedFrom?: string;
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
    if ((key === 'forked_from' || key === 'forked-from') && !meta.forkedFrom) {
      meta.forkedFrom = value;
    }
  }

  return meta.about || meta.homepage || meta.forkedFrom ? meta : null;
}

export function upsertProjectForkedFrom(tomlContent: string, forkedFrom: string): string {
  const lines = tomlContent.split('\n');
  const output = [...lines];
  const serialized = `forked_from = ${JSON.stringify(forkedFrom)}`;

  let projectSectionStart = -1;
  let projectSectionEnd = lines.length;

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      continue;
    }

    if (trimmed === '[project]') {
      projectSectionStart = index;
      continue;
    }

    if (projectSectionStart !== -1) {
      projectSectionEnd = index;
      break;
    }
  }

  if (projectSectionStart !== -1) {
    for (let index = projectSectionStart + 1; index < projectSectionEnd; index++) {
      const trimmed = lines[index].trim();
      if (/^(forked_from|forked-from)\s*=/.test(trimmed)) {
        output[index] = serialized;
        return output.join('\n');
      }
    }

    output.splice(projectSectionEnd, 0, serialized);
    return output.join('\n');
  }

  const prefix = tomlContent.length > 0 && !tomlContent.endsWith('\n') ? `${tomlContent}\n` : tomlContent;
  const separator = prefix.length > 0 && !prefix.endsWith('\n\n') ? '\n' : '';
  return `${prefix}${separator}[project]\n${serialized}\n`;
}

export async function setProjectForkOrigin(repoCid: CID, forkedFrom: string): Promise<CID> {
  const tree = getTree();

  let fileName = 'project.toml';
  let existingContent = '';

  const projectResult = await tree.resolvePath(repoCid, '.hashtree/project.toml').catch(() => null);
  if (projectResult && projectResult.type !== LinkType.Dir) {
    const data = await tree.readFile(projectResult.cid);
    if (data) {
      existingContent = decodeAsText(data) ?? new TextDecoder().decode(data);
    }
  } else {
    const metaResult = await tree.resolvePath(repoCid, '.hashtree/meta.toml').catch(() => null);
    if (metaResult && metaResult.type !== LinkType.Dir) {
      fileName = 'meta.toml';
      const data = await tree.readFile(metaResult.cid);
      if (data) {
        existingContent = decodeAsText(data) ?? new TextDecoder().decode(data);
      }
    }
  }

  const updatedContent = upsertProjectForkedFrom(existingContent, forkedFrom);
  const encoded = new TextEncoder().encode(updatedContent);
  const { cid: fileCid, size: fileSize } = await tree.putFile(encoded);

  const hashtreeDirResult = await tree.resolvePath(repoCid, '.hashtree').catch(() => null);
  if (hashtreeDirResult && hashtreeDirResult.type === LinkType.Dir) {
    return tree.setEntry(repoCid, ['.hashtree'], fileName, fileCid, fileSize, LinkType.Blob);
  }

  const { cid: hashtreeDirCid } = await tree.putDirectory([
    { name: fileName, cid: fileCid, size: fileSize, type: LinkType.Blob },
  ]);
  return tree.setEntry(repoCid, [], '.hashtree', hashtreeDirCid, 0, LinkType.Dir);
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
