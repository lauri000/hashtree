export interface AppBookmark {
  url: string;
  name: string;
  icon?: string;
  addedAt: number;
}

export const distributedOwner = 'npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce';

export const suggestedIrisApps: readonly AppBookmark[] = [
  { url: `htree://${distributedOwner}/files`, name: 'Iris Files', icon: '/iris-logo.png', addedAt: 0 },
  { url: `htree://${distributedOwner}/video`, name: 'Iris Video', icon: '/iris-logo.png', addedAt: 0 },
  { url: `htree://${distributedOwner}/docs`, name: 'Iris Docs', icon: '/iris-logo.png', addedAt: 0 },
  { url: `htree://${distributedOwner}/maps`, name: 'Iris Maps', icon: '/iris-logo.png', addedAt: 0 },
];

export const defaultFavoriteApps: readonly AppBookmark[] = [];

export const suggestedApps: readonly AppBookmark[] = [
  ...suggestedIrisApps,
  { url: 'https://iris.to', name: 'Iris Social', icon: '/iris-logo.png', addedAt: 0 },
];

export function cloneBookmarks(bookmarks: readonly AppBookmark[]): AppBookmark[] {
  return bookmarks.map((bookmark) => ({ ...bookmark }));
}
