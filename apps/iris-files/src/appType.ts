/**
 * Tracks which app variant is currently running
 * Set by each main entry point (main.ts, main-video.ts, main-docs.ts, main-maps.ts, main-boards.ts, main-git.ts)
 */
export type AppType = 'files' | 'video' | 'docs' | 'maps' | 'boards' | 'git';

export interface FolderCreationBehavior {
  actionLabel: string;
  modalTitle: string;
  placeholder: string;
  createsGitRepo: boolean;
}

let currentAppType: AppType = 'files';

const DEFAULT_FOLDER_CREATION_BEHAVIOR: FolderCreationBehavior = {
  actionLabel: 'New Folder',
  modalTitle: 'New Folder',
  placeholder: 'Folder name...',
  createsGitRepo: false,
};

const GIT_FOLDER_CREATION_BEHAVIOR: FolderCreationBehavior = {
  actionLabel: 'New Repository',
  modalTitle: 'New Repository',
  placeholder: 'Repository name...',
  createsGitRepo: true,
};

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

export function shouldAssumeGitRepoDuringDetection(): boolean {
  return currentAppType === 'git';
}

export function shouldShowGenericFileBrowser(): boolean {
  return currentAppType !== 'git';
}

export function shouldOpenSourceCodeLinkInNewTab(): boolean {
  return currentAppType !== 'git';
}

export function getFolderCreationBehavior(): FolderCreationBehavior {
  return currentAppType === 'git'
    ? GIT_FOLDER_CREATION_BEHAVIOR
    : DEFAULT_FOLDER_CREATION_BEHAVIOR;
}
