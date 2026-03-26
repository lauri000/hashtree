export interface GitViewContextOptions {
  treeName: string | null;
  gitRootPath: string | null;
  fallbackGitRootParts?: string[];
  currentPath: string[];
}

export interface GitViewContext {
  repoName: string;
  relativePathParts: string[];
  label: string | null;
}

function splitGitRootPath(gitRootPath: string | null): string[] | null {
  if (gitRootPath === null) return null;
  if (gitRootPath === '') return [];
  return gitRootPath.split('/').filter(Boolean);
}

export function resolveGitViewContext({
  treeName,
  gitRootPath,
  fallbackGitRootParts = [],
  currentPath,
}: GitViewContextOptions): GitViewContext {
  const gitRootParts = splitGitRootPath(gitRootPath) ?? fallbackGitRootParts;
  const repoName = gitRootParts[gitRootParts.length - 1] ?? treeName ?? '';
  const relativePathParts = currentPath.slice(gitRootParts.length);
  const labelParts = repoName ? [repoName, ...relativePathParts] : relativePathParts;

  return {
    repoName,
    relativePathParts,
    label: labelParts.length > 0 ? labelParts.join(' / ') : null,
  };
}
