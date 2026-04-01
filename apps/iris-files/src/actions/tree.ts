/**
 * Tree operations - create, fork, verify trees
 */
import { navigate } from '../utils/navigate';
import { parseRoute } from '../utils/route';
import { verifyTree, toHex, LinkType } from '@hashtree/core';
import type { CID } from '@hashtree/core';
import { linkKeyUtils, saveHashtree, useNostrStore } from '../nostr';
import { nip19 } from 'nostr-tools';
import { localStore, getTree } from '../store';
import { autosaveIfOwn } from '../nostr';
import { getCurrentRootCid, getCurrentPathFromUrl } from './route';
import { updateLocalRootCache } from '../treeRootCache';
import { getRootCommit, initGitRepo } from '../utils/git';
import { buildHtreeUrl, fetchRepoAnnouncement, publishRepoAnnouncement } from '../nip34';
import { ignoreGeneratedProjectMetaInGitStatus, setProjectForkOrigin } from '../stores/projectMeta';
import {
  BOARD_CARD_FILE_SUFFIX,
  BOARD_CARDS_DIR,
  BOARD_COLUMNS_DIR,
  BOARD_COLUMN_META_FILE,
  BOARD_META_FILE,
  BOARD_ORDER_FILE,
  BOARD_PERMISSIONS_FILE,
  createBoardId,
  createInitialBoardPermissions,
  createInitialBoardState,
  serializeBoardMeta,
  serializeBoardOrder,
  serializeBoardPermissions,
  serializeCardData,
  serializeColumnMeta,
} from '../lib/boards';

type DirectoryEntryInput = { name: string; cid: CID; size: number; type?: LinkType };

function getGitAuthorIdentity() {
  const nostrState = useNostrStore.getState();
  return {
    authorName: nostrState.profile?.name || 'Anonymous',
    authorEmail: nostrState.profile?.nip05 || 'anon@hashtree.local',
  };
}

async function buildGitDirectoryCid(
  repoRootCid: CID,
  authorName: string,
  authorEmail: string,
  commitMessage: string = 'Initial commit'
): Promise<CID> {
  const tree = getTree();
  const gitFiles = await initGitRepo(repoRootCid, authorName, authorEmail, commitMessage);
  const dirMap = new Map<string, Array<{ name: string; cid: CID; size: number; type: LinkType }>>();
  dirMap.set('.git', []);

  for (const file of gitFiles) {
    if (file.isDir) {
      dirMap.set(file.name, []);
    }
  }

  for (const file of gitFiles) {
    if (file.isDir) continue;

    const { cid, size } = await tree.putFile(file.data);
    const parentDir = file.name.substring(0, file.name.lastIndexOf('/'));
    const fileName = file.name.substring(file.name.lastIndexOf('/') + 1);
    const entries = dirMap.get(parentDir);
    if (entries) {
      entries.push({ name: fileName, cid, size, type: LinkType.Blob });
    }
  }

  const sortedDirs = Array.from(dirMap.keys())
    .filter(dirPath => dirPath !== '.git')
    .sort((a, b) => b.split('/').length - a.split('/').length);

  for (const dirPath of sortedDirs) {
    const entries = dirMap.get(dirPath) || [];
    const { cid } = await tree.putDirectory(entries);
    const parentDir = dirPath.substring(0, dirPath.lastIndexOf('/'));
    const dirName = dirPath.substring(dirPath.lastIndexOf('/') + 1);
    const parentEntries = dirMap.get(parentDir);
    if (parentEntries) {
      parentEntries.push({ name: dirName, cid, size: 0, type: LinkType.Dir });
    }
  }

  const gitEntries = dirMap.get('.git') || [];
  return (await tree.putDirectory(gitEntries)).cid;
}

export async function initializeDirectoryAsGitRepo(
  dirCid: CID,
  commitMessage: string = 'Initial commit'
): Promise<CID> {
  const tree = getTree();
  const { authorName, authorEmail } = getGitAuthorIdentity();
  const gitDirCid = await buildGitDirectoryCid(dirCid, authorName, authorEmail, commitMessage);
  return tree.setEntry(dirCid, [], '.git', gitDirCid, 0, LinkType.Dir);
}

