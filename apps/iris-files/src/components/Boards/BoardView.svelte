<script lang="ts">
  import { onDestroy } from 'svelte';
  import { cid as makeCid, fromHex, LinkType, nhashEncode, toHex, type CID, type TreeEntry } from '@hashtree/core';
  import { nip19 } from 'nostr-tools';
  import { getNhashFileUrl } from '../../lib/mediaUrl';
  import { getTree } from '../../store';
  import { setUploadProgress } from '../../stores/upload';
  import { toast } from '../../stores/toast';
  import { routeStore, treeRootStore, createTreesStore, waitForTreeRoot, getTreeRootSync, addRecent, updateRecentVisibility } from '../../stores';
  import { autosaveIfOwn, nostrStore } from '../../nostr';
  import { updateLocalRootCacheHex } from '../../treeRootCache';
  import { open as openShareModal } from '../Modals/ShareModal.svelte';
  import VisibilityIcon from '../VisibilityIcon.svelte';
  import MediaPlayer from '../Viewer/MediaPlayer.svelte';
  import {
    BOARD_CARD_FILE_SUFFIX,
    BOARD_CARD_ATTACHMENTS_SUFFIX,
    BOARD_CARDS_DIR,
    BOARD_COLUMNS_DIR,
    BOARD_COLUMN_META_FILE,
    BOARD_META_FILE,
    BOARD_ORDER_FILE,
    BOARD_PERMISSIONS_FILE,
    addBoardPermission,
    canManageBoard,
    canWriteBoard,
    cloneBoardState,
    createBoardId,
    createInitialBoardPermissions,
    createInitialBoardState,
    isValidNpub,
    parseBoardMeta,
    parseBoardOrder,
    parseCardData,
    parseColumnMeta,
    parseBoardPermissions,
    parseBoardState,
    removeBoardPermission,
    serializeBoardMeta,
    serializeBoardOrder,
    serializeCardData,
    serializeColumnMeta,
    serializeBoardPermissions,
    type BoardCardAttachment,
    type BoardCard,
    type BoardColumn,
    type BoardPermissions,
    type BoardRole,
    type BoardState,
  } from '../../lib/boards';

  let route = $derived($routeStore);
  let treeRoot = $derived($treeRootStore);
  let userNpub = $derived($nostrStore.npub);
  let viewedNpub = $derived(route.npub);
  let ownerNpub = $derived(viewedNpub || userNpub || '');
  let isOwnBoard = $derived(!!userNpub && userNpub === viewedNpub);

  let targetNpub = $derived(viewedNpub || userNpub);
  let treesStore = $derived(createTreesStore(targetNpub));
  let trees = $state<Array<{ name: string; visibility?: string }>>([]);

  $effect(() => {
    const store = treesStore;
    const unsub = store.subscribe(value => {
      trees = value;
    });
    return unsub;
  });

  let currentTree = $derived(route.treeName ? trees.find(tree => tree.name === route.treeName) : null);
  let visibility = $derived(currentTree?.visibility || 'public');

  let loading = $state(true);
  let savingBoard = $state(false);
  let savingPermissions = $state(false);
  let error = $state<string | null>(null);
  let board = $state<BoardState | null>(null);
  let permissions = $state<BoardPermissions | null>(null);

  let showPermissionsModal = $state(false);
  let permissionRole = $state<BoardRole>('writer');
  let permissionNpub = $state('');
  let permissionError = $state('');

  let showCardModal = $state(false);
  let cardModalMode = $state<'create' | 'edit'>('create');
  let cardModalColumnId = $state('');
  let cardModalCardId = $state<string | null>(null);
  let cardDraftTitle = $state('');
  let cardDraftDescription = $state('');
  let cardFormError = $state('');
  let showMediaModal = $state(false);
  let mediaAttachment = $state<BoardCardAttachment | null>(null);

  let attachmentInputRef: HTMLInputElement | undefined = $state();
  let attachmentTarget = $state<{ columnId: string; cardId: string } | null>(null);
  let uploadingCardMap = $state<Record<string, true>>({});

  let showColumnModal = $state(false);
  let columnModalMode = $state<'create' | 'edit'>('create');
  let columnModalColumnId = $state<string | null>(null);
  let columnDraftTitle = $state('');
  let columnFormError = $state('');

  interface DragCardState {
    cardId: string;
    fromColumnId: string;
  }

  interface CardDropTarget {
    columnId: string;
    beforeCardId: string | null;
    position: 'before' | 'after' | 'end';
  }

  let draggingCard = $state<DragCardState | null>(null);
  let cardDropTarget = $state<CardDropTarget | null>(null);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let loadGeneration = 0;

  let canManage = $derived(
    !!permissions && !!ownerNpub && canManageBoard(permissions, userNpub, ownerNpub)
  );
  let canWrite = $derived(
    !!permissions && !!ownerNpub && canWriteBoard(permissions, userNpub, ownerNpub)
  );

  function boardDisplayName(treeName: string | null): string {
    if (!treeName) return 'Board';
    return treeName.startsWith('boards/') ? treeName.slice(7) : treeName;
  }

  function setSelectedTreeIfOwn(npubStr: string, treeNameVal: string) {
    let pubkey: string | null = null;
    try {
      const decoded = nip19.decode(npubStr);
      if (decoded.type === 'npub') pubkey = decoded.data as string;
    } catch {
      return;
    }

    const state = nostrStore.getState();
    if (!pubkey || !state.isLoggedIn || state.pubkey !== pubkey) return;

    const currentSelected = state.selectedTree;
    if (!currentSelected || currentSelected.name !== treeNameVal) {
      nostrStore.setSelectedTree({
        id: '',
        name: treeNameVal,
        pubkey,
        rootHash: currentSelected?.rootHash || '',
        rootKey: currentSelected?.rootKey,
        visibility: currentSelected?.visibility ?? 'public',
        created_at: Math.floor(Date.now() / 1000),
      });
    }
  }

  $effect(() => {
    const npub = route.npub;
    const treeName = route.treeName;
    if (!npub || !treeName) return;
    setSelectedTreeIfOwn(npub, treeName);
  });

  $effect(() => {
    const npub = route.npub;
    const treeName = route.treeName;
    const linkKey = route.params.get('k');
    if (npub && treeName?.startsWith('boards/')) {
      addRecent({
        type: 'tree',
        label: boardDisplayName(treeName),
        path: `/${npub}/${treeName}`,
        npub,
        treeName,
        linkKey: linkKey ?? undefined,
      });
    }
  });

  $effect(() => {
    const npub = route.npub;
    const treeName = route.treeName;
    if (npub && treeName?.startsWith('boards/') && visibility) {
      updateRecentVisibility(`/${npub}/${treeName}`, visibility as 'public' | 'link-visible' | 'private');
    }
  });

  function sortEntriesByName(entries: TreeEntry[]): TreeEntry[] {
    return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  }

  function findBlobEntry(entries: TreeEntry[], filename: string): TreeEntry | undefined {
    return entries.find(entry => entry.name === filename && entry.type !== LinkType.Dir);
  }

  function findDirEntry(entries: TreeEntry[], name: string): TreeEntry | undefined {
    return entries.find(entry => entry.name === name && entry.type === LinkType.Dir);
  }

  function cardIdFromFilename(filename: string): string {
    if (!filename.endsWith(BOARD_CARD_FILE_SUFFIX)) return filename;
    return filename.slice(0, -BOARD_CARD_FILE_SUFFIX.length);
  }

  function cardAttachmentsDirName(cardId: string): string {
    return `${cardId}${BOARD_CARD_ATTACHMENTS_SUFFIX}`;
  }

  function cardIdFromAttachmentsDir(dirname: string): string | null {
    if (!dirname.endsWith(BOARD_CARD_ATTACHMENTS_SUFFIX)) return null;
    return dirname.slice(0, -BOARD_CARD_ATTACHMENTS_SUFFIX.length);
  }

  function sanitizeAttachmentFileName(filename: string): string {
    const clean = filename
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[\\/]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    return clean || `attachment-${Date.now().toString(36)}`;
  }

  function guessMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'gif': return 'image/gif';
      case 'webp': return 'image/webp';
      case 'svg': return 'image/svg+xml';
      case 'pdf': return 'application/pdf';
      case 'txt': return 'text/plain';
      case 'md': return 'text/markdown';
      case 'json': return 'application/json';
      default: return 'application/octet-stream';
    }
  }

  function isImageAttachment(attachment: BoardCardAttachment): boolean {
    return attachment.mimeType.startsWith('image/');
  }

  function isVideoAttachment(attachment: BoardCardAttachment): boolean {
    return attachment.mimeType.startsWith('video/');
  }

  function isAudioAttachment(attachment: BoardCardAttachment): boolean {
    return attachment.mimeType.startsWith('audio/');
  }

  function isModalPreviewAttachment(attachment: BoardCardAttachment): boolean {
    return isImageAttachment(attachment) || isVideoAttachment(attachment) || isAudioAttachment(attachment);
  }

  function formatAttachmentSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function cardAttachmentUrl(attachment: BoardCardAttachment): string | null {
    const fileCid = attachmentCid(attachment);
    if (fileCid) {
      return getNhashFileUrl(fileCid, attachment.displayName || attachment.fileName);
    }

    const hash = attachment.cidHash?.trim();
    if (!hash) return null;
    const decryptKey = attachment.cidKey?.trim() || undefined;
    try {
      const nhash = nhashEncode({ hash, decryptKey });
      const encodedName = encodeURIComponent(attachment.displayName || attachment.fileName || 'file');
      return `/htree/${nhash}/${encodedName}`;
    } catch {
      return null;
    }
  }

  function openAttachmentPreview(attachment: BoardCardAttachment) {
    if (!isModalPreviewAttachment(attachment)) return;
    mediaAttachment = attachment;
    showMediaModal = true;
  }

  function closeAttachmentPreview() {
    showMediaModal = false;
    mediaAttachment = null;
  }

  function applyCardOrder(cards: BoardCard[], orderedCardIds: string[] | undefined): BoardCard[] {
    const byId = new Map(cards.map(card => [card.id, card]));
    const used: Record<string, true> = {};
    const ordered: BoardCard[] = [];

    for (const cardId of orderedCardIds || []) {
      const card = byId.get(cardId);
      if (!card || used[card.id]) continue;
      ordered.push(card);
      used[card.id] = true;
    }

    for (const card of cards) {
      if (used[card.id]) continue;
      ordered.push(card);
    }

    return ordered;
  }

  function applyColumnOrder(columns: BoardColumn[], orderedColumnIds: string[]): BoardColumn[] {
    const byId = new Map(columns.map(column => [column.id, column]));
    const used: Record<string, true> = {};
    const ordered: BoardColumn[] = [];

    for (const columnId of orderedColumnIds) {
      const column = byId.get(columnId);
      if (!column || used[column.id]) continue;
      ordered.push(column);
      used[column.id] = true;
    }

    for (const column of columns) {
      if (used[column.id]) continue;
      ordered.push(column);
    }

    return ordered;
  }

  async function resolveBoardDirectory(root: CID, boardPath: string[]): Promise<CID | null> {
    const tree = getTree();
    if (boardPath.length === 0) return root;

    const resolved = await tree.resolvePath(root, boardPath.join('/'));
    if (!resolved) return null;
    const isDir = await tree.isDirectory(resolved.cid);
    if (!isDir) return null;
    return resolved.cid;
  }

  async function loadBoardFromDirectory(
    dirCid: CID,
    fallbackBoardId: string,
    fallbackTitle: string,
    fallbackUpdatedBy: string
  ): Promise<{ board: BoardState | null; permissions: BoardPermissions | null }> {
    const tree = getTree();
    const entries = await tree.listDirectory(dirCid);

    const boardMetaEntry = findBlobEntry(entries, BOARD_META_FILE);
    const boardOrderEntry = findBlobEntry(entries, BOARD_ORDER_FILE);
    const permissionsEntry = findBlobEntry(entries, BOARD_PERMISSIONS_FILE);
    const columnsDirEntry = findDirEntry(entries, BOARD_COLUMNS_DIR);

    const boardMetaData = boardMetaEntry ? await tree.readFile(boardMetaEntry.cid) : null;
    const boardMeta = boardMetaData
      ? parseBoardMeta(boardMetaData, fallbackBoardId, fallbackTitle, fallbackUpdatedBy)
      : null;
    const legacyBoardState = boardMetaData
      ? parseBoardState(boardMetaData, fallbackBoardId, fallbackTitle, fallbackUpdatedBy)
      : null;

    const permissionsData = permissionsEntry ? await tree.readFile(permissionsEntry.cid) : null;
    const parsedPermissions = permissionsData && ownerNpub
      ? parseBoardPermissions(permissionsData, ownerNpub)
      : null;

    const boardOrderData = boardOrderEntry ? await tree.readFile(boardOrderEntry.cid) : null;
    const boardOrder = boardOrderData ? parseBoardOrder(boardOrderData) : parseBoardOrder(null);

    const parsedColumns: BoardColumn[] = [];
    if (columnsDirEntry) {
      const columnEntries = sortEntriesByName(await tree.listDirectory(columnsDirEntry.cid));
      for (const columnEntry of columnEntries) {
        if (columnEntry.type !== LinkType.Dir) continue;
        const columnDirEntries = await tree.listDirectory(columnEntry.cid);
        const columnMetaEntry = findBlobEntry(columnDirEntries, BOARD_COLUMN_META_FILE);
        const cardsDirEntry = findDirEntry(columnDirEntries, BOARD_CARDS_DIR);

        const columnMetaData = columnMetaEntry ? await tree.readFile(columnMetaEntry.cid) : null;
        const columnMeta = columnMetaData
          ? parseColumnMeta(columnMetaData, columnEntry.name)
          : { id: columnEntry.name, title: 'Untitled Column' };
        if (!columnMeta) continue;

        const cards: BoardCard[] = [];
        if (cardsDirEntry) {
          const cardEntries = sortEntriesByName(await tree.listDirectory(cardsDirEntry.cid));
          const attachmentDirs: Record<string, TreeEntry> = {};
          for (const entry of cardEntries) {
            if (entry.type !== LinkType.Dir) continue;
            const cardId = cardIdFromAttachmentsDir(entry.name);
            if (!cardId) continue;
            attachmentDirs[cardId] = entry;
          }

          for (const cardEntry of cardEntries) {
            if (cardEntry.type === LinkType.Dir) continue;
            const cardData = await tree.readFile(cardEntry.cid);
            if (!cardData) continue;
            const fallbackCardId = cardIdFromFilename(cardEntry.name);
            const card = parseCardData(cardData, fallbackCardId);
            if (!card) continue;

            const attachmentDir = attachmentDirs[card.id] || attachmentDirs[fallbackCardId];
            if (attachmentDir) {
              const attachmentEntries = sortEntriesByName(await tree.listDirectory(attachmentDir.cid))
                .filter(entry => entry.type !== LinkType.Dir);

              const existingByFileName: Record<string, true> = {};
              for (const attachment of card.attachments) {
                existingByFileName[attachment.fileName] = true;
              }
              for (const attachmentEntry of attachmentEntries) {
                if (existingByFileName[attachmentEntry.name]) continue;
                card.attachments.push({
                  id: createBoardId(),
                  fileName: attachmentEntry.name,
                  displayName: attachmentEntry.name,
                  mimeType: guessMimeType(attachmentEntry.name),
                  size: attachmentEntry.size,
                  uploaderNpub: fallbackUpdatedBy,
                  cidHash: toHex(attachmentEntry.cid.hash),
                  cidKey: attachmentEntry.cid.key ? toHex(attachmentEntry.cid.key) : undefined,
                });
                existingByFileName[attachmentEntry.name] = true;
              }
            }

            cards.push(card);
          }
        }

        parsedColumns.push({
          id: columnMeta.id,
          title: columnMeta.title,
          cards,
        });
      }
    }

    const hasStructuredBoardData = !!boardMetaEntry || !!boardOrderEntry || !!columnsDirEntry;
    let parsedBoard: BoardState | null = null;

    if (hasStructuredBoardData) {
      const orderedColumns = applyColumnOrder(parsedColumns, boardOrder.columns).map(column => ({
        ...column,
        cards: applyCardOrder(column.cards, boardOrder.cardsByColumn[column.id]),
      }));

      parsedBoard = {
        version: 1,
        boardId: boardMeta?.boardId || parsedPermissions?.boardId || fallbackBoardId,
        title: boardMeta?.title || parsedPermissions?.title || fallbackTitle,
        columns: orderedColumns,
        updatedAt: boardMeta?.updatedAt || parsedPermissions?.updatedAt || Date.now(),
        updatedBy: boardMeta?.updatedBy || parsedPermissions?.updatedBy || fallbackUpdatedBy,
      };

      if (parsedBoard.columns.length === 0 && legacyBoardState?.columns.length) {
        parsedBoard = legacyBoardState;
      }
    } else if (legacyBoardState) {
      parsedBoard = legacyBoardState;
    }

    return { board: parsedBoard, permissions: parsedPermissions };
  }

  async function loadParticipantData(
    participantNpub: string,
    treeName: string,
    boardPath: string[]
  ): Promise<{ board: BoardState | null; permissions: BoardPermissions | null } | null> {
    let participantRoot: CID | null = null;

    if (participantNpub === viewedNpub) {
      participantRoot = treeRoot;
    } else {
      participantRoot = await waitForTreeRoot(participantNpub, treeName, 3000);
    }

    if (!participantRoot) return null;

    const participantBoardDir = await resolveBoardDirectory(participantRoot, boardPath);
    if (!participantBoardDir) return null;

    return loadBoardFromDirectory(
      participantBoardDir,
      createBoardId(),
      boardDisplayName(treeName),
      participantNpub
    );
  }

  async function hydrateBoardState(generation: number, root: CID) {
    if (!ownerNpub || !route.treeName) return;
    if (!route.treeName.startsWith('boards/')) {
      if (generation !== loadGeneration) return;
      error = 'This tree is not a board.';
      loading = false;
      return;
    }

    const boardName = boardDisplayName(route.treeName);
    const boardDirCid = await resolveBoardDirectory(root, route.path);
    if (!boardDirCid) {
      if (generation !== loadGeneration) return;
      error = 'Board not found.';
      loading = false;
      return;
    }

    const localData = await loadBoardFromDirectory(
      boardDirCid,
      createBoardId(),
      boardName,
      viewedNpub || ownerNpub
    );

    const localPermissions = localData.permissions || createInitialBoardPermissions(
      localData.board?.boardId || createBoardId(),
      localData.board?.title || boardName,
      ownerNpub
    );

    const permissionCandidates: BoardPermissions[] = [localPermissions];
    const boardCandidates: BoardState[] = [];
    if (localData.board) boardCandidates.push(localData.board);

    const participants = new Set<string>([
      ownerNpub,
      ...localPermissions.admins,
      ...localPermissions.writers,
    ]);

    for (const participant of participants) {
      if (participant === viewedNpub) continue;
      const participantData = await loadParticipantData(participant, route.treeName, route.path);
      if (!participantData) continue;
      if (participantData.permissions) permissionCandidates.push(participantData.permissions);
      if (participantData.board) boardCandidates.push(participantData.board);
    }

    permissionCandidates.sort((a, b) => b.updatedAt - a.updatedAt);
    const resolvedPermissions = permissionCandidates[0] || localPermissions;

    if (boardCandidates.length === 0) {
      boardCandidates.push(createInitialBoardState(
        resolvedPermissions.boardId || createBoardId(),
        resolvedPermissions.title || boardName,
        ownerNpub
      ));
    }

    boardCandidates.sort((a, b) => b.updatedAt - a.updatedAt);
    const resolvedBoard = boardCandidates[0];

    if (generation !== loadGeneration) return;
    permissions = resolvedPermissions;
    board = resolvedBoard;
    error = null;
    loading = false;
  }

  $effect(() => {
    const root = treeRoot;
    const treeName = route.treeName;

    if (!root || !treeName) {
      loading = true;
      return;
    }

    loadGeneration += 1;
    const generation = loadGeneration;
    loading = true;
    error = null;
    void hydrateBoardState(generation, root);
  });

  async function ensureOwnRootCid(): Promise<CID | null> {
    if (!userNpub || !route.treeName) return null;
    const tree = getTree();
    let rootCid = getTreeRootSync(userNpub, route.treeName);
    if (!rootCid) {
      const { cid: emptyDirCid } = await tree.putDirectory([]);
      rootCid = emptyDirCid;
    }

    const boardPath = route.path;
    for (let i = 0; i < boardPath.length; i += 1) {
      const fullPath = boardPath.slice(0, i + 1).join('/');
      const existing = await tree.resolvePath(rootCid, fullPath);
      if (existing) continue;
      const { cid: emptyDirCid } = await tree.putDirectory([]);
      rootCid = await tree.setEntry(
        rootCid,
        boardPath.slice(0, i),
        boardPath[i],
        emptyDirCid,
        0,
        LinkType.Dir
      );
    }

    return rootCid;
  }

  function publishUpdatedRoot(rootCid: CID) {
    if (!route.treeName || !userNpub) return;

    if (isOwnBoard) {
      autosaveIfOwn(rootCid);
      return;
    }

    updateLocalRootCacheHex(
      userNpub,
      route.treeName,
      toHex(rootCid.hash),
      rootCid.key ? toHex(rootCid.key) : undefined,
      (visibility as 'public' | 'link-visible' | 'private') || 'public'
    );
  }

  async function putTextFile(text: string): Promise<{ cid: CID; size: number }> {
    const tree = getTree();
    const data = new TextEncoder().encode(text);
    return tree.putFile(data);
  }

  function attachmentCid(attachment: BoardCardAttachment): CID | null {
    try {
      const hash = fromHex(attachment.cidHash);
      const key = attachment.cidKey ? fromHex(attachment.cidKey) : undefined;
      return makeCid(hash, key);
    } catch {
      return null;
    }
  }

  async function buildBoardDirectoryCid(nextBoard: BoardState, nextPermissions: BoardPermissions): Promise<CID> {
    const tree = getTree();
    const columnEntries: TreeEntry[] = [];

    for (const column of nextBoard.columns) {
      const cardEntries: TreeEntry[] = [];
      for (const card of column.cards) {
        const { cid: cardCid, size: cardSize } = await putTextFile(serializeCardData(card));
        cardEntries.push({
          name: `${card.id}${BOARD_CARD_FILE_SUFFIX}`,
          cid: cardCid,
          size: cardSize,
          type: LinkType.Blob,
        });

        if (card.attachments.length > 0) {
          const attachmentEntries: TreeEntry[] = [];
          for (const attachment of card.attachments) {
            const fileCid = attachmentCid(attachment);
            if (!fileCid) continue;
            attachmentEntries.push({
              name: attachment.fileName,
              cid: fileCid,
              size: attachment.size,
              type: LinkType.Blob,
            });
          }
          if (attachmentEntries.length > 0) {
            const { cid: attachmentsDirCid } = await tree.putDirectory(attachmentEntries);
            cardEntries.push({
              name: cardAttachmentsDirName(card.id),
              cid: attachmentsDirCid,
              size: 0,
              type: LinkType.Dir,
            });
          }
        }
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
    const { cid: boardMetaCid, size: boardMetaSize } = await putTextFile(serializeBoardMeta(nextBoard));
    const { cid: boardOrderCid, size: boardOrderSize } = await putTextFile(serializeBoardOrder(nextBoard));
    const { cid: permissionsCid, size: permissionsSize } = await putTextFile(serializeBoardPermissions(nextPermissions));

    const { cid: boardDirCid } = await tree.putDirectory([
      { name: BOARD_META_FILE, cid: boardMetaCid, size: boardMetaSize, type: LinkType.Blob },
      { name: BOARD_ORDER_FILE, cid: boardOrderCid, size: boardOrderSize, type: LinkType.Blob },
      { name: BOARD_PERMISSIONS_FILE, cid: permissionsCid, size: permissionsSize, type: LinkType.Blob },
      { name: BOARD_COLUMNS_DIR, cid: columnsCid, size: 0, type: LinkType.Dir },
    ]);

    return boardDirCid;
  }

  async function persistBoardDirectory(nextBoard: BoardState, nextPermissions: BoardPermissions): Promise<boolean> {
    if (!userNpub || !route.treeName) return false;
    const tree = getTree();
    const rootCid = await ensureOwnRootCid();
    if (!rootCid) return false;

    const boardDirCid = await buildBoardDirectoryCid(nextBoard, nextPermissions);
    const boardPath = route.path;
    const newRootCid = boardPath.length === 0
      ? boardDirCid
      : await tree.setEntry(
        rootCid,
        boardPath.slice(0, -1),
        boardPath[boardPath.length - 1],
        boardDirCid,
        0,
        LinkType.Dir
      );

    publishUpdatedRoot(newRootCid);
    return true;
  }

  async function persistBoard(nextBoard: BoardState) {
    if (!canWrite || !userNpub) return;
    savingBoard = true;
    try {
      const nextPermissions = permissions
        ? {
          ...permissions,
          boardId: nextBoard.boardId,
          title: nextBoard.title,
        }
        : createInitialBoardPermissions(nextBoard.boardId, nextBoard.title, userNpub, nextBoard.updatedAt);

      const success = await persistBoardDirectory(nextBoard, nextPermissions);
      if (success) {
        board = nextBoard;
        permissions = nextPermissions;
      }
    } finally {
      savingBoard = false;
    }
  }

  async function persistPermissions(nextPermissions: BoardPermissions) {
    if (!canManage || !board) return;
    savingPermissions = true;
    try {
      const syncedPermissions: BoardPermissions = {
        ...nextPermissions,
        boardId: board.boardId,
        title: board.title,
      };
      const success = await persistBoardDirectory(board, syncedPermissions);
      if (success) permissions = syncedPermissions;
    } finally {
      savingPermissions = false;
    }
  }

  function queueBoardSave(nextBoard: BoardState) {
    board = nextBoard;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void persistBoard(nextBoard);
    }, 700);
  }

  function mutateBoard(mutator: (next: BoardState) => void) {
    if (!board || !userNpub || !canWrite) return;
    const next = cloneBoardState(board);
    mutator(next);
    next.updatedAt = Date.now();
    next.updatedBy = userNpub;
    queueBoardSave(next);
  }

  function normalizeTitle(value: string, fallback: string): string {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  function addColumn(title: string) {
    mutateBoard(next => {
      next.columns.push({
        id: createBoardId(),
        title: normalizeTitle(title, 'Untitled Column'),
        cards: [],
      });
    });
  }

  function updateColumnTitle(columnId: string, title: string) {
    mutateBoard(next => {
      const column = next.columns.find(item => item.id === columnId);
      if (!column) return;
      column.title = normalizeTitle(title, 'Untitled Column');
    });
  }

  function removeColumn(columnId: string) {
    mutateBoard(next => {
      const index = next.columns.findIndex(column => column.id === columnId);
      if (index !== -1) next.columns.splice(index, 1);
    });
  }

  function addCard(columnId: string, title: string, description: string) {
    mutateBoard(next => {
      const column = next.columns.find(item => item.id === columnId);
      if (!column) return;
      column.cards.push({
        id: createBoardId(),
        title: normalizeTitle(title, 'Untitled'),
        description: description.trim(),
        attachments: [],
      });
    });
  }

  function updateCard(columnId: string, cardId: string, title: string, description: string) {
    mutateBoard(next => {
      const column = next.columns.find(item => item.id === columnId);
      const card = column?.cards.find(item => item.id === cardId);
      if (!card) return;
      card.title = normalizeTitle(title, 'Untitled');
      card.description = description.trim();
    });
  }

  function removeCard(columnId: string, cardId: string) {
    mutateBoard(next => {
      const column = next.columns.find(item => item.id === columnId);
      if (!column) return;
      const index = column.cards.findIndex(card => card.id === cardId);
      if (index !== -1) column.cards.splice(index, 1);
    });
  }

  function triggerAttachmentPicker(columnId: string, cardId: string) {
    if (!canWrite || !attachmentInputRef) return;
    attachmentTarget = { columnId, cardId };
    attachmentInputRef.click();
  }

  async function handleAttachmentInputChange(event: Event) {
    if (!canWrite || !userNpub) return;
    const input = event.target as HTMLInputElement;
    const selectedFiles = input.files ? Array.from(input.files) : [];
    const target = attachmentTarget;
    input.value = '';
    attachmentTarget = null;

    if (!target || selectedFiles.length === 0) return;
    const cardKey = `${target.columnId}:${target.cardId}`;
    uploadingCardMap = { ...uploadingCardMap, [cardKey]: true };

    try {
      const tree = getTree();
      const uploaded: BoardCardAttachment[] = [];
      const totalBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
      let uploadedBytes = 0;

      for (let index = 0; index < selectedFiles.length; index += 1) {
        const file = selectedFiles[index];
        setUploadProgress({
          current: index + 1,
          total: selectedFiles.length,
          fileName: file.name,
          bytes: uploadedBytes,
          totalBytes,
          status: 'reading',
        });
        const bytes = new Uint8Array(await file.arrayBuffer());
        setUploadProgress({
          current: index + 1,
          total: selectedFiles.length,
          fileName: file.name,
          bytes: uploadedBytes,
          totalBytes,
          status: 'writing',
        });
        const { cid: fileCid, size: fileSize } = await tree.putFile(bytes);
        uploadedBytes += fileSize;
        setUploadProgress({
          current: index + 1,
          total: selectedFiles.length,
          fileName: file.name,
          bytes: uploadedBytes,
          totalBytes,
          status: 'finalizing',
        });
        const attachmentId = createBoardId();
        const cleanName = sanitizeAttachmentFileName(file.name);
        uploaded.push({
          id: attachmentId,
          fileName: `${attachmentId}-${cleanName}`,
          displayName: cleanName,
          mimeType: file.type || guessMimeType(file.name),
          size: fileSize,
          uploaderNpub: userNpub,
          cidHash: toHex(fileCid.hash),
          cidKey: fileCid.key ? toHex(fileCid.key) : undefined,
        });
      }

      if (uploaded.length > 0) {
        mutateBoard(next => {
          const column = next.columns.find(item => item.id === target.columnId);
          const card = column?.cards.find(item => item.id === target.cardId);
          if (!card) return;
          card.attachments = [...card.attachments, ...uploaded];
        });
      }
    } catch (err) {
      console.error('[Boards] Attachment upload failed:', err);
      toast.error('Failed to upload attachment');
    } finally {
      setUploadProgress(null);
      const nextMap = { ...uploadingCardMap };
      delete nextMap[cardKey];
      uploadingCardMap = nextMap;
    }
  }

  function removeAttachment(columnId: string, cardId: string, attachmentId: string) {
    mutateBoard(next => {
      const column = next.columns.find(item => item.id === columnId);
      const card = column?.cards.find(item => item.id === cardId);
      if (!card) return;
      card.attachments = card.attachments.filter(attachment => attachment.id !== attachmentId);
    });
  }

  function openCreateColumnModal() {
    if (!canWrite) return;
    columnModalMode = 'create';
    columnModalColumnId = null;
    columnDraftTitle = '';
    columnFormError = '';
    showColumnModal = true;
  }

  function openEditColumnModal(columnId: string, currentTitle: string) {
    if (!canWrite) return;
    columnModalMode = 'edit';
    columnModalColumnId = columnId;
    columnDraftTitle = currentTitle;
    columnFormError = '';
    showColumnModal = true;
  }

  function closeColumnModal() {
    showColumnModal = false;
    columnFormError = '';
  }

  function submitColumnModal() {
    if (!canWrite) return;
    const title = columnDraftTitle.trim();
    if (!title) {
      columnFormError = 'Column title is required.';
      return;
    }

    if (columnModalMode === 'create') {
      addColumn(title);
    } else if (columnModalColumnId) {
      updateColumnTitle(columnModalColumnId, title);
    }

    closeColumnModal();
  }

  function openCreateCardModal(columnId: string) {
    if (!canWrite) return;
    cardModalMode = 'create';
    cardModalColumnId = columnId;
    cardModalCardId = null;
    cardDraftTitle = '';
    cardDraftDescription = '';
    cardFormError = '';
    showCardModal = true;
  }

  function openEditCardModal(columnId: string, card: BoardCard) {
    if (!canWrite) return;
    cardModalMode = 'edit';
    cardModalColumnId = columnId;
    cardModalCardId = card.id;
    cardDraftTitle = card.title;
    cardDraftDescription = card.description;
    cardFormError = '';
    showCardModal = true;
  }

  function closeCardModal() {
    showCardModal = false;
    cardFormError = '';
  }

  function submitCardModal() {
    if (!canWrite) return;
    const title = cardDraftTitle.trim();
    if (!title) {
      cardFormError = 'Card title is required.';
      return;
    }
    if (!cardModalColumnId) {
      cardFormError = 'Column not found.';
      return;
    }

    if (cardModalMode === 'create') {
      addCard(cardModalColumnId, title, cardDraftDescription);
    } else if (cardModalCardId) {
      updateCard(cardModalColumnId, cardModalCardId, title, cardDraftDescription);
    }

    closeCardModal();
  }

  function moveCardToColumn(
    fromColumnId: string,
    cardId: string,
    toColumnId: string,
    beforeCardId: string | null,
    position: 'before' | 'after' | 'end'
  ) {
    mutateBoard(next => {
      const sourceColumn = next.columns.find(column => column.id === fromColumnId);
      const targetColumn = next.columns.find(column => column.id === toColumnId);
      if (!sourceColumn || !targetColumn) return;

      const cardIndex = sourceColumn.cards.findIndex(card => card.id === cardId);
      if (cardIndex === -1) return;

      const [card] = sourceColumn.cards.splice(cardIndex, 1);

      let insertIndex = targetColumn.cards.length;
      if (beforeCardId) {
        const anchorIndex = targetColumn.cards.findIndex(existingCard => existingCard.id === beforeCardId);
        if (anchorIndex !== -1) {
          insertIndex = position === 'after' ? anchorIndex + 1 : anchorIndex;
        }
      }

      if (insertIndex < 0) insertIndex = 0;
      if (insertIndex > targetColumn.cards.length) insertIndex = targetColumn.cards.length;
      targetColumn.cards.splice(insertIndex, 0, card);
    });
  }

  function handleCardDragStart(event: DragEvent, columnId: string, cardId: string) {
    if (!canWrite) return;
    draggingCard = { cardId, fromColumnId: columnId };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', JSON.stringify(draggingCard));
    }
  }

  function resolveDragCard(event: DragEvent): DragCardState | null {
    if (draggingCard) return draggingCard;
    const payload = event.dataTransfer?.getData('text/plain');
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload) as Partial<DragCardState>;
      if (!parsed.cardId || !parsed.fromColumnId) return null;
      return {
        cardId: parsed.cardId,
        fromColumnId: parsed.fromColumnId,
      };
    } catch {
      return null;
    }
  }

  function clearDragState() {
    draggingCard = null;
    cardDropTarget = null;
  }

  function handleCardDragEnd() {
    clearDragState();
  }

  function handleCardDragOver(event: DragEvent, columnId: string, cardId: string) {
    if (!canWrite || !resolveDragCard(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const position: 'before' | 'after' = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
    cardDropTarget = { columnId, beforeCardId: cardId, position };
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  function handleColumnDragOver(event: DragEvent, columnId: string) {
    if (!canWrite || !resolveDragCard(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    cardDropTarget = { columnId, beforeCardId: null, position: 'end' };
  }

  function executeCardDrop(
    dragState: DragCardState,
    toColumnId: string,
    beforeCardId: string | null,
    position: 'before' | 'after' | 'end'
  ) {
    const noMovement = dragState.fromColumnId === toColumnId && beforeCardId === dragState.cardId;
    if (noMovement) {
      clearDragState();
      return;
    }

    moveCardToColumn(dragState.fromColumnId, dragState.cardId, toColumnId, beforeCardId, position);
    clearDragState();
  }

  function handleCardDrop(event: DragEvent, columnId: string, cardId: string) {
    if (!canWrite) return;
    event.preventDefault();
    event.stopPropagation();
    const dragState = resolveDragCard(event);
    if (!dragState) return;
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const position: 'before' | 'after' = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
    executeCardDrop(dragState, columnId, cardId, position);
  }

  function handleColumnDrop(event: DragEvent, columnId: string) {
    if (!canWrite) return;
    event.preventDefault();
    const dragState = resolveDragCard(event);
    if (!dragState) return;
    executeCardDrop(dragState, columnId, null, 'end');
  }

  function isColumnDropTarget(columnId: string): boolean {
    return !!cardDropTarget && cardDropTarget.columnId === columnId && cardDropTarget.beforeCardId === null;
  }

  function isCardDropTarget(columnId: string, cardId: string): boolean {
    return !!cardDropTarget && cardDropTarget.columnId === columnId && cardDropTarget.beforeCardId === cardId;
  }

  function cardDropTargetClass(columnId: string, cardId: string): string {
    if (!isCardDropTarget(columnId, cardId) || !cardDropTarget) return '';
    return cardDropTarget.position === 'after'
      ? 'ring-2 ring-emerald-500/80 ring-offset-1 ring-offset-surface-1'
      : 'ring-2 ring-accent/80 ring-offset-1 ring-offset-surface-1';
  }

  function isUploadingCard(columnId: string, cardId: string): boolean {
    return !!uploadingCardMap[`${columnId}:${cardId}`];
  }

  function onCardModalSubmit(event: SubmitEvent) {
    event.preventDefault();
    submitCardModal();
  }

  function onColumnModalSubmit(event: SubmitEvent) {
    event.preventDefault();
    submitColumnModal();
  }

  function handleOpenPermissions() {
    permissionNpub = '';
    permissionRole = 'writer';
    permissionError = '';
    showPermissionsModal = true;
  }

  async function handleAddPermission() {
    if (!permissions || !userNpub) return;
    const targetNpub = permissionNpub.trim();
    if (!isValidNpub(targetNpub)) {
      permissionError = 'Enter a valid npub.';
      return;
    }

    const alreadyAdmin = permissions.admins.includes(targetNpub);
    const alreadyWriter = permissions.writers.includes(targetNpub);
    if ((permissionRole === 'admin' && alreadyAdmin) || (permissionRole === 'writer' && alreadyWriter)) {
      permissionError = 'User already has that role.';
      return;
    }

    const next = addBoardPermission(permissions, permissionRole, targetNpub, userNpub);
    permissionError = '';
    permissionNpub = '';
    permissions = next;
    await persistPermissions(next);
  }

  async function handleRemovePermission(role: BoardRole, targetNpub: string) {
    if (!permissions || !userNpub) return;
    const next = removeBoardPermission(permissions, role, targetNpub, userNpub);
    if (next === permissions) {
      permissionError = role === 'admin'
        ? 'Board must have at least one admin.'
        : 'Could not update permissions.';
      return;
    }

    permissionError = '';
    permissions = next;
    await persistPermissions(next);
  }

  function handleShare() {
    openShareModal(window.location.href);
  }

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
  });
</script>

{#if loading}
  <div class="flex-1 flex items-center justify-center text-text-3">
    <span class="i-lucide-loader-2 animate-spin mr-2"></span>
    Loading board...
  </div>
{:else if error}
  <div class="flex-1 flex items-center justify-center text-text-3 p-6">
    <p>{error}</p>
  </div>
{:else if board && permissions}
  <div class="flex-1 flex flex-col min-h-0">
    <input
      bind:this={attachmentInputRef}
      type="file"
      multiple
      class="hidden"
      data-testid="board-attachment-input"
      onchange={handleAttachmentInputChange}
    />

    <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-surface-3 bg-surface-0">
      <div class="min-w-0">
        <h1 class="text-lg font-semibold truncate">{board.title}</h1>
        <div class="mt-1 flex items-center gap-2 text-xs text-text-3">
          <VisibilityIcon {visibility} class="text-xs" />
          {#if canWrite}<span class="text-success">Write access</span>{:else}<span>Read-only</span>{/if}
          {#if savingBoard || savingPermissions}<span class="animate-pulse">Saving...</span>{/if}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn-circle btn-ghost" onclick={handleShare} title="Share board">
          <span class="i-lucide-share-2"></span>
        </button>
        {#if canManage}
          <button class="btn-ghost" onclick={handleOpenPermissions} title="Manage permissions">
            <span class="i-lucide-shield-check mr-1"></span>
            Permissions
          </button>
        {/if}
        {#if canWrite}
          <button class="btn-primary" onclick={openCreateColumnModal}>
            <span class="i-lucide-columns-2 mr-1"></span>
            Add Column
          </button>
        {/if}
      </div>
    </div>

    <div class="flex-1 overflow-auto p-4">
      <div class="flex gap-4 items-start min-h-full pb-4">
        {#each board.columns as column (column.id)}
          <section
            data-testid={`board-column-${column.title}`}
            class="w-80 max-w-80 shrink-0 bg-surface-1 rounded-xl border border-surface-3 p-3 shadow-sm space-y-3"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <h2 class="font-semibold text-sm truncate">{column.title}</h2>
                <p class="text-[11px] text-text-3 mt-1">
                  {column.cards.length} {column.cards.length === 1 ? 'card' : 'cards'}
                </p>
              </div>
              {#if canWrite}
                <div class="flex items-center gap-1">
                  <button
                    class="btn-circle btn-ghost"
                    aria-label="Edit column"
                    title="Edit column"
                    onclick={() => openEditColumnModal(column.id, column.title)}
                  >
                    <span class="i-lucide-pencil text-sm"></span>
                  </button>
                  <button
                    class="btn-circle btn-ghost text-danger"
                    aria-label="Remove column"
                    title="Remove column"
                    onclick={() => removeColumn(column.id)}
                  >
                    <span class="i-lucide-trash-2 text-sm"></span>
                  </button>
                </div>
              {/if}
            </div>

            <div
              data-testid={`board-column-cards-${column.title}`}
              role="list"
              aria-label={`${column.title} cards`}
              class={`min-h-12 space-y-2 rounded-md transition-colors ${isColumnDropTarget(column.id) ? 'bg-accent/10 ring-2 ring-dashed ring-accent/60 p-2' : ''}`}
              ondragover={(event) => handleColumnDragOver(event as DragEvent, column.id)}
              ondrop={(event) => handleColumnDrop(event as DragEvent, column.id)}
            >
              {#if column.cards.length === 0}
                <div class="rounded-md border border-dashed border-surface-3 py-5 px-3 text-xs text-text-3 text-center">
                  Drop cards here or add a new one.
                </div>
              {/if}
              {#each column.cards as card (card.id)}
                <article
                  data-testid={`board-card-${card.title}`}
                  data-card-id={card.id}
                  draggable={canWrite}
                  ondragstart={(event) => handleCardDragStart(event as DragEvent, column.id, card.id)}
                  ondragend={handleCardDragEnd}
                  ondragover={(event) => handleCardDragOver(event as DragEvent, column.id, card.id)}
                  ondrop={(event) => handleCardDrop(event as DragEvent, column.id, card.id)}
                  class={`group bg-surface-0 border border-surface-3 rounded-lg p-3 transition-shadow ${canWrite ? 'cursor-grab active:cursor-grabbing hover:shadow-md' : ''} ${draggingCard?.cardId === card.id ? 'opacity-50' : ''} ${cardDropTargetClass(column.id, card.id)}`}
                >
                  {#if canWrite}
                    <button
                      type="button"
                      class="w-full text-left"
                      onclick={() => openEditCardModal(column.id, card)}
                    >
                      <h3 class="text-sm font-medium break-words">{card.title}</h3>
                      {#if card.description}
                        <p class="text-xs text-text-3 mt-1 whitespace-pre-wrap line-clamp-3">{card.description}</p>
                      {/if}
                    </button>
                  {:else}
                    <h3 class="text-sm font-medium break-words">{card.title}</h3>
                    {#if card.description}
                      <p class="text-xs text-text-3 mt-1 whitespace-pre-wrap line-clamp-3">{card.description}</p>
                    {/if}
                  {/if}

                  {#if card.attachments.length > 0}
                    <div class="mt-2 space-y-1">
                      {#each card.attachments as attachment (attachment.id)}
                        {@const attachmentUrl = cardAttachmentUrl(attachment)}
                        <div
                          class="rounded-md border border-surface-3 bg-surface-1 px-2 py-1.5"
                          data-testid={`board-card-attachment-${attachment.displayName}`}
                        >
                          {#if isImageAttachment(attachment) && attachmentUrl}
                            <button
                              type="button"
                              class="block w-full bg-transparent border-none p-0 cursor-zoom-in"
                              title={attachment.displayName}
                              onclick={(event) => {
                                event.stopPropagation();
                                openAttachmentPreview(attachment);
                              }}
                            >
                              <img
                                class="w-full max-h-32 object-cover rounded border border-surface-3"
                                src={attachmentUrl}
                                alt={attachment.displayName}
                              />
                            </button>
                          {/if}
                          <div class="mt-1 flex items-center justify-between gap-2">
                            {#if isModalPreviewAttachment(attachment) && attachmentUrl}
                              <button
                                type="button"
                                class="text-xs text-accent hover:underline truncate bg-transparent border-none p-0 text-left"
                                title={attachment.displayName}
                                onclick={(event) => {
                                  event.stopPropagation();
                                  openAttachmentPreview(attachment);
                                }}
                              >
                                {attachment.displayName}
                              </button>
                            {:else if attachmentUrl}
                              <a
                                class="text-xs text-accent hover:underline truncate"
                                href={attachmentUrl}
                                target="_blank"
                                rel="noreferrer"
                                title={attachment.displayName}
                              >
                                {attachment.displayName}
                              </a>
                            {:else}
                              <span class="text-xs text-text-3 truncate" title={attachment.displayName}>
                                {attachment.displayName}
                              </span>
                            {/if}
                            <div class="flex items-center gap-1 shrink-0">
                              <span class="text-[10px] text-text-3">{formatAttachmentSize(attachment.size)}</span>
                              {#if canWrite}
                                <button
                                  type="button"
                                  class="btn-circle btn-ghost text-danger"
                                  title={`Remove ${attachment.displayName}`}
                                  onclick={(event) => {
                                    event.stopPropagation();
                                    removeAttachment(column.id, card.id, attachment.id);
                                  }}
                                >
                                  <span class="i-lucide-x text-[10px]"></span>
                                </button>
                              {/if}
                            </div>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}

                  {#if canWrite}
                    <div class="mt-3 pt-2 border-t border-surface-3 flex items-center justify-end gap-1">
                      <button
                        class="btn-circle btn-ghost"
                        aria-label="Attach file"
                        title="Attach file"
                        disabled={isUploadingCard(column.id, card.id)}
                        onclick={(event) => {
                          event.stopPropagation();
                          triggerAttachmentPicker(column.id, card.id);
                        }}
                      >
                        {#if isUploadingCard(column.id, card.id)}
                          <span class="i-lucide-loader-2 text-xs animate-spin"></span>
                        {:else}
                          <span class="i-lucide-paperclip text-xs"></span>
                        {/if}
                      </button>
                      <button
                        class="btn-circle btn-ghost"
                        aria-label="Edit card"
                        title="Edit card"
                        onclick={(event) => {
                          event.stopPropagation();
                          openEditCardModal(column.id, card);
                        }}
                      >
                        <span class="i-lucide-pencil text-xs"></span>
                      </button>
                      <button
                        class="btn-circle btn-ghost text-danger"
                        aria-label="Remove card"
                        title="Remove card"
                        onclick={(event) => {
                          event.stopPropagation();
                          removeCard(column.id, card.id);
                        }}
                      >
                        <span class="i-lucide-trash-2 text-xs"></span>
                      </button>
                    </div>
                  {/if}
                </article>
              {/each}
            </div>

            {#if canWrite}
              <button class="btn-ghost w-full text-sm" onclick={() => openCreateCardModal(column.id)}>
                <span class="i-lucide-plus mr-1"></span>
                Add Card
              </button>
            {/if}
          </section>
        {/each}
        {#if canWrite}
          <button
            class="w-80 max-w-80 shrink-0 rounded-xl border border-dashed border-surface-3 text-text-2 hover:text-text-1 hover:border-accent transition-colors py-8 px-4 text-sm"
            onclick={openCreateColumnModal}
          >
            <span class="i-lucide-plus mr-1"></span>
            Add another column
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if showColumnModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    data-modal-backdrop
    onclick={closeColumnModal}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="w-full max-w-md mx-4" onclick={(event) => event.stopPropagation()}>
      <form
        class="bg-surface-1 rounded-lg shadow-lg border border-surface-3 p-5 space-y-4"
        onsubmit={onColumnModalSubmit}
      >
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-semibold">{columnModalMode === 'create' ? 'Create Column' : 'Edit Column'}</h3>
          <button type="button" class="btn-circle btn-ghost" onclick={closeColumnModal} aria-label="Close column dialog">
            <span class="i-lucide-x"></span>
          </button>
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium" for="board-column-title">Column title</label>
          <input
            id="board-column-title"
            class="input w-full text-sm"
            bind:value={columnDraftTitle}
            placeholder="Backlog"
          />
          {#if columnFormError}
            <p class="text-xs text-danger">{columnFormError}</p>
          {/if}
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" class="btn-ghost" onclick={closeColumnModal}>Cancel</button>
          <button type="submit" class="btn-primary">
            {columnModalMode === 'create' ? 'Create Column' : 'Save Column'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

{#if showCardModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
    data-modal-backdrop
    onclick={closeCardModal}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="w-full max-w-lg mx-4" onclick={(event) => event.stopPropagation()}>
      <form
        class="bg-surface-1 rounded-lg shadow-lg border border-surface-3 p-5 space-y-4"
        onsubmit={onCardModalSubmit}
      >
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-semibold">{cardModalMode === 'create' ? 'Create Card' : 'Edit Card'}</h3>
          <button type="button" class="btn-circle btn-ghost" onclick={closeCardModal} aria-label="Close card dialog">
            <span class="i-lucide-x"></span>
          </button>
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium" for="board-card-title">Card title</label>
          <input
            id="board-card-title"
            aria-label="Card title"
            class="input w-full text-sm"
            bind:value={cardDraftTitle}
            placeholder="Task title"
          />
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium" for="board-card-description">Card description</label>
          <textarea
            id="board-card-description"
            aria-label="Card description"
            class="w-full text-sm min-h-32 rounded-lg border border-surface-3 bg-surface-0 px-3 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-accent/40"
            bind:value={cardDraftDescription}
            placeholder="Details..."
          ></textarea>
          {#if cardFormError}
            <p class="text-xs text-danger">{cardFormError}</p>
          {/if}
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" class="btn-ghost" onclick={closeCardModal}>Cancel</button>
          <button type="submit" class="btn-primary">
            {cardModalMode === 'create' ? 'Create Card' : 'Save Card'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

{#if showMediaModal && mediaAttachment}
  {@const mediaAttachmentUrl = cardAttachmentUrl(mediaAttachment)}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
    data-modal-backdrop
    role="dialog"
    aria-modal="true"
    aria-label="Attachment preview"
    onclick={closeAttachmentPreview}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="w-full max-w-5xl bg-surface-1 border border-surface-3 rounded-lg shadow-lg p-4 space-y-3"
      onclick={(event) => event.stopPropagation()}
    >
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-lg font-semibold">Attachment preview</h3>
        <div class="flex items-center gap-2">
          {#if mediaAttachmentUrl}
            <a
              class="btn-ghost text-sm"
              href={mediaAttachmentUrl}
              target="_blank"
              rel="noreferrer"
              title={mediaAttachment.displayName}
            >
              Open file
            </a>
          {/if}
          <button type="button" class="btn-circle btn-ghost" onclick={closeAttachmentPreview} aria-label="Close attachment preview">
            <span class="i-lucide-x"></span>
          </button>
        </div>
      </div>
      <div class="bg-surface-0 border border-surface-3 rounded-lg overflow-hidden h-[70vh] min-h-72">
        {#if isImageAttachment(mediaAttachment) && mediaAttachmentUrl}
          <div class="h-full w-full flex items-center justify-center p-3">
            <img
              src={mediaAttachmentUrl}
              alt={mediaAttachment.displayName}
              class="max-w-full max-h-full object-contain"
            />
          </div>
        {:else if isVideoAttachment(mediaAttachment)}
          {@const previewCid = attachmentCid(mediaAttachment)}
          {#if previewCid}
            <MediaPlayer cid={previewCid} fileName={mediaAttachment.displayName || mediaAttachment.fileName} type="video" />
          {:else}
            <div class="h-full flex items-center justify-center text-text-3 text-sm">Unable to open preview for this file.</div>
          {/if}
        {:else if isAudioAttachment(mediaAttachment)}
          {@const previewCid = attachmentCid(mediaAttachment)}
          {#if previewCid}
            <MediaPlayer cid={previewCid} fileName={mediaAttachment.displayName || mediaAttachment.fileName} type="audio" />
          {:else}
            <div class="h-full flex items-center justify-center text-text-3 text-sm">Unable to open preview for this file.</div>
          {/if}
        {:else}
          <div class="h-full flex items-center justify-center text-text-3 text-sm">Preview not available for this attachment.</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if showPermissionsModal && permissions}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onclick={() => showPermissionsModal = false}>
    <div class="bg-surface-1 rounded-lg shadow-lg w-full max-w-lg mx-4 border border-surface-3 p-5 space-y-4" onclick={(e) => e.stopPropagation()}>
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold">Board Permissions</h3>
        <button class="btn-circle btn-ghost" onclick={() => showPermissionsModal = false} aria-label="Close permissions dialog">
          <span class="i-lucide-x"></span>
        </button>
      </div>

      <div class="text-xs text-text-3">
        Admins can manage admins/writers and edit cards. Writers can edit cards only.
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-2">
          <div class="text-sm font-medium">Admins</div>
          <ul class="space-y-1 list-none m-0 p-0">
            {#each permissions.admins as adminNpub (adminNpub)}
              <li class="bg-surface-2 rounded px-2 py-1.5 flex items-center justify-between gap-2">
                <span class="font-mono text-xs truncate">{adminNpub}</span>
                <button
                  class="btn-circle btn-ghost text-danger"
                  title="Remove admin"
                  onclick={() => handleRemovePermission('admin', adminNpub)}
                >
                  <span class="i-lucide-x text-xs"></span>
                </button>
              </li>
            {/each}
          </ul>
        </div>

        <div class="space-y-2">
          <div class="text-sm font-medium">Writers</div>
          <ul class="space-y-1 list-none m-0 p-0">
            {#if permissions.writers.length === 0}
              <li class="bg-surface-2 rounded px-2 py-1.5 text-xs text-text-3">No writers assigned</li>
            {/if}
            {#each permissions.writers as writerNpub (writerNpub)}
              <li class="bg-surface-2 rounded px-2 py-1.5 flex items-center justify-between gap-2">
                <span class="font-mono text-xs truncate">{writerNpub}</span>
                <button
                  class="btn-circle btn-ghost text-danger"
                  title="Remove writer"
                  onclick={() => handleRemovePermission('writer', writerNpub)}
                >
                  <span class="i-lucide-x text-xs"></span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      </div>

      <div class="space-y-2">
        <div class="text-sm font-medium">Assign Role</div>
        <div class="flex gap-2">
          <input
            class="input flex-1 font-mono text-sm"
            placeholder="npub1..."
            bind:value={permissionNpub}
            onkeydown={(e) => e.key === 'Enter' && handleAddPermission()}
          />
          <select class="input w-28" bind:value={permissionRole}>
            <option value="writer">Writer</option>
            <option value="admin">Admin</option>
          </select>
          <button class="btn-success" onclick={handleAddPermission} disabled={savingPermissions}>
            Add
          </button>
        </div>
        {#if permissionError}
          <p class="text-xs text-danger">{permissionError}</p>
        {/if}
      </div>
    </div>
  </div>
{/if}
