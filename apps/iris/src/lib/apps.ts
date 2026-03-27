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

const builtInIrisTreeNames = new Set([
  'files',
  'video',
  'docs',
  'git',
  'maps',
  'boards',
  'iris-client',
  'iris-chat',
  'meet',
]);

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
  { url: builtInAppUrl('iris-client'), name: 'Iris Social', icon: '/iris-logo.png', addedAt: 0 },
  { url: builtInAppUrl('iris-chat'), name: 'Iris Chat', icon: '/iris-logo.png', addedAt: 0 },
  { url: builtInAppUrl('meet'), name: 'Iris Meet', icon: '/iris-logo.png', addedAt: 0 },
];

export const defaultFavoriteApps: readonly AppBookmark[] = [];

export const suggestedApps: readonly AppBookmark[] = [
  ...suggestedIrisApps,
  { url: `htree://${distributedOwner}/hashtree-cc`, name: 'hashtree.cc', icon: '/hashtree-cc-favicon.svg', addedAt: 0 },
];

export function cloneBookmarks(bookmarks: readonly AppBookmark[]): AppBookmark[] {
  return bookmarks.map((bookmark) => ({ ...bookmark }));
}

function titleCaseWords(value: string): string {
  return value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function humanizeTreeName(treeName: string): string {
  if (!treeName) return '';
  if (treeName === 'hashtree-cc') return 'hashtree.cc';
  return titleCaseWords(treeName);
}

function parseHtreeBookmarkUrl(url: string): { host: string; treeName: string } | null {
  if (!url.startsWith('htree://')) return null;
  const trimmed = url
    .replace(/^htree:\/\//, '')
    .split(/[?#]/, 1)[0]
    .replace(/\/index\.html$/, '')
    .replace(/\/$/, '');
  const [rawHost = '', ...pathParts] = trimmed
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

  if (!rawHost) return null;
  if (rawHost.startsWith('npub1') && rawHost.includes('.')) {
    const dotIndex = rawHost.indexOf('.');
    return {
      host: rawHost.slice(0, dotIndex),
      treeName: rawHost.slice(dotIndex + 1),
    };
  }

  return {
    host: rawHost,
    treeName: pathParts[0] ?? '',
  };
}

function isPlaceholderBookmarkName(name: string, url: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('npub1') || trimmed.startsWith('nhash1') || trimmed.startsWith('htree://')) {
    return true;
  }
  if (trimmed === url) {
    return true;
  }
  try {
    const parsedUrl = new URL(url);
    if (trimmed === parsedUrl.hostname || trimmed === parsedUrl.href) {
      return true;
    }
  } catch {
    // Ignore non-HTTP URLs here.
  }
  return false;
}

function inferredBookmarkName(url: string): string {
  const htree = parseHtreeBookmarkUrl(url);
  if (htree) {
    const owner = htree.host === 'self' ? distributedOwner : htree.host;
    if (isBuiltInIrisApp(owner, htree.treeName)) {
      return `Iris ${humanizeTreeName(htree.treeName)}`;
    }
    if (htree.treeName) {
      return humanizeTreeName(htree.treeName);
    }
    if (htree.host.startsWith('nhash1')) {
      return 'Shared Tree';
    }
  }
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function bookmarkDisplayName(bookmark: Pick<AppBookmark, 'url' | 'name'>): string {
  if (!isPlaceholderBookmarkName(bookmark.name, bookmark.url)) {
    return bookmark.name;
  }
  return inferredBookmarkName(bookmark.url);
}

export function bookmarkSavedName(url: string, title?: string): string {
  if (title && !isPlaceholderBookmarkName(title, url)) {
    return title.trim();
  }
  return inferredBookmarkName(url);
}