// Helper to initialize a virtual tree (when rootCid is null but we're in a tree route)
export async function initVirtualTree(entries: DirectoryEntryInput[]): Promise<CID | null> {
  const route = parseRoute();
  if (!route.npub || !route.treeName) return null;

  const tree = getTree();
  const nostrStore = useNostrStore.getState();

  let routePubkey: string;
  try {
    const decoded = nip19.decode(route.npub);
    if (decoded.type !== 'npub') return null;
    routePubkey = decoded.data as string;
  } catch {
    return null;
  }

  const isOwnTree = routePubkey === nostrStore.pubkey;
  if (!isOwnTree) return null; // Can only create in own trees

  // Create new encrypted tree with the entries (using DirEntry format)
  const dirEntries = entries.map(e => ({
    name: e.name,
    cid: e.cid,
    size: e.size,
    type: e.type,
  }));
  const { cid: newRootCid } = await tree.putDirectory(dirEntries);

  // Preserve current tree's visibility when updating
  const currentVisibility = nostrStore.selectedTree?.visibility ?? 'public';

  // Update UI state immediately (uses hex for storage)
  useNostrStore.setSelectedTree({
    id: '',
    name: route.treeName,
    pubkey: routePubkey,
    labels: nostrStore.selectedTree?.labels,
    rootHash: toHex(newRootCid.hash),
    rootKey: newRootCid.key ? toHex(newRootCid.key) : undefined,
    visibility: currentVisibility,
    created_at: Math.floor(Date.now() / 1000),
  });

  // Save to Nostr (fire-and-forget, also updates local cache)
  void saveHashtree(route.treeName, newRootCid, { visibility: currentVisibility });

  return newRootCid;
}

// Create new folder
export async function createFolder(name: string) {
  if (!name) return;

  const rootCid = getCurrentRootCid();
  const tree = getTree();
  const currentPath = getCurrentPathFromUrl();

  // putDirectory returns CID (encrypted by default)
  const { cid: emptyDirCid } = await tree.putDirectory([]);

  if (rootCid) {
    // Add to existing tree
    const newRootCid = await tree.setEntry(
      rootCid,
      currentPath,
      name,
      emptyDirCid,
      0,
      LinkType.Dir
    );
    // Publish to nostr - resolver will pick up the update
    autosaveIfOwn(newRootCid);
  } else {
    // Initialize virtual tree with this folder
    await initVirtualTree([{ name, cid: emptyDirCid, size: 0, type: LinkType.Dir }]);
  }
}

export async function createGitRepository(name: string) {
  if (!name) return;

  const rootCid = getCurrentRootCid();
  const tree = getTree();
  const currentPath = getCurrentPathFromUrl();
  const { cid: emptyDirCid } = await tree.putDirectory([]);
  const repoRootCid = await initializeDirectoryAsGitRepo(emptyDirCid);

  if (rootCid) {
    const newRootCid = await tree.setEntry(
      rootCid,
      currentPath,
      name,
      repoRootCid,
      0,
      LinkType.Dir
    );
    autosaveIfOwn(newRootCid);
  } else {
    await initVirtualTree([{ name, cid: repoRootCid, size: 0, type: LinkType.Dir }]);
  }
}

export async function createGitRepositoryTree(
  name: string,
  visibility: import('@hashtree/core').TreeVisibility = 'public'
): Promise<{ success: boolean; npub?: string; treeName?: string; linkKey?: string }> {
  if (!name) return { success: false };

  const { saveHashtree } = await import('../nostr');
  const { storeLinkKey } = await import('../stores/trees');

  const tree = getTree();
  const nostrState = useNostrStore.getState();

  if (!nostrState.isLoggedIn || !nostrState.npub || !nostrState.pubkey) {
    return { success: false };
  }

  const linkKey = visibility === 'link-visible'
    ? linkKeyUtils.generateLinkKey()
    : undefined;

  const { cid: emptyDirCid } = await tree.putDirectory([]);
  const repoRootCid = await initializeDirectoryAsGitRepo(emptyDirCid);

  useNostrStore.setSelectedTree({
    id: '',
    name,
    pubkey: nostrState.pubkey,
    labels: ['git'],
    rootHash: toHex(repoRootCid.hash),
    rootKey: repoRootCid.key ? toHex(repoRootCid.key) : undefined,
    visibility,
    created_at: Math.floor(Date.now() / 1000),
  });

  const result = await saveHashtree(name, repoRootCid, { visibility, labels: ['git'], linkKey });

  if (result.linkKey) {
    storeLinkKey(nostrState.npub, name, result.linkKey);
  }

  if (result.success) {
    try {
      const earliestUniqueCommit = await getRootCommit(repoRootCid) ?? undefined;
      const published = await publishRepoAnnouncement(name, { earliestUniqueCommit });
      if (!published) {
        console.warn('[Git] Failed to publish repo announcement', { name });
      }
    } catch (error) {
      console.warn('[Git] Failed to publish repo announcement', error);
    }
  }

  if (result.success) {
    const linkKeyParam = result.linkKey ? `?k=${result.linkKey}` : '';
    navigate(`/${nostrState.npub}/${encodeURIComponent(name)}${linkKeyParam}`);
  }

  return { success: result.success, npub: nostrState.npub, treeName: name, linkKey: result.linkKey };
}

