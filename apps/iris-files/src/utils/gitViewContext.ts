export interface GitViewContextOptions {
  treeName: string | null;
  gitRootPath: string | null;
  fallbackGitRootParts?: string[];
  currentPath: string[];
}

export interface GitViewContext {
  rootParts: string[];
  repoName: string;
  relativePathParts: string[];
  label: string | null;
}

export function splitGitRootPath(gitRootPath: string | null): string[] | null {
  if (gitRootPath === null) return null;
  if (gitRootPath === '') return [];
  return gitRootPath.split('/').filter(Boolean);
}

export function hasAmbiguousEmptyGitRootHint(gitRootPath: string | null, currentPath: string[]): boolean {
  return gitRootPath === '' && currentPath.length > 0;
}

export function resolveGitRootPathParam(gitRootPath: string | null, currentPath: string[]): string {
  return gitRootPath ?? currentPath.join('/');
}

function resolveDisplayGitRootParts(
  gitRootPath: string | null,
  fallbackGitRootParts: string[],
  currentPath: string[],
): string[] {
  const gitRootParts = splitGitRootPath(gitRootPath);
  if (gitRootParts === null) return fallbackGitRootParts;
  if (gitRootParts.length === 0) return [];

  const matchesVisiblePathPrefix = gitRootParts.every((part, index) => currentPath[index] === part);
  if (!matchesVisiblePathPrefix) {
    return [];
  }

  return gitRootParts;
}

export function resolveGitViewContext({
  treeName,
  gitRootPath,
  fallbackGitRootParts = [],
  currentPath,
}: GitViewContextOptions): GitViewContext {
  const gitRootParts = resolveDisplayGitRootParts(gitRootPath, fallbackGitRootParts, currentPath);
  const repoName = gitRootParts[gitRootParts.length - 1] ?? treeName ?? '';
  const relativePathParts = currentPath.slice(gitRootParts.length);
  const labelParts = repoName ? [repoName, ...relativePathParts] : relativePathParts;

  return {
    rootParts: gitRootParts,
    repoName,
    relativePathParts,
    label: labelParts.length > 0 ? labelParts.join(' / ') : null,
  };
}
