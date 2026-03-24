export interface AppBookmark {
  url: string;
  name: string;
  icon?: string;
  addedAt: number;
}

export const distributedOwner = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';

function builtInAppUrl(treeName: string): string {
  return `htree://${distributedOwner}/${treeName}/index.html`;
}

const builtInIrisTreeNames = new Set(['files', 'video', 'docs', 'git', 'maps', 'boards']);

export function isBuiltInIrisApp(host?: string, treename?: string): boolean {
  return host === distributedOwner && !!treename && builtInIrisTreeNames.has(treename);
}

export const suggestedIrisApps: readonly AppBookmark[] = [
  { url: builtInAppUrl('files'), name: 'Iris Files', icon: '/iris-logo.png', addedAt: 0 },
  { url: builtInAppUrl('video'), name: 'Iris Video', icon: '/iris-logo.png', addedAt: 0 },
  { url: builtInAppUrl('docs'), name: 'Iris Docs', icon: '/iris-logo.png', addedAt: 0 },
  { url: builtInAppUrl('git'), name: 'Iris Git', icon: '/iris-logo.png', addedAt: 0 },
  { url: builtInAppUrl('maps'), name: 'Iris Maps', icon: '/iris-logo.png', addedAt: 0 },
  { url: builtInAppUrl('boards'), name: 'Iris Boards', icon: '/iris-logo.png', addedAt: 0 },
];

export const defaultFavoriteApps: readonly AppBookmark[] = [];

export const suggestedApps: readonly AppBookmark[] = [
  ...suggestedIrisApps,
  { url: `htree://${distributedOwner}/hashtree-cc`, name: 'hashtree.cc', icon: '/hashtree-cc-favicon.svg', addedAt: 0 },
  { url: 'https://iris.to', name: 'Iris Social', icon: '/iris-logo.png', addedAt: 0 },
];

export function cloneBookmarks(bookmarks: readonly AppBookmark[]): AppBookmark[] {
  return bookmarks.map((bookmark) => ({ ...bookmark }));
}