// Create new Yjs document folder (folder with .yjs config file)
export async function createDocument(name: string) {
  if (!name) return;

  const rootCid = getCurrentRootCid();
  const tree = getTree();
  const currentPath = getCurrentPathFromUrl();

  // Create .yjs config file with owner's npub as first editor
  const nostrState = useNostrStore.getState();
  const ownerNpub = nostrState.npub || '';
  const yjsContent = new TextEncoder().encode(ownerNpub ? ownerNpub + '\n' : '');
  const { cid: yjsFileCid, size: yjsFileSize } = await tree.putFile(yjsContent);

  // Create directory with .yjs file inside
  const { cid: docDirCid } = await tree.putDirectory([
    { name: '.yjs', cid: yjsFileCid, size: yjsFileSize, type: LinkType.Blob }
  ]);

  if (rootCid) {
    // Add to existing tree
    const newRootCid = await tree.setEntry(
      rootCid,
      currentPath,
      name,
      docDirCid,
      0,
      LinkType.Dir
    );
    // Publish to nostr
    autosaveIfOwn(newRootCid);

    // Update local cache for subsequent saves (visibility is preserved from selectedTree)
    const route = parseRoute();
    const nostrStore = useNostrStore.getState();
    if (nostrStore.npub && route.treeName) {
      updateLocalRootCache(nostrStore.npub, route.treeName, newRootCid.hash, newRootCid.key, nostrStore.selectedTree?.visibility);
    }
  } else {
    // Initialize virtual tree with this document folder
    await initVirtualTree([{ name, cid: docDirCid, size: 0, type: LinkType.Dir }]);
  }
}

