export interface AppBookmark {
  url: string;
  name: string;
  icon?: string;
  addedAt: number;
}

export const distributedOwner = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';

export interface SuggestedTreeRootHint {
  hash: string;
  nhash: string;
}

function builtInAppUrl(treeName: string): string {
  return `htree://${distributedOwner}/${treeName}/index.html`;
}

// Latest published public tree roots for built-in apps. These let Iris prewarm
// mutable tree resolution from a known root while preserving the canonical
// htree://npub/tree identity in the shell.
export const suggestedTreeRootHints: Readonly<Record<string, SuggestedTreeRootHint>> = {
  [`${distributedOwner}/files`]: {
    hash: '73cc3980d21e54bd449e4ecbf46fdfc6ace55cbcf992e9563cb4cd5e95e13298',
    nhash: 'nhash1qqs88npesrfpu49agj0yajl5dl0udt89tj70nyhf2c7tfn27jhsn9xq9yzuhzfsagjjn3scd47fccddtjzyrzpjkkgnpqjqwu2qzy45uzpaa597t675',
  },
  [`${distributedOwner}/video`]: {
    hash: '5c70ef6e16b133ef4d9722624893c62ffc7ab5b53e4e88c4a618b97ee342b28a',
    nhash: 'nhash1qqs9cu80dcttzvl0fktjycjgj0rzllr6kk6nun5gcjnp3wt7udpt9zs9yzl34wqdrg4l7lwq9t5a4ckwyyc9xp2m5w3n57fumaks4d7juv8ychcmedh',
  },
  [`${distributedOwner}/docs`]: {
    hash: '906bd6f6df5575a0693ed18377e29c3d861dffdfb7841a747b27bcad6beb047e',
    nhash: 'nhash1qqsfq67k7m042adqdyldrqmhu2wrmpsall0m0pq6w3aj009dd04sgls9yzmtmdwkvmvewpn8v5pxjnfaf99hvn6k578nxj8hxgj5r98k70lw7lkungl',
  },
  [`${distributedOwner}/git`]: {
    hash: 'ab70787ce8744ddf57412b754a633c19b18a145bde02668edb6e5dad3e0480f6',
    nhash: 'nhash1qqs2kurc0n58gnwl2aqjka22vv7pnvv2z3dauqnx3mdkuhdd8czgpas9yz5nr29vxj3rl0xl745dxdm9geey4jvsddlfq8qu6dne7wczkq3kz9a9rut',
  },
  [`${distributedOwner}/maps`]: {
    hash: '74c4ae9611c829a0c9b853bd778ae31a80cf129f2ba1fa24628f4d62bf5d0a7c',
    nhash: 'nhash1qqs8f39wjcgus2dqexu980th3t334qx0z20jhg06y33g7ntzhaws5lq9yr0sunwrgqzka8zvgqnk08a0mquemcrdxgmcnns4lnh0lgrpkexdc90eqq9',
  },
  [`${distributedOwner}/boards`]: {
    hash: '3ac769daee443bd8dc5e0051e23b0ae00dd2dfb0c90cc7963e4f4f531fc0eeee',
    nhash: 'nhash1qqsr43mfmthygw7cm30qq50z8v9wqrwjm7cvjrx8jcly7n6nrlqwams9ypwlhvvp9upxnk82ugydp32h2sz2cv67vtmlv86lfxq6lm42n42ecs9zl8s',
  },
};

export function getSuggestedTreeRootHint(host?: string, treename?: string): SuggestedTreeRootHint | null {
  if (!host || !treename) {
    return null;
  }
  return suggestedTreeRootHints[`${host}/${treename}`] ?? null;
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
