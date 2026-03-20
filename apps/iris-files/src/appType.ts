/**
 * Tracks which app variant is currently running
 * Set by each main entry point (main.ts, main-video.ts, main-docs.ts, main-maps.ts, main-boards.ts, main-git.ts)
 */
export type AppType = 'files' | 'video' | 'docs' | 'maps' | 'boards' | 'git';

let currentAppType: AppType = 'files';

export function setAppType(type: AppType) {
  currentAppType = type;
}

export function getAppType(): AppType {
  return currentAppType;
}

export function isFilesApp(): boolean {
  return currentAppType === 'files';
}

export function isDocsApp(): boolean {
  return currentAppType === 'docs';
}

export function isGitApp(): boolean {
  return currentAppType === 'git';
}

export function isMapsApp(): boolean {
  return currentAppType === 'maps';
}

export function isBoardsApp(): boolean {
  return currentAppType === 'boards';
}

export function supportsDocumentFeatures(): boolean {
  return currentAppType === 'docs';
}

export function supportsGitFeatures(): boolean {
  return currentAppType === 'git';
}