// Fork a directory as a new top-level tree
// Re-encrypts if source is unencrypted to ensure all forked content is encrypted
export async function forkTree(dirCid: CID, name: string, visibility: import('@hashtree/core').TreeVisibility = 'public'): Promise<{ success: boolean; linkKey?: string }> {
  if (!name) return { success: false };

  const { saveHashtree } = await import('../nostr');
  const { storeLinkKey } = await import('../stores/trees');
  const tree = getTree();

  const nostrState = useNostrStore.getState();
  if (!nostrState.npub || !nostrState.pubkey) return { success: false };

  let forkOriginUrl: string | null = null;
  let forkAnnouncementEuc: string | undefined;
  let forkMetadataApplied = false;

  try {
    const route = parseRoute();
    const sourceOwnerNpub = route.npub;
    const sourceTreeName = route.treeName;
    const sourceRepoName = sourceTreeName
      ? [sourceTreeName, ...route.path].filter(Boolean).join('/')
      : null;
    const sourceAnnouncement = sourceOwnerNpub && sourceRepoName
      ? await fetchRepoAnnouncement(sourceOwnerNpub, sourceRepoName).catch(() => null)
      : null;
    const sourceRootCommit = sourceAnnouncement?.earliestUniqueCommit ?? await getRootCommit(dirCid);
    const shouldAnnotateFork = (
      !!sourceOwnerNpub &&
      !!sourceRepoName &&
      sourceOwnerNpub !== nostrState.npub &&
      !!sourceRootCommit
    );

    if (shouldAnnotateFork && sourceOwnerNpub && sourceRepoName) {
      forkOriginUrl = buildHtreeUrl(sourceOwnerNpub, sourceRepoName);
      forkAnnouncementEuc = sourceRootCommit ?? undefined;
    }
  } catch (error) {
    console.warn('[Fork] Failed to resolve fork origin metadata', error);
  }

  // If source is unencrypted (no key), re-encrypt it
  let finalCid = dirCid;
  if (forkOriginUrl && !finalCid.key) {
    try {
      finalCid = await setProjectForkOrigin(finalCid, forkOriginUrl);
      forkMetadataApplied = true;
    } catch (error) {
      console.warn('[Fork] Failed to annotate fork origin metadata before re-encryption', error);
    }
  }

  if (!dirCid.key) {
    console.log('[Fork] Source is unencrypted, re-encrypting...');

    // Rebuild with encryption (doesn't publish to Nostr - we'll do that below)
    const rebuildWithEncryption = async (oldCid: CID): Promise<CID> => {
      if (oldCid.key) return oldCid;

      const isDir = await tree.isDirectory(oldCid);
      if (isDir) {
        const entries = await tree.listDirectory(oldCid);
        const newEntries = [];
        for (const entry of entries) {
          const newChildCid = await rebuildWithEncryption(entry.cid);
          newEntries.push({
            name: entry.name,
            cid: newChildCid,
            size: entry.size,
            type: entry.type ?? 0,
            meta: entry.meta,
          });
        }
        return (await tree.putDirectory(newEntries, {})).cid;
      } else {
        const data = await tree.readFile(oldCid);
        if (!data) return oldCid;
        return (await tree.putFile(data, {})).cid;
      }
    };

    finalCid = await rebuildWithEncryption(finalCid);
    console.log('[Fork] Re-encryption complete');
  }

  if (forkOriginUrl && !forkMetadataApplied) {
    try {
      finalCid = await setProjectForkOrigin(finalCid, forkOriginUrl);
      forkMetadataApplied = true;
    } catch (error) {
      console.warn('[Fork] Failed to annotate fork origin metadata', error);
    }
  }

  if (forkOriginUrl && forkMetadataApplied) {
    try {
      finalCid = await ignoreGeneratedProjectMetaInGitStatus(finalCid);
    } catch (error) {
      console.warn('[Fork] Failed to hide generated fork metadata from git status', error);
    }
  }

  useNostrStore.setSelectedTree({
    id: '',
    name,
    pubkey: nostrState.pubkey,
    rootHash: toHex(finalCid.hash),
    rootKey: finalCid.key ? toHex(finalCid.key) : undefined,
    visibility,
    created_at: Math.floor(Date.now() / 1000),
  });

  // Save to Nostr (also updates local cache)
  const result = await saveHashtree(name, finalCid, { visibility });

  // For link-visible trees, store link key locally and append to URL
  if (result.linkKey) {
    storeLinkKey(nostrState.npub, name, result.linkKey);
  }

  if (result.success && forkOriginUrl) {
    try {
      const published = await publishRepoAnnouncement(name, {
        personalFork: true,
        earliestUniqueCommit: forkAnnouncementEuc,
      });
      if (!published) {
        console.warn('[Fork] Failed to publish personal fork announcement', { name });
      }
    } catch (error) {
      console.warn('[Fork] Failed to publish personal fork announcement', error);
    }
  }

  if (result.success) {
    const linkKeyParam = result.linkKey ? `?k=${result.linkKey}` : '';
    navigate(`/${encodeURIComponent(nostrState.npub)}/${encodeURIComponent(name)}${linkKeyParam}`);
  }
  return result;
}

// Create a new tree (top-level folder on nostr or local)
// Creates encrypted trees by default
// Set skipNavigation=true to create without navigating (for batch creation)
export async function createTree(name: string, visibility: import('@hashtree/core').TreeVisibility = 'public', skipNavigation = false): Promise<{ success: boolean; linkKey?: string }> {
  if (!name) return { success: false };

  const { saveHashtree } = await import('../nostr');
  const { storeLinkKey } = await import('../stores/trees');

  const tree = getTree();
  // Create encrypted empty directory (default)
  const { cid: rootCid } = await tree.putDirectory([]);

  const nostrState = useNostrStore.getState();

  // If logged in, publish to nostr
  if (nostrState.isLoggedIn && nostrState.npub && nostrState.pubkey) {
    // Set selectedTree BEFORE saving so updates work (only if we're navigating)
    if (!skipNavigation) {
      useNostrStore.setSelectedTree({
        id: '', // Will be set by actual nostr event
        name,
        pubkey: nostrState.pubkey,
        rootHash: toHex(rootCid.hash),
        rootKey: rootCid.key ? toHex(rootCid.key) : undefined,
        visibility,
        created_at: Math.floor(Date.now() / 1000),
      });
    }

    // Save to Nostr (also updates local cache immediately for subsequent operations)
    const result = await saveHashtree(name, rootCid, { visibility });

    // For link-visible trees, store link key locally and append to URL
    if (result.linkKey) {
      storeLinkKey(nostrState.npub, name, result.linkKey);
    }

    if (!skipNavigation) {
      const linkKeyParam = result.linkKey ? `?k=${result.linkKey}` : '';
      navigate(`/${encodeURIComponent(nostrState.npub)}/${encodeURIComponent(name)}${linkKeyParam}`);
    }
    return result;
  }

  // Not logged in - can't create trees without nostr
  return { success: false };
}

// Create a new tree as a document (with .yjs config file)
// Used by docs app to create standalone documents
export async function createDocumentTree(
  name: string,
  visibility: import('@hashtree/core').TreeVisibility = 'public'
): Promise<{ success: boolean; npub?: string; treeName?: string; linkKey?: string }> {
  if (!name) return { success: false };

  const { saveHashtree } = await import('../nostr');
  const { storeLinkKey } = await import('../stores/trees');

  const tree = getTree();
  const nostrState = useNostrStore.getState();

  if (!nostrState.isLoggedIn || !nostrState.npub || !nostrState.pubkey) {
    return { success: false };
  }

  const treeName = `docs/${name}`;
  const linkKey = visibility === 'link-visible'
    ? linkKeyUtils.generateLinkKey()
    : undefined;

  // Create .yjs config file with owner's npub as first editor
  const yjsContent = new TextEncoder().encode(nostrState.npub + '\n');
  const { cid: yjsFileCid, size: yjsFileSize } = await tree.putFile(yjsContent);

  // Create root directory with .yjs file inside
  const { cid: rootCid } = await tree.putDirectory([
    { name: '.yjs', cid: yjsFileCid, size: yjsFileSize, type: LinkType.Blob }
  ]);

  // Set selectedTree for updates
  useNostrStore.setSelectedTree({
    id: '',
    name: treeName,
    pubkey: nostrState.pubkey,
    labels: ['docs'],
    rootHash: toHex(rootCid.hash),
    rootKey: rootCid.key ? toHex(rootCid.key) : undefined,
    visibility,
    created_at: Math.floor(Date.now() / 1000),
  });

  // Save to Nostr with docs label (also updates local cache)
  const publishPromise = saveHashtree(treeName, rootCid, { visibility, labels: ['docs'], linkKey });
  let result: { success: boolean; linkKey?: string };
  if (import.meta.env.VITE_TEST_MODE) {
    void publishPromise;
    result = { success: true, linkKey };
  } else {
    result = await publishPromise;
  }

  // Store link key for link-visible documents
  if (result.linkKey) {
    storeLinkKey(nostrState.npub, treeName, result.linkKey);
  }

  return { success: true, npub: nostrState.npub, treeName, linkKey: result.linkKey };
}

// Create a new tree as a board (kanban data + permissions)
export async function createBoardTree(
  name: string,
  visibility: import('@hashtree/core').TreeVisibility = 'public'
): Promise<{ success: boolean; npub?: string; treeName?: string; linkKey?: string }> {
  if (!name) return { success: false };

  const { saveHashtree } = await import('../nostr');
  const { storeLinkKey } = await import('../stores/trees');

  const tree = getTree();
  const nostrState = useNostrStore.getState();

  if (!nostrState.isLoggedIn || !nostrState.npub || !nostrState.pubkey) {
    return { success: false };
  }

  const treeName = `boards/${name}`;
  const linkKey = visibility === 'link-visible'
    ? linkKeyUtils.generateLinkKey()
    : undefined;

  const now = Date.now();
  const boardId = createBoardId();
  const permissions = createInitialBoardPermissions(boardId, name, nostrState.npub, now);
  const boardState = createInitialBoardState(boardId, name, nostrState.npub, now);

  const putTextFile = async (text: string) => {
    const data = new TextEncoder().encode(text);
    return tree.putFile(data);
  };

  const columnEntries: Array<{ name: string; cid: CID; size: number; type: LinkType }> = [];
  for (const column of boardState.columns) {
    const cardEntries: Array<{ name: string; cid: CID; size: number; type: LinkType }> = [];
    for (const card of column.cards) {
      const { cid: cardCid, size: cardSize } = await putTextFile(serializeCardData(card));
      cardEntries.push({
        name: `${card.id}${BOARD_CARD_FILE_SUFFIX}`,
        cid: cardCid,
        size: cardSize,
        type: LinkType.Blob,
      });
    }

    const { cid: cardsCid } = await tree.putDirectory(cardEntries);
    const { cid: columnMetaCid, size: columnMetaSize } = await putTextFile(serializeColumnMeta(column));
    const { cid: columnDirCid } = await tree.putDirectory([
      { name: BOARD_COLUMN_META_FILE, cid: columnMetaCid, size: columnMetaSize, type: LinkType.Blob },
      { name: BOARD_CARDS_DIR, cid: cardsCid, size: 0, type: LinkType.Dir },
    ]);

    columnEntries.push({
      name: column.id,
      cid: columnDirCid,
      size: 0,
      type: LinkType.Dir,
    });
  }

  const { cid: columnsCid } = await tree.putDirectory(columnEntries);
  const { cid: boardMetaCid, size: boardMetaSize } = await putTextFile(serializeBoardMeta(boardState));
  const { cid: boardOrderCid, size: boardOrderSize } = await putTextFile(serializeBoardOrder(boardState));
  const { cid: permissionsCid, size: permissionsSize } = await putTextFile(serializeBoardPermissions(permissions));

  const { cid: rootCid } = await tree.putDirectory([
    { name: BOARD_META_FILE, cid: boardMetaCid, size: boardMetaSize, type: LinkType.Blob },
    { name: BOARD_ORDER_FILE, cid: boardOrderCid, size: boardOrderSize, type: LinkType.Blob },
    { name: BOARD_PERMISSIONS_FILE, cid: permissionsCid, size: permissionsSize, type: LinkType.Blob },
    { name: BOARD_COLUMNS_DIR, cid: columnsCid, size: 0, type: LinkType.Dir },
  ]);

  useNostrStore.setSelectedTree({
    id: '',
    name: treeName,
    pubkey: nostrState.pubkey,
    labels: ['boards'],
    rootHash: toHex(rootCid.hash),
    rootKey: rootCid.key ? toHex(rootCid.key) : undefined,
    visibility,
    created_at: Math.floor(Date.now() / 1000),
  });

  // Local-first: board creation succeeds immediately after local tree is created.
  // Try to confirm the initial publish before returning a shareable board URL.
  // If relay publication is slow or fails, fall back to the historical
  // local-first behavior and let the background publish continue.
  if (linkKey) {
    storeLinkKey(nostrState.npub, treeName, linkKey);
  }

  const publishPromise = saveHashtree(treeName, rootCid, { visibility, labels: ['boards'], linkKey });
  const publishTimeoutMs = import.meta.env.VITE_TEST_MODE ? 15000 : 5000;
  const publishTimeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), publishTimeoutMs);
  });

  let publishResult: Awaited<typeof publishPromise> | null = null;
  try {
    publishResult = await Promise.race([publishPromise, publishTimeout]);
  } catch (err) {
    console.warn('[Boards] Initial publish failed; board remains local-first', err);
  }

  if (!publishResult) {
    void publishPromise
      .then((result) => {
        if (!result.success) {
          console.warn('[Boards] Board created locally; relay publish not confirmed yet');
        }
        if (result.linkKey) {
          storeLinkKey(nostrState.npub!, treeName, result.linkKey);
        }
      })
      .catch((err) => {
        console.warn('[Boards] Background publish failed; board remains local-first', err);
      });
  } else if (publishResult.linkKey) {
    storeLinkKey(nostrState.npub, treeName, publishResult.linkKey);
  }

  return {
    success: true,
    npub: nostrState.npub,
    treeName,
    linkKey: publishResult?.linkKey ?? linkKey,
  };
}

// Verify tree
export async function verifyCurrentTree(): Promise<{ valid: boolean; missing: number }> {
  const rootCid = getCurrentRootCid();
  if (!rootCid) return { valid: false, missing: 0 };

  const { valid, missing } = await verifyTree(localStore, rootCid.hash);
  return { valid, missing: missing.length };
}

// Clear store
export function clearStore() {
  localStore.clear();
  navigate('/');
}
