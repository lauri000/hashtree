  <script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { cid as makeCid, fromHex, LinkType, nhashEncode, toHex, type CID, type TreeEntry, type TreeVisibility } from '@hashtree/core';
  import DOMPurify from 'dompurify';
  import { marked } from 'marked';
  import { nip19 } from 'nostr-tools';
  import { getNhashFileUrl } from '../../lib/mediaUrl';
  import { treeRootRegistry } from '../../TreeRootRegistry';
  import {
    getBoardRouteKey,
    resolveHydratedBoardResult,
    shouldScheduleHydratedBoardRetry,
    shouldApplyHydratedBoardState,
    shouldShowBoardLoading,
  } from '../../lib/boards/viewState';
  import { syncSelectedTreeForOwnRoute } from '../../lib/selectedTree';
  import { getTree } from '../../store';
  import { setUploadProgress } from '../../stores/upload';
  import { toast } from '../../stores/toast';
  import { routeStore, treeRootStore, createTreesStore, waitForTreeRoot, getTreeRoot, getTreeRootSync, subscribeToTreeRoot, addRecent, updateRecentVisibility, getLinkKey, storeLinkKey } from '../../stores';
  import { autosaveIfOwn, linkKeyUtils, nostrStore, saveHashtree } from '../../nostr';
  import { updateLocalRootCacheHex } from '../../treeRootCache';
  import VisibilityPicker from '../Modals/VisibilityPicker.svelte';
  import { open as openShareModal } from '../Modals/ShareModal.svelte';
  import NpubAccessModal from '../Modals/NpubAccessModal.svelte';
  import Modal from '../ui/Modal.svelte';
  import VisibilityIcon from '../VisibilityIcon.svelte';
  import MediaPlayer from '../Viewer/MediaPlayer.svelte';
  import { Avatar, Name } from '../User';
  import { shortNpub } from '../../utils/format';
  import {
    BOARD_CARD_FILE_SUFFIX,
    BOARD_CARD_ATTACHMENTS_SUFFIX,
    BOARD_CARDS_DIR,
    BOARD_COLUMNS_DIR,
    BOARD_COLUMN_META_FILE,
    BOARD_META_FILE,
    BOARD_ORDER_FILE,
    BOARD_PERMISSIONS_FILE,
    BOARD_TOMBSTONES_FILE,
    addBoardPermission,
    addBoardCard as addBoardCardToState,
    addBoardColumn as addBoardColumnToState,
    cloneBoardTombstones,
    canManageBoard,
    canWriteBoard,
    cloneBoardState,
    createBoardId,
    createInitialBoardPermissions,
    createInitialBoardTombstones,
    buildBoardVisibilityQueryString,
    isProtectedBoardWithoutAccess as computeProtectedBoardWithoutAccess,
    isValidNpub,
    mergeBoardSnapshots,
    moveBoardCard as moveBoardCardInState,
    moveBoardColumn as moveBoardColumnInState,
    mutateBoardCard as mutateBoardCardInState,
    parseBoardMeta,
    parseBoardOrder,
    parseBoardTombstones,
    parseCardData,
    parseColumnMeta,
    parseBoardPermissions,
    parseBoardState,
    removeBoardCard as removeBoardCardFromState,
    removeBoardColumn as removeBoardColumnFromState,
    resolveBoardPublishLabels,
    removeBoardPermission,
    resolveBoardVisibility,
    resolveBoardVisibilityLinkKey,
    serializeBoardMeta,
    serializeBoardOrder,
    serializeBoardTombstones,
    serializeCardData,
    serializeColumnMeta,
    serializeBoardPermissions,
    updateBoardColumnTitle as updateBoardColumnTitleInState,
    type BoardCardAttachment,
    type BoardCardComment,
    type BoardCard,
    type BoardColumn,
    type BoardMergeSource,
    type BoardPermissions,
    type BoardState,
    type BoardTombstones,
  } from '../../lib/boards';

  let route = $derived($routeStore);
  let treeRoot = $derived($treeRootStore);
  let userNpub = $derived($nostrStore.npub);
  let viewedNpub = $derived(route.npub);
  let ownerNpub = $derived(viewedNpub || userNpub || '');
  let isOwnBoard = $derived(!!userNpub && userNpub === viewedNpub);

  let targetNpub = $derived(viewedNpub || userNpub);
  let treesStore = $derived(createTreesStore(targetNpub));
  let trees = $state<Array<{ name: string; visibility?: TreeVisibility; labels?: string[] }>>([]);
  let ownerPubkey = $derived(ownerNpub ? npubToPubkey(ownerNpub) : null);

  $effect(() => {
    const store = treesStore;
    const unsub = store.subscribe(value => {
      trees = value;
    });
    return unsub;
  });

  let currentTree = $derived(route.treeName ? trees.find(tree => tree.name === route.treeName) : null);
  let routeVisibility = $derived.by(() => {
    treeRoot;
    if (!route.npub || !route.treeName) return undefined;
    return treeRootRegistry.getVisibility(route.npub, route.treeName);
  });
  let resolvedVisibility = $derived(
    resolveBoardVisibility(currentTree?.visibility as 'public' | 'link-visible' | 'private' | undefined, routeVisibility)
  );
  let visibility = $derived((resolvedVisibility || 'public') as TreeVisibility);
  let linkKey = $derived(route.params.get('k'));
  let missingDecryptionKey = $derived(!treeRoot?.key);
  let isProtectedBoardWithoutAccess = $derived(
    computeProtectedBoardWithoutAccess(isOwnBoard, !missingDecryptionKey, resolvedVisibility)
  );

  let loading = $state(true);
  let savingBoard = $state(false);
  let savingPermissions = $state(false);
  let error = $state<string | null>(null);
  let board = $state<BoardState | null>(null);
  let permissions = $state<BoardPermissions | null>(null);
  let tombstones = $state<BoardTombstones>(createInitialBoardTombstones());

  let showPermissionsModal = $state(false);
  let visibilityDraft = $state<TreeVisibility>('public');
  let visibilityError = $state('');
  let savingVisibility = $state(false);

  let showCardModal = $state(false);
  let cardModalMode = $state<'create' | 'edit'>('create');
  let cardModalColumnId = $state('');
  let cardModalCardId = $state<string | null>(null);
  let cardDraftTitle = $state('');
  let cardDraftDescription = $state('');
  let cardDraftAssigneeNpubs = $state<string[]>([]);
  let cardDraftAttachments = $state<BoardCardAttachment[]>([]);
  let cardDraftOriginalAttachmentIds = $state<Record<string, true>>({});
  let cardDraftUploading = $state(false);
  let cardFormError = $state('');
  let showCardViewModal = $state(false);
  let cardViewColumnId = $state<string | null>(null);
  let cardViewCardId = $state<string | null>(null);
  let showMediaModal = $state(false);
  let mediaAttachment = $state<BoardCardAttachment | null>(null);

  let cardAttachmentInputRef: HTMLInputElement | undefined = $state();
  let attachmentInputRef: HTMLInputElement | undefined = $state();
  let attachmentTarget = $state<{ columnId: string; cardId: string } | null>(null);
  let uploadingCardMap = $state<Record<string, true>>({});
  let localAttachmentPreviewUrls = $state<Record<string, string>>({});
  let previewBoardId = $state<string | null>(null);
  let commentAttachmentInputRef: HTMLInputElement | undefined = $state();
  let commentDraftMarkdown = $state('');
  let commentDraftAttachments = $state<Array<{
    id: string;
    file: File;
    displayName: string;
    mimeType: string;
    size: number;
    previewUrl: string | null;
  }>>([]);
  let commentSubmitting = $state(false);
  let commentFormError = $state('');

  let showColumnModal = $state(false);
  let columnModalMode = $state<'create' | 'edit'>('create');
  let columnModalColumnId = $state<string | null>(null);
  let columnDraftTitle = $state('');
  let columnFormError = $state('');
  let columnTitleInputRef = $state<HTMLInputElement | null>(null);
  let cardTitleInputRef = $state<HTMLInputElement | null>(null);

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

  interface DragColumnState {
    columnId: string;
  }

  interface ColumnDropTarget {
    columnId: string;
    position: 'before' | 'after';
  }

  let draggingColumn = $state<DragColumnState | null>(null);
  let columnDropTarget = $state<ColumnDropTarget | null>(null);

  let saveQueued = false;
  let pendingBoardSave: {
    board: BoardState;
    tombstones: BoardTombstones;
    permissions: BoardPermissions | null;
  } | null = null;
  let hydrateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let hydrateRetryAttempts = 0;
  let hydrateRetryKey: string | null = null;
  let hydratedRouteKey: string | null = null;
  let participantHydrateTimer: ReturnType<typeof setTimeout> | null = null;
  let participantHydrationNonce = $state(0);
  let loadGeneration = 0;
  const HYDRATE_RETRY_DELAY_MS = 1500;
  const LOCAL_HYDRATE_MAX_RETRIES = 3;
  const REMOTE_HYDRATE_MAX_RETRIES = 24;
  const PARTICIPANT_ROOT_WAIT_MS = 250;

  let canManage = $derived(
    !!permissions && !!ownerNpub && canManageBoard(permissions, userNpub, ownerNpub)
  );
  let canWrite = $derived(
    !!permissions && !!ownerNpub && canWriteBoard(permissions, userNpub, ownerNpub)
  );
  let boardMemberNpubs = $derived.by(() => {
    if (!permissions) return [];
    const seen: Record<string, true> = {};
    const result: string[] = [];
    for (const npub of permissions.admins) {
      if (seen[npub]) continue;
      seen[npub] = true;
      result.push(npub);
    }
    for (const npub of permissions.writers) {
      if (seen[npub]) continue;
      seen[npub] = true;
      result.push(npub);
    }
    return result;
  });
  let permissionSections = $derived.by(() => {
    if (!permissions) return [];
    return [
      {
        id: 'admin',
        label: 'Admins',
        memberLabel: 'admin',
        npubs: permissions.admins,
        emptyText: 'Board must have at least one admin.',
        removeTitle: 'Remove admin',
      },
      {
        id: 'writer',
        label: 'Writers',
        memberLabel: 'writer',
        npubs: permissions.writers,
        emptyText: 'No writers assigned',
        removeTitle: 'Remove writer',
      },
    ];
  });
  let permissionIntro = $derived(
    canManage
      ? 'Admins can manage admins/writers and edit cards. Writers can edit cards only.'
      : 'Admins can manage roles. Writers can edit cards.'
  );
  let permissionRequestAccess = $derived(
    !canWrite && userNpub
      ? { text: 'Share your npub with an admin to request write access:', visible: !canWrite }
      : null
  );

  let viewedCardState = $derived.by(() => {
    if (!board || !cardViewColumnId || !cardViewCardId) return null;
    const column = board.columns.find(item => item.id === cardViewColumnId);
    const card = column?.cards.find(item => item.id === cardViewCardId);
    if (!column || !card) return null;
    return { column, card };
  });

  $effect(() => {
    if (showColumnModal && columnTitleInputRef) {
      columnTitleInputRef.focus();
      if (columnModalMode === 'edit') {
        columnTitleInputRef.select();
      }
    }
  });

  $effect(() => {
    if (showCardModal && cardTitleInputRef) {
      cardTitleInputRef.focus();
      if (cardModalMode === 'edit') {
        cardTitleInputRef.select();
      }
    }
  });

  function boardDisplayName(treeName: string | null): string {
    if (!treeName) return 'Board';
    return treeName.startsWith('boards/') ? treeName.slice(7) : treeName;
  }

  $effect(() => {
    const npub = route.npub;
    const treeName = route.treeName;
    const tree = currentTree;
    if (!npub || !treeName) return;
    syncSelectedTreeForOwnRoute(nostrStore, {
      npub,
      treeName,
      visibility: tree?.visibility,
      labels: tree?.labels,
    });
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

  $effect(() => {
    if (!showCardViewModal) return;
    if (!viewedCardState) {
      showCardViewModal = false;
      cardViewColumnId = null;
      cardViewCardId = null;
    }
  });

  $effect(() => {
    if (!showMediaModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeAttachmentPreview();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  });

  $effect(() => {
    if (!showCardModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeCardModal();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  $effect(() => {
    if (!showCardViewModal || showMediaModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeCardViewModal();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  $effect(() => {
    const boardId = board?.boardId ?? null;
    if (!boardId) {
      previewBoardId = null;
      return;
    }
    if (!previewBoardId) {
      previewBoardId = boardId;
      return;
    }
    if (previewBoardId === boardId) return;
    for (const previewUrl of Object.values(localAttachmentPreviewUrls)) {
      URL.revokeObjectURL(previewUrl);
    }
    localAttachmentPreviewUrls = {};
    previewBoardId = boardId;
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

  function isImageMimeType(mimeType: string): boolean {
    return mimeType.startsWith('image/');
  }

  function formatAttachmentSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function formatCommentTimestamp(timestamp: number): string {
    if (!Number.isFinite(timestamp)) return '';
    return new Date(timestamp).toLocaleString();
  }

  function renderMarkdown(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) return '';
    try {
      return DOMPurify.sanitize(marked.parse(trimmed, { async: false }) as string);
    } catch {
      const escaped = trimmed
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
      return escaped.replaceAll('\n', '<br />');
    }
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

  function attachmentImageSrc(attachment: BoardCardAttachment): string | null {
    return localAttachmentPreviewUrls[attachment.id] || cardAttachmentUrl(attachment);
  }

  function addImageRetryParam(url: string, attempt: number): string {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}img_retry=${Date.now()}-${attempt}`;
  }

  function handleAttachmentImageError(event: Event, attachment: BoardCardAttachment) {
    const image = event.currentTarget as HTMLImageElement | null;
    if (!image) return;

    const remoteUrl = cardAttachmentUrl(attachment);
    if (!remoteUrl) return;

    const currentSrc = image.getAttribute('src') || image.src || '';
    if (currentSrc.startsWith('blob:')) {
      image.dataset.retryCount = '0';
      image.src = addImageRetryParam(remoteUrl, 0);
      return;
    }

    const currentRetry = Number(image.dataset.retryCount || '0');
    if (currentRetry >= 4) return;
    const nextRetry = currentRetry + 1;
    image.dataset.retryCount = String(nextRetry);
    const delayMs = 350 * nextRetry;
    const retryUrl = addImageRetryParam(remoteUrl, nextRetry);
    setTimeout(() => {
      if (!image.isConnected) return;
      image.src = retryUrl;
    }, delayMs);
  }

  function releaseLocalAttachmentPreview(attachmentId: string) {
    const existing = localAttachmentPreviewUrls[attachmentId];
    if (existing) URL.revokeObjectURL(existing);
    if (!existing) return;
    const next = { ...localAttachmentPreviewUrls };
    delete next[attachmentId];
    localAttachmentPreviewUrls = next;
  }

  function npubToPubkey(npub: string): string | null {
    if (!npub) return null;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') return null;
      return decoded.data as string;
    } catch {
      return null;
    }
  }

  function boardMemberRoleLabel(npub: string): string {
    if (!permissions) return 'Member';
    if (permissions.admins.includes(npub)) return 'Admin';
    if (permissions.writers.includes(npub)) return 'Writer';
    return 'Member';
  }

  function sanitizeAssigneeNpubs(values: string[]): string[] {
    const allowed: Record<string, true> = {};
    for (const npub of boardMemberNpubs) allowed[npub] = true;
    const deduped: Record<string, true> = {};
    const result: string[] = [];
    for (const npub of values) {
      const trimmed = npub.trim();
      if (!trimmed || !allowed[trimmed]) continue;
      if (deduped[trimmed]) continue;
      deduped[trimmed] = true;
      result.push(trimmed);
    }
    return result;
  }

  function toggleCardDraftAssignee(npub: string, checked: boolean) {
    if (checked) {
      if (cardDraftAssigneeNpubs.includes(npub)) return;
      cardDraftAssigneeNpubs = [...cardDraftAssigneeNpubs, npub];
      return;
    }
    cardDraftAssigneeNpubs = cardDraftAssigneeNpubs.filter(item => item !== npub);
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

  function latestTombstoneUpdatedAt(snapshot: BoardTombstones | null | undefined): number {
    let latest = 0;
    for (const entry of snapshot?.entries ?? []) {
      if (entry.updatedAt > latest) latest = entry.updatedAt;
    }
    return latest;
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
  ): Promise<{
    board: BoardState | null;
    permissions: BoardPermissions | null;
    tombstones: BoardTombstones;
    incomplete: boolean;
  }> {
    const tree = getTree();
    const entries = await tree.listDirectory(dirCid);
    let incomplete = false;

    const boardMetaEntry = findBlobEntry(entries, BOARD_META_FILE);
    const boardOrderEntry = findBlobEntry(entries, BOARD_ORDER_FILE);
    const permissionsEntry = findBlobEntry(entries, BOARD_PERMISSIONS_FILE);
    const tombstonesEntry = findBlobEntry(entries, BOARD_TOMBSTONES_FILE);
    const columnsDirEntry = findDirEntry(entries, BOARD_COLUMNS_DIR);

    const boardMetaData = boardMetaEntry ? await tree.readFile(boardMetaEntry.cid) : null;
    if (boardMetaEntry && boardMetaData === null) incomplete = true;
    const boardMeta = boardMetaData
      ? parseBoardMeta(boardMetaData, fallbackBoardId, fallbackTitle, fallbackUpdatedBy)
      : null;
    const legacyBoardState = boardMetaData
      ? parseBoardState(boardMetaData, fallbackBoardId, fallbackTitle, fallbackUpdatedBy)
      : null;

    const permissionsData = permissionsEntry ? await tree.readFile(permissionsEntry.cid) : null;
    if (permissionsEntry && permissionsData === null) incomplete = true;
    const parsedPermissions = permissionsData && ownerNpub
      ? parseBoardPermissions(permissionsData, ownerNpub)
      : null;

    const tombstonesData = tombstonesEntry ? await tree.readFile(tombstonesEntry.cid) : null;
    if (tombstonesEntry && tombstonesData === null) incomplete = true;
    const parsedTombstones = tombstonesData
      ? parseBoardTombstones(tombstonesData, fallbackUpdatedBy)
      : createInitialBoardTombstones();

    const boardOrderData = boardOrderEntry ? await tree.readFile(boardOrderEntry.cid) : null;
    if (boardOrderEntry && boardOrderData === null) incomplete = true;
    const boardOrder = boardOrderData
      ? parseBoardOrder(
        boardOrderData,
        boardMeta?.updatedAt ?? legacyBoardState?.orderUpdatedAt ?? legacyBoardState?.updatedAt ?? 0,
        boardMeta?.updatedBy ?? legacyBoardState?.orderUpdatedBy ?? legacyBoardState?.updatedBy ?? fallbackUpdatedBy,
      )
      : parseBoardOrder(
        null,
        boardMeta?.updatedAt ?? legacyBoardState?.orderUpdatedAt ?? legacyBoardState?.updatedAt ?? 0,
        boardMeta?.updatedBy ?? legacyBoardState?.orderUpdatedBy ?? legacyBoardState?.updatedBy ?? fallbackUpdatedBy,
      );

    const parsedColumns: BoardColumn[] = [];
    if (columnsDirEntry) {
      const columnEntries = sortEntriesByName(await tree.listDirectory(columnsDirEntry.cid));
      for (const columnEntry of columnEntries) {
        if (columnEntry.type !== LinkType.Dir) continue;
        const columnDirEntries = await tree.listDirectory(columnEntry.cid);
        const columnMetaEntry = findBlobEntry(columnDirEntries, BOARD_COLUMN_META_FILE);
        const cardsDirEntry = findDirEntry(columnDirEntries, BOARD_CARDS_DIR);

        const columnMetaData = columnMetaEntry ? await tree.readFile(columnMetaEntry.cid) : null;
        if (columnMetaEntry && columnMetaData === null) incomplete = true;
        const columnMeta = columnMetaData
          ? parseColumnMeta(
            columnMetaData,
            columnEntry.name,
            boardMeta?.updatedAt ?? legacyBoardState?.updatedAt ?? 0,
            boardMeta?.updatedBy ?? legacyBoardState?.updatedBy ?? fallbackUpdatedBy,
          )
          : {
            id: columnEntry.name,
            title: 'Untitled Column',
            updatedAt: boardMeta?.updatedAt ?? legacyBoardState?.updatedAt ?? 0,
            updatedBy: boardMeta?.updatedBy ?? legacyBoardState?.updatedBy ?? fallbackUpdatedBy,
          };
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
            if (cardData === null) {
              incomplete = true;
              continue;
            }
            const fallbackCardId = cardIdFromFilename(cardEntry.name);
            const card = parseCardData(
              cardData,
              fallbackCardId,
              columnMeta.updatedAt,
              columnMeta.updatedBy,
            );
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
          updatedAt: columnMeta.updatedAt,
          updatedBy: columnMeta.updatedBy,
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
        orderUpdatedAt: boardOrder.updatedAt || boardMeta?.updatedAt || parsedPermissions?.updatedAt || Date.now(),
        orderUpdatedBy: boardOrder.updatedBy || boardMeta?.updatedBy || parsedPermissions?.updatedBy || fallbackUpdatedBy,
      };

      if (parsedBoard.columns.length === 0 && legacyBoardState?.columns.length) {
        parsedBoard = legacyBoardState;
      }
    } else if (legacyBoardState) {
      parsedBoard = legacyBoardState;
    }

    return {
      board: parsedBoard,
      permissions: parsedPermissions,
      tombstones: parsedTombstones,
      incomplete,
    };
  }

  async function loadParticipantData(
    participantNpub: string,
    treeName: string,
    boardPath: string[],
    timeoutMs: number
  ): Promise<{
    data: {
      board: BoardState | null;
      permissions: BoardPermissions | null;
      tombstones: BoardTombstones;
      incomplete: boolean;
    } | null;
    hasPendingRoot: boolean;
  }> {
    let participantRoot: CID | null = null;

    if (participantNpub === viewedNpub) {
      participantRoot = treeRoot;
    } else {
      participantRoot = await getTreeRoot(participantNpub, treeName, linkKey ?? null);
      if (!participantRoot) {
        participantRoot = await waitForTreeRoot(participantNpub, treeName, timeoutMs, linkKey ?? null);
      }
    }

    if (!participantRoot) {
      return {
        data: null,
        hasPendingRoot: true,
      };
    }

    try {
      const participantBoardDir = await resolveBoardDirectory(participantRoot, boardPath);
      if (!participantBoardDir) {
        return {
          data: null,
          hasPendingRoot: true,
        };
      }

      return {
        data: await loadBoardFromDirectory(
          participantBoardDir,
          createBoardId(),
          boardDisplayName(treeName),
          participantNpub
        ),
        hasPendingRoot: false,
      };
    } catch (error) {
      console.debug('[BoardView] Pending participant board hydration', {
        participantNpub,
        treeName,
        error,
      });
      return {
        data: null,
        hasPendingRoot: true,
      };
    }
  }

  function clearHydrateRetry(): void {
    if (hydrateRetryTimer) {
      clearTimeout(hydrateRetryTimer);
      hydrateRetryTimer = null;
    }
  }

  function clearParticipantHydrateTimer(): void {
    if (!participantHydrateTimer) return;
    clearTimeout(participantHydrateTimer);
    participantHydrateTimer = null;
  }

  function getHydrateRetryKey(root: CID): string {
    return `${route.isPermalink ? 'permalink' : 'tree'}:${route.npub ?? ''}:${route.treeName ?? ''}:${route.path.join('/')}:${toHex(root.hash)}:${root.key ? toHex(root.key) : ''}`;
  }

  function resetHydrateRetry(nextKey: string | null = null): void {
    if (hydrateRetryKey === nextKey) return;
    hydrateRetryKey = nextKey;
    hydrateRetryAttempts = 0;
    clearHydrateRetry();
  }

  function applyHydratedSnapshot(
    routeKey: string,
    resolvedBoard: BoardState,
    resolvedPermissions: BoardPermissions,
    resolvedTombstones: BoardTombstones,
  ): void {
    const shouldApplyBoard = shouldApplyHydratedBoardState(
      hydratedRouteKey,
      routeKey,
      board?.updatedAt,
      resolvedBoard.updatedAt
    );
    const shouldApplyPermissions = shouldApplyHydratedBoardState(
      hydratedRouteKey,
      routeKey,
      permissions?.updatedAt,
      resolvedPermissions.updatedAt
    );
    const shouldApplyTombstones = shouldApplyHydratedBoardState(
      hydratedRouteKey,
      routeKey,
      latestTombstoneUpdatedAt(tombstones),
      latestTombstoneUpdatedAt(resolvedTombstones),
    );

    if (shouldApplyPermissions) {
      permissions = resolvedPermissions;
    }
    if (shouldApplyBoard) {
      board = resolvedBoard;
    }
    if (shouldApplyBoard || shouldApplyTombstones) {
      tombstones = resolvedTombstones;
    }

    hydratedRouteKey = routeKey;
    error = null;
    loading = false;
  }

  function applyHydratedPermissions(routeKey: string, resolvedPermissions: BoardPermissions): void {
    const shouldApplyPermissions = shouldApplyHydratedBoardState(
      hydratedRouteKey,
      routeKey,
      permissions?.updatedAt,
      resolvedPermissions.updatedAt
    );

    if (shouldApplyPermissions) {
      permissions = resolvedPermissions;
    }
  }

  function triggerHydrate(root: CID, routeKey: string, options?: {
    showLoading?: boolean;
    previousRouteKey?: string | null;
    hasBoard?: boolean;
  }): void {
    resetHydrateRetry(getHydrateRetryKey(root));
    loadGeneration += 1;
    const generation = loadGeneration;

    if (options?.showLoading) {
      loading = shouldShowBoardLoading(
        options.previousRouteKey ?? hydratedRouteKey,
        routeKey,
        options.hasBoard ?? !!board
      );
    }

    error = null;
    void hydrateBoardState(generation, root, routeKey);
  }

  function scheduleParticipantHydration(): void {
    clearParticipantHydrateTimer();
    participantHydrateTimer = setTimeout(() => {
      participantHydrateTimer = null;
      hydrateRetryAttempts = 0;
      clearHydrateRetry();
      participantHydrationNonce += 1;
    }, 75);
  }

  function scheduleHydrateRetry(generation: number, root: CID, routeKey: string): void {
    const retryKey = getHydrateRetryKey(root);
    if (hydrateRetryKey !== retryKey) {
      resetHydrateRetry(retryKey);
    }

    const maxRetries = route.isPermalink || !isOwnBoard
      ? REMOTE_HYDRATE_MAX_RETRIES
      : LOCAL_HYDRATE_MAX_RETRIES;
    if (hydrateRetryTimer || hydrateRetryAttempts >= maxRetries) return;

    hydrateRetryAttempts += 1;
    hydrateRetryTimer = setTimeout(() => {
      hydrateRetryTimer = null;
      if (generation !== loadGeneration) return;
      void hydrateBoardState(generation, root, routeKey);
    }, HYDRATE_RETRY_DELAY_MS);
  }

  async function hydrateBoardState(generation: number, root: CID, routeKey: string) {
    resetHydrateRetry(getHydrateRetryKey(root));
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
      scheduleHydrateRetry(generation, root, routeKey);
      error = 'Board not found.';
      loading = false;
      return;
    }

    try {
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

      if (localData.permissions && generation === loadGeneration) {
        applyHydratedPermissions(routeKey, localData.permissions);
      }

      const localSourceNpub = viewedNpub || ownerNpub;
      const mergeSources: BoardMergeSource[] = [{
        source: localSourceNpub,
        board: localData.board,
        permissions: localPermissions,
        tombstones: localData.tombstones,
      }];
      let hasIncompleteData = localData.incomplete;
      let hasPendingData = false;

      if (localData.board && generation === loadGeneration) {
        const localSnapshot = mergeBoardSnapshots(mergeSources, {
          ownerNpub,
          fallbackBoardId: localData.board.boardId || localPermissions.boardId || createBoardId(),
          fallbackTitle: localData.board.title || localPermissions.title || boardName,
        });
        const resolvedLocalPermissions = localSnapshot.permissions || localPermissions;
        if (localSnapshot.board) {
          applyHydratedSnapshot(routeKey, localSnapshot.board, resolvedLocalPermissions, localSnapshot.tombstones);
        }
      }

      const participants = new Set<string>([
        ownerNpub,
        ...localPermissions.admins,
        ...localPermissions.writers,
      ]);

      const participantNpubs = Array.from(participants)
        .filter(participant => participant !== localSourceNpub);
      const participantResults = await Promise.all(
        participantNpubs.map(participant => loadParticipantData(
          participant,
          route.treeName,
          route.path,
          localData.board ? PARTICIPANT_ROOT_WAIT_MS : 3000
        ).then(result => ({ participant, result })))
      );

      for (const { participant, result } of participantResults) {
        if (result.hasPendingRoot) {
          hasPendingData = true;
        }
        if (!result.data) continue;
        if (result.data.incomplete) hasIncompleteData = true;
        mergeSources.push({
          source: participant,
          board: result.data.board,
          tombstones: result.data.tombstones,
        });
      }

      const mergedSnapshot = mergeBoardSnapshots(mergeSources, {
        ownerNpub,
        fallbackBoardId: localData.board?.boardId || localPermissions.boardId || createBoardId(),
        fallbackTitle: localData.board?.title || localPermissions.title || boardName,
      });

      const resolvedPermissions = mergedSnapshot.permissions || localPermissions;
      const boardResult = resolveHydratedBoardResult({
        hasBoardSnapshot: !!mergedSnapshot.board,
        hasIncompleteData,
        hasPendingData,
      });
      if (boardResult === 'retry') {
        scheduleHydrateRetry(generation, root, routeKey);
        return;
      }
      if (boardResult === 'missing') {
        if (generation !== loadGeneration) return;
        permissions = resolvedPermissions;
        error = 'Board data missing.';
        loading = false;
        return;
      }

      const resolvedBoard = mergedSnapshot.board;
      if (!resolvedBoard) {
        if (generation !== loadGeneration) return;
        error = 'Board data missing.';
        loading = false;
        return;
      }
      const resolvedTombstones = mergedSnapshot.tombstones;
      if (generation !== loadGeneration) return;
      applyHydratedSnapshot(routeKey, resolvedBoard, resolvedPermissions, resolvedTombstones);

      if (shouldScheduleHydratedBoardRetry({ hasIncompleteData, hasPendingData })) {
        scheduleHydrateRetry(generation, root, routeKey);
      } else {
        hydrateRetryAttempts = 0;
        clearHydrateRetry();
      }
    } catch {
      if (generation !== loadGeneration) return;
      scheduleHydrateRetry(generation, root, routeKey);
      error = 'Failed to load board.';
      loading = false;
    }
  }

  $effect(() => {
    const root = treeRoot;
    const treeName = route.treeName;
    const currentVisibility = resolvedVisibility;
    const protectedWithoutAccess = isProtectedBoardWithoutAccess;
    participantHydrationNonce;
    const previousRouteKey = untrack(() => hydratedRouteKey);
    const hasBoard = untrack(() => !!board);
    const routeKey = getBoardRouteKey({
      npub: route.npub,
      treeName,
      path: route.path,
    });

    if (!treeName) {
      hydratedRouteKey = null;
      resetHydrateRetry();
      tombstones = createInitialBoardTombstones();
      loading = true;
      return;
    }

    if (!isOwnBoard && !root?.key && currentVisibility === undefined) {
      resetHydrateRetry();
      loading = true;
      return;
    }

    if (protectedWithoutAccess) {
      hydratedRouteKey = routeKey;
      resetHydrateRetry();
      board = null;
      permissions = null;
      tombstones = createInitialBoardTombstones();
      loading = false;
      error = null;
      return;
    }

    if (!root) {
      resetHydrateRetry();
      loading = true;
      return;
    }

    triggerHydrate(root, routeKey, {
      showLoading: true,
      previousRouteKey,
      hasBoard,
    });
  });

  $effect(() => {
    const root = treeRoot;
    const treeName = route.treeName;
    const participants = boardMemberNpubs;
    const localSourceNpub = viewedNpub || ownerNpub;

    if (!root || !treeName) {
      clearParticipantHydrateTimer();
      return;
    }

    const seen: Record<string, true> = {};
    const unsubscribes: Array<() => void> = [];
    const participantNpubs: string[] = [];
    const participantRootSignatures: Record<string, string> = {};
    let pollInFlight = false;
    let cancelled = false;

    for (const participant of participants) {
      if (!participant || participant === localSourceNpub || seen[participant]) continue;
      seen[participant] = true;
      participantNpubs.push(participant);
      unsubscribes.push(subscribeToTreeRoot(participant, treeName, (hash) => {
        if (!hash) return;
        scheduleParticipantHydration();
      }));
    }

    const pollParticipantRoots = async () => {
      if (cancelled || pollInFlight) return;
      pollInFlight = true;

      try {
        let changed = false;

        for (const participant of participantNpubs) {
          const participantRoot = await getTreeRoot(participant, treeName, linkKey ?? null);
          const signature = participantRoot
            ? `${toHex(participantRoot.hash)}:${participantRoot.key ? toHex(participantRoot.key) : ''}`
            : '';
          if ((participantRootSignatures[participant] ?? '') !== signature) {
            participantRootSignatures[participant] = signature;
            changed = true;
          }
        }

        if (changed) {
          scheduleParticipantHydration();
        }
      } finally {
        pollInFlight = false;
      }
    };

    void pollParticipantRoots();
    const pollTimer = setInterval(() => {
      void pollParticipantRoots();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearParticipantHydrateTimer();
      unsubscribes.forEach(unsub => unsub());
    };
  });

  $effect(() => {
    const root = treeRoot;
    const treeName = route.treeName;
    const routeKey = getBoardRouteKey({
      npub: route.npub,
      treeName,
      path: route.path,
    });
    const localSourceNpub = viewedNpub || ownerNpub;
    const participantCount = boardMemberNpubs.filter(participant => participant && participant !== localSourceNpub).length;
    const shouldKeepHydrating = !isOwnBoard || participantCount > 0;

    if (!root || !treeName || !shouldKeepHydrating) {
      return;
    }

    const interval = setInterval(() => {
      triggerHydrate(root, routeKey);
    }, 5000);

    return () => clearInterval(interval);
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

  async function publishUpdatedRoot(rootCid: CID): Promise<void> {
    if (!route.treeName || !userNpub) return;

    if (isOwnBoard) {
      autosaveIfOwn(rootCid);
      return;
    }

    const nextVisibility = (visibility as 'public' | 'link-visible' | 'private') || 'public';
    const sharedLinkKey = nextVisibility === 'link-visible'
      ? (
        linkKey
        || getLinkKey(userNpub, route.treeName)
        || (ownerNpub ? getLinkKey(ownerNpub, route.treeName) : null)
      )
      : null;

    if (nextVisibility === 'link-visible' && sharedLinkKey) {
      await storeLinkKey(userNpub, route.treeName, sharedLinkKey);
    }

    const result = await saveHashtree(route.treeName, rootCid, {
      visibility: nextVisibility,
      linkKey: sharedLinkKey ?? undefined,
      labels: resolveBoardPublishLabels(currentTree?.labels ?? nostrStore.getState().selectedTree?.labels),
    });

    if (!result.success) {
      updateLocalRootCacheHex(
        userNpub,
        route.treeName,
        toHex(rootCid.hash),
        rootCid.key ? toHex(rootCid.key) : undefined,
        nextVisibility
      );
    }
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

  async function buildBoardDirectoryCid(
    nextBoard: BoardState,
    nextPermissions: BoardPermissions,
    nextTombstones: BoardTombstones,
  ): Promise<CID> {
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
    const { cid: tombstonesCid, size: tombstonesSize } = await putTextFile(serializeBoardTombstones(nextTombstones));

    const { cid: boardDirCid } = await tree.putDirectory([
      { name: BOARD_META_FILE, cid: boardMetaCid, size: boardMetaSize, type: LinkType.Blob },
      { name: BOARD_ORDER_FILE, cid: boardOrderCid, size: boardOrderSize, type: LinkType.Blob },
      { name: BOARD_PERMISSIONS_FILE, cid: permissionsCid, size: permissionsSize, type: LinkType.Blob },
      { name: BOARD_TOMBSTONES_FILE, cid: tombstonesCid, size: tombstonesSize, type: LinkType.Blob },
      { name: BOARD_COLUMNS_DIR, cid: columnsCid, size: 0, type: LinkType.Dir },
    ]);

    return boardDirCid;
  }

  async function buildUpdatedBoardRootCid(
    nextBoard: BoardState,
    nextPermissions: BoardPermissions,
    nextTombstones: BoardTombstones,
  ): Promise<CID | null> {
    if (!userNpub || !route.treeName) return null;
    const tree = getTree();
    const rootCid = await ensureOwnRootCid();
    if (!rootCid) return null;

    const boardDirCid = await buildBoardDirectoryCid(nextBoard, nextPermissions, nextTombstones);
    const boardPath = route.path;
    return boardPath.length === 0
      ? boardDirCid
      : await tree.setEntry(
        rootCid,
        boardPath.slice(0, -1),
        boardPath[boardPath.length - 1],
        boardDirCid,
        0,
        LinkType.Dir
      );
  }

  async function persistBoardDirectory(
    nextBoard: BoardState,
    nextPermissions: BoardPermissions,
    nextTombstones: BoardTombstones,
  ): Promise<boolean> {
    const newRootCid = await buildUpdatedBoardRootCid(nextBoard, nextPermissions, nextTombstones);
    if (!newRootCid) return false;
    await publishUpdatedRoot(newRootCid);
    return true;
  }

  function clonePendingPermissionsSnapshot(
    source: BoardPermissions | null | undefined,
    nextBoard: BoardState,
    actorNpub: string
  ): BoardPermissions | null {
    if (!source) return null;
    return {
      ...source,
      boardId: nextBoard.boardId,
      title: nextBoard.title,
      updatedAt: nextBoard.updatedAt,
      updatedBy: source.updatedBy || actorNpub,
      admins: [...source.admins],
      writers: [...source.writers],
    };
  }

  async function persistBoard(
    nextBoard: BoardState,
    nextTombstones: BoardTombstones,
    queuedPermissions: BoardPermissions | null = null,
  ) {
    if (!userNpub) return;
    savingBoard = true;
    try {
      const nextPermissions = queuedPermissions
        ? {
          ...queuedPermissions,
          boardId: nextBoard.boardId,
          title: nextBoard.title,
        }
        : permissions
          ? {
            ...permissions,
            boardId: nextBoard.boardId,
            title: nextBoard.title,
          }
        : createInitialBoardPermissions(nextBoard.boardId, nextBoard.title, userNpub, nextBoard.updatedAt);

      const success = await persistBoardDirectory(nextBoard, nextPermissions, nextTombstones);
      if (success && !permissions) {
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
      const boardSnapshot = cloneBoardState(board);
      const syncedPermissions: BoardPermissions = {
        ...nextPermissions,
        boardId: boardSnapshot.boardId,
        title: boardSnapshot.title,
      };
      const success = await persistBoardDirectory(
        boardSnapshot,
        syncedPermissions,
        cloneBoardTombstones(tombstones),
      );
      if (success) permissions = syncedPermissions;
    } finally {
      savingPermissions = false;
    }
  }

  function updateBoardVisibilityUrl(nextVisibility: TreeVisibility, nextLinkKey?: string): void {
    const currentHashPath = window.location.hash.split('?')[0] || '#/';
    const nextQuery = buildBoardVisibilityQueryString(route.params, nextVisibility, nextLinkKey);
    const nextHash = nextQuery ? `${currentHashPath}?${nextQuery}` : currentHashPath;

    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }

  async function handleUpdateVisibility() {
    if (!isOwnBoard || !userNpub || !route.treeName || !board || !permissions) return;

    const nextVisibility = visibilityDraft;
    if (nextVisibility === visibility) {
      visibilityError = '';
      return;
    }

    savingVisibility = true;
    visibilityError = '';

    try {
      saveQueued = false;
      pendingBoardSave = null;

      const nextRootCid = await buildUpdatedBoardRootCid(board, permissions, tombstones);
      if (!nextRootCid) {
        visibilityError = 'Could not prepare the board for publishing.';
        return;
      }

      const nextLinkKey = resolveBoardVisibilityLinkKey(
        nextVisibility,
        linkKey,
        getLinkKey(userNpub, route.treeName),
        () => linkKeyUtils.generateLinkKey()
      );

      const result = await saveHashtree(route.treeName, nextRootCid, {
        visibility: nextVisibility,
        linkKey: nextLinkKey,
        labels: resolveBoardPublishLabels(currentTree?.labels ?? nostrStore.getState().selectedTree?.labels),
      });

      if (!result.success) {
        visibilityError = 'Could not update board visibility.';
        return;
      }

      const persistedLinkKey = nextVisibility === 'link-visible'
        ? (result.linkKey ?? nextLinkKey)
        : undefined;

      if (persistedLinkKey) {
        await storeLinkKey(userNpub, route.treeName, persistedLinkKey);
      }

      updateRecentVisibility(`/${userNpub}/${route.treeName}`, nextVisibility);
      updateBoardVisibilityUrl(nextVisibility, persistedLinkKey);
      visibilityDraft = nextVisibility;
      showPermissionsModal = false;
    } finally {
      savingVisibility = false;
    }
  }

  function flushPendingBoardSave(_reason: 'microtask' | 'hidden' | 'pagehide' | 'destroy') {
    const snapshot = pendingBoardSave;
    pendingBoardSave = null;
    if (!snapshot) return;
    void persistBoard(snapshot.board, snapshot.tombstones, snapshot.permissions);
  }

  function queueBoardSave(nextBoard: BoardState, nextTombstones: BoardTombstones) {
    pendingBoardSave = {
      board: cloneBoardState(nextBoard),
      tombstones: cloneBoardTombstones(nextTombstones),
      permissions: clonePendingPermissionsSnapshot(permissions, nextBoard, userNpub || ownerNpub || ''),
    };
    if (saveQueued) return;
    saveQueued = true;
    queueMicrotask(() => {
      saveQueued = false;
      flushPendingBoardSave('microtask');
    });
  }

  function applyBoardEdit(next: { board: BoardState; tombstones: BoardTombstones; changed: boolean }) {
    if (!next.changed) return;
    board = next.board;
    tombstones = next.tombstones;
    queueBoardSave(next.board, next.tombstones);
  }

  function normalizeTitle(value: string, fallback: string): string {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  function addColumn(title: string) {
    if (!board || !userNpub || !canWrite) return;
    applyBoardEdit(addBoardColumnToState(board, tombstones, {
      actor: userNpub,
      columnId: createBoardId(),
      title: normalizeTitle(title, 'Untitled Column'),
    }));
  }

  function updateColumnTitle(columnId: string, title: string) {
    if (!board || !userNpub || !canWrite) return;
    applyBoardEdit(updateBoardColumnTitleInState(board, tombstones, {
      actor: userNpub,
      columnId,
      title: normalizeTitle(title, 'Untitled Column'),
    }));
  }

  function removeColumn(columnId: string) {
    if (!board || !userNpub || !canWrite) return;
    const removedColumn = board.columns.find(column => column.id === columnId);
    if (!removedColumn) return;
    for (const card of removedColumn.cards) {
      for (const attachment of card.attachments) {
        releaseLocalAttachmentPreview(attachment.id);
      }
      for (const comment of card.comments) {
        for (const attachment of comment.attachments) {
          releaseLocalAttachmentPreview(attachment.id);
        }
      }
    }
    applyBoardEdit(removeBoardColumnFromState(board, tombstones, {
      actor: userNpub,
      columnId,
    }));
  }

  function addCard(
    columnId: string,
    title: string,
    description: string,
    assigneeNpubs: string[],
    attachments: BoardCardAttachment[]
  ) {
    if (!board || !userNpub || !canWrite) return;
    applyBoardEdit(addBoardCardToState(board, tombstones, {
      actor: userNpub,
      columnId,
      card: {
        id: createBoardId(),
        title: normalizeTitle(title, 'Untitled'),
        description: description.trim(),
        assigneeNpubs: sanitizeAssigneeNpubs(assigneeNpubs),
        attachments: attachments.map(attachment => ({ ...attachment })),
        comments: [],
      },
    }));
  }

  function updateCard(
    columnId: string,
    cardId: string,
    title: string,
    description: string,
    assigneeNpubs: string[],
    attachments: BoardCardAttachment[]
  ) {
    if (!board || !userNpub || !canWrite) return;
    applyBoardEdit(mutateBoardCardInState(board, tombstones, {
      actor: userNpub,
      columnId,
      cardId,
      mutate(card) {
        card.title = normalizeTitle(title, 'Untitled');
        card.description = description.trim();
        card.assigneeNpubs = sanitizeAssigneeNpubs(assigneeNpubs);
        card.attachments = attachments.map(attachment => ({ ...attachment }));
      },
    }));
  }

  function removeCard(columnId: string, cardId: string) {
    if (!board || !userNpub || !canWrite) return;
    const column = board.columns.find(item => item.id === columnId);
    const card = column?.cards.find(item => item.id === cardId);
    if (!card) return;
    for (const attachment of card.attachments) {
      releaseLocalAttachmentPreview(attachment.id);
    }
    for (const comment of card.comments) {
      for (const attachment of comment.attachments) {
        releaseLocalAttachmentPreview(attachment.id);
      }
    }
    applyBoardEdit(removeBoardCardFromState(board, tombstones, {
      actor: userNpub,
      columnId,
      cardId,
    }));
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
      const previewUrlByAttachmentId: Record<string, string> = {};
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
        const mimeType = file.type || guessMimeType(file.name);
        if (mimeType.startsWith('image/')) {
          previewUrlByAttachmentId[attachmentId] = URL.createObjectURL(file);
        }
        uploaded.push({
          id: attachmentId,
          fileName: `${attachmentId}-${cleanName}`,
          displayName: cleanName,
          mimeType,
          size: fileSize,
          uploaderNpub: userNpub,
          cidHash: toHex(fileCid.hash),
          cidKey: fileCid.key ? toHex(fileCid.key) : undefined,
        });
      }

      if (uploaded.length > 0) {
        if (board) {
          applyBoardEdit(mutateBoardCardInState(board, tombstones, {
            actor: userNpub,
            columnId: target.columnId,
            cardId: target.cardId,
            mutate(card) {
              card.attachments = [...card.attachments, ...uploaded];
            },
          }));
        }
        if (Object.keys(previewUrlByAttachmentId).length > 0) {
          localAttachmentPreviewUrls = {
            ...localAttachmentPreviewUrls,
            ...previewUrlByAttachmentId,
          };
        }
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
    if (!board || !userNpub || !canWrite) return;
    releaseLocalAttachmentPreview(attachmentId);
    applyBoardEdit(mutateBoardCardInState(board, tombstones, {
      actor: userNpub,
      columnId,
      cardId,
      mutate(card) {
        card.attachments = card.attachments.filter(attachment => attachment.id !== attachmentId);
      },
    }));
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

  function removeColumnFromModal() {
    if (!canWrite || columnModalMode !== 'edit' || !columnModalColumnId) return;
    removeColumn(columnModalColumnId);
    closeColumnModal();
  }

  function openCreateCardModal(columnId: string) {
    if (!canWrite) return;
    cardModalMode = 'create';
    cardModalColumnId = columnId;
    cardModalCardId = null;
    cardDraftTitle = '';
    cardDraftDescription = '';
    cardDraftAssigneeNpubs = [];
    cardDraftAttachments = [];
    cardDraftOriginalAttachmentIds = {};
    cardDraftUploading = false;
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
    cardDraftAssigneeNpubs = [...card.assigneeNpubs];
    cardDraftAttachments = card.attachments.map(attachment => ({ ...attachment }));
    cardDraftOriginalAttachmentIds = Object.fromEntries(
      card.attachments.map(attachment => [attachment.id, true] as const)
    );
    cardDraftUploading = false;
    cardFormError = '';
    showCardModal = true;
  }

  function openCardViewModal(columnId: string, cardId: string) {
    resetCommentDraft();
    cardViewColumnId = columnId;
    cardViewCardId = cardId;
    showCardViewModal = true;
  }

  function closeCardViewModal() {
    resetCommentDraft();
    showCardViewModal = false;
    cardViewColumnId = null;
    cardViewCardId = null;
  }

  function openEditViewedCard() {
    if (!canWrite || !viewedCardState) return;
    const { column, card } = viewedCardState;
    closeCardViewModal();
    openEditCardModal(column.id, card);
  }

  function removeViewedCard() {
    if (!canWrite || !viewedCardState) return;
    const { column, card } = viewedCardState;
    closeCardViewModal();
    removeCard(column.id, card.id);
  }

  function attachToViewedCard() {
    if (!canWrite || !viewedCardState) return;
    triggerAttachmentPicker(viewedCardState.column.id, viewedCardState.card.id);
  }

  function triggerCardDraftAttachmentPicker() {
    if (!canWrite || cardDraftUploading) return;
    const input = cardAttachmentInputRef
      || (document.querySelector('[data-testid="board-card-draft-attachment-input"]') as HTMLInputElement | null);
    if (!input) return;
    cardAttachmentInputRef = input;
    input.click();
  }

  async function handleCardDraftAttachmentInputChange(event: Event) {
    if (!canWrite || !userNpub || cardDraftUploading) return;
    const input = event.target as HTMLInputElement;
    const selectedFiles = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (selectedFiles.length === 0) return;

    cardDraftUploading = true;
    try {
      const tree = getTree();
      const uploaded: BoardCardAttachment[] = [];
      const previewUrlByAttachmentId: Record<string, string> = {};
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
        const mimeType = file.type || guessMimeType(file.name);
        if (isImageMimeType(mimeType)) {
          previewUrlByAttachmentId[attachmentId] = URL.createObjectURL(file);
        }
        uploaded.push({
          id: attachmentId,
          fileName: `${attachmentId}-${cleanName}`,
          displayName: cleanName,
          mimeType,
          size: fileSize,
          uploaderNpub: userNpub,
          cidHash: toHex(fileCid.hash),
          cidKey: fileCid.key ? toHex(fileCid.key) : undefined,
        });
      }

      if (uploaded.length > 0) {
        cardDraftAttachments = [...cardDraftAttachments, ...uploaded];
        if (Object.keys(previewUrlByAttachmentId).length > 0) {
          localAttachmentPreviewUrls = {
            ...localAttachmentPreviewUrls,
            ...previewUrlByAttachmentId,
          };
        }
        cardFormError = '';
      }
    } catch (err) {
      console.error('[Boards] Card draft attachment upload failed:', err);
      toast.error('Failed to upload attachment');
    } finally {
      setUploadProgress(null);
      cardDraftUploading = false;
    }
  }

  function removeCardDraftAttachment(attachmentId: string) {
    if (!cardDraftOriginalAttachmentIds[attachmentId]) {
      releaseLocalAttachmentPreview(attachmentId);
    }
    cardDraftAttachments = cardDraftAttachments.filter(attachment => attachment.id !== attachmentId);
  }

  function resetCommentDraft(options?: { keepPreviewUrls?: Record<string, true> }) {
    const keepPreviewUrls = options?.keepPreviewUrls || {};
    for (const draftAttachment of commentDraftAttachments) {
      if (!draftAttachment.previewUrl || keepPreviewUrls[draftAttachment.previewUrl]) continue;
      URL.revokeObjectURL(draftAttachment.previewUrl);
    }
    commentDraftMarkdown = '';
    commentDraftAttachments = [];
    commentFormError = '';
    if (commentAttachmentInputRef) commentAttachmentInputRef.value = '';
  }

  function triggerCommentAttachmentPicker() {
    if (!canWrite) return;
    const input = commentAttachmentInputRef
      || (document.querySelector('[data-testid="board-comment-attachment-input"]') as HTMLInputElement | null);
    if (!input) return;
    commentAttachmentInputRef = input;
    input.click();
  }

  function handleCommentAttachmentInputChange(event: Event) {
    if (!canWrite) return;
    const input = event.target as HTMLInputElement;
    const selectedFiles = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (selectedFiles.length === 0) return;

    const nextDrafts = [...commentDraftAttachments];
    for (const file of selectedFiles) {
      const displayName = sanitizeAttachmentFileName(file.name);
      const mimeType = file.type || guessMimeType(file.name);
      nextDrafts.push({
        id: createBoardId(),
        file,
        displayName,
        mimeType,
        size: file.size,
        previewUrl: isImageMimeType(mimeType) ? URL.createObjectURL(file) : null,
      });
    }

    commentDraftAttachments = nextDrafts;
    commentFormError = '';
  }

  function removeCommentDraftAttachment(draftAttachmentId: string) {
    const target = commentDraftAttachments.find(item => item.id === draftAttachmentId);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    commentDraftAttachments = commentDraftAttachments.filter(item => item.id !== draftAttachmentId);
  }

  async function submitComment() {
    if (!canWrite || !userNpub || !viewedCardState || commentSubmitting) return;
    const markdown = commentDraftMarkdown.trim();
    if (!markdown && commentDraftAttachments.length === 0) {
      commentFormError = 'Comment cannot be empty.';
      return;
    }

    const targetColumnId = viewedCardState.column.id;
    const targetCardId = viewedCardState.card.id;
    commentSubmitting = true;
    commentFormError = '';

    const keepPreviewUrls: Record<string, true> = {};
    const previewUrlByAttachmentId: Record<string, string> = {};

    try {
      const tree = getTree();
      const uploaded: BoardCardAttachment[] = [];
      const totalBytes = commentDraftAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
      let uploadedBytes = 0;

      for (let index = 0; index < commentDraftAttachments.length; index += 1) {
        const draftAttachment = commentDraftAttachments[index];
        setUploadProgress({
          current: index + 1,
          total: commentDraftAttachments.length,
          fileName: draftAttachment.displayName,
          bytes: uploadedBytes,
          totalBytes,
          status: 'reading',
        });
        const bytes = new Uint8Array(await draftAttachment.file.arrayBuffer());
        setUploadProgress({
          current: index + 1,
          total: commentDraftAttachments.length,
          fileName: draftAttachment.displayName,
          bytes: uploadedBytes,
          totalBytes,
          status: 'writing',
        });
        const { cid: fileCid, size: fileSize } = await tree.putFile(bytes);
        uploadedBytes += fileSize;
        setUploadProgress({
          current: index + 1,
          total: commentDraftAttachments.length,
          fileName: draftAttachment.displayName,
          bytes: uploadedBytes,
          totalBytes,
          status: 'finalizing',
        });

        const attachmentId = createBoardId();
        const cleanName = sanitizeAttachmentFileName(draftAttachment.displayName || draftAttachment.file.name);
        const mimeType = draftAttachment.mimeType || guessMimeType(cleanName);
        if (isImageMimeType(mimeType)) {
          if (draftAttachment.previewUrl) {
            keepPreviewUrls[draftAttachment.previewUrl] = true;
            previewUrlByAttachmentId[attachmentId] = draftAttachment.previewUrl;
          } else {
            previewUrlByAttachmentId[attachmentId] = URL.createObjectURL(draftAttachment.file);
          }
        }
        uploaded.push({
          id: attachmentId,
          fileName: `${attachmentId}-${cleanName}`,
          displayName: cleanName,
          mimeType,
          size: fileSize,
          uploaderNpub: userNpub,
          cidHash: toHex(fileCid.hash),
          cidKey: fileCid.key ? toHex(fileCid.key) : undefined,
        });
      }

      const now = Date.now();
      const nextComment: BoardCardComment = {
        id: createBoardId(),
        authorNpub: userNpub,
        markdown,
        createdAt: now,
        updatedAt: now,
        attachments: uploaded,
      };

      if (board) {
        applyBoardEdit(mutateBoardCardInState(board, tombstones, {
          actor: userNpub,
          updatedAt: now,
          columnId: targetColumnId,
          cardId: targetCardId,
          mutate(card) {
            card.comments = [...card.comments, nextComment];
          },
        }));
      }

      if (Object.keys(previewUrlByAttachmentId).length > 0) {
        localAttachmentPreviewUrls = {
          ...localAttachmentPreviewUrls,
          ...previewUrlByAttachmentId,
        };
      }

      resetCommentDraft({ keepPreviewUrls });
    } catch (err) {
      console.error('[Boards] Comment submit failed:', err);
      toast.error('Failed to add comment');
    } finally {
      setUploadProgress(null);
      commentSubmitting = false;
    }
  }

  function closeCardModal(options?: { preserveDraftUploads?: boolean }) {
    if (!options?.preserveDraftUploads) {
      for (const attachment of cardDraftAttachments) {
        if (cardDraftOriginalAttachmentIds[attachment.id]) continue;
        releaseLocalAttachmentPreview(attachment.id);
      }
    }
    showCardModal = false;
    cardFormError = '';
    cardDraftAttachments = [];
    cardDraftOriginalAttachmentIds = {};
    cardDraftUploading = false;
    if (cardAttachmentInputRef) cardAttachmentInputRef.value = '';
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
    const assigneeNpubs = sanitizeAssigneeNpubs(cardDraftAssigneeNpubs);
    const attachments = cardDraftAttachments.map(attachment => ({ ...attachment }));

    if (cardModalMode === 'create') {
      addCard(cardModalColumnId, title, cardDraftDescription, assigneeNpubs, attachments);
    } else if (cardModalCardId) {
      updateCard(cardModalColumnId, cardModalCardId, title, cardDraftDescription, assigneeNpubs, attachments);
    }

    closeCardModal({ preserveDraftUploads: true });
  }

  function moveCardToColumn(
    fromColumnId: string,
    cardId: string,
    toColumnId: string,
    beforeCardId: string | null,
    position: 'before' | 'after' | 'end'
  ) {
    if (!board || !userNpub || !canWrite) return;
    applyBoardEdit(moveBoardCardInState(board, tombstones, {
      actor: userNpub,
      fromColumnId,
      cardId,
      toColumnId,
      beforeCardId,
      position,
    }));
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
    draggingColumn = null;
    columnDropTarget = null;
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

  function handleColumnDragStart(event: DragEvent, columnId: string) {
    if (!canWrite) return;
    // Don't start column drag if a card is being dragged (event bubbled up)
    const target = event.target as HTMLElement;
    if (target.closest('[data-card-id]')) return;
    draggingColumn = { columnId };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-board-column', columnId);
    }
  }

  function handleColumnReorderDragOver(event: DragEvent, columnId: string) {
    if (!canWrite || !draggingColumn) return;
    // Don't allow dropping on self
    if (draggingColumn.columnId === columnId) return;
    // Don't interfere with card drags
    if (draggingCard) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const position: 'before' | 'after' = event.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
    columnDropTarget = { columnId, position };
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  function handleColumnReorderDrop(event: DragEvent, columnId: string) {
    if (!canWrite || !draggingColumn || draggingCard) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const position: 'before' | 'after' = event.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
    moveColumn(draggingColumn.columnId, columnId, position);
    draggingColumn = null;
    columnDropTarget = null;
  }

  function handleColumnDragEnd() {
    draggingColumn = null;
    columnDropTarget = null;
  }

  function moveColumn(fromColumnId: string, toColumnId: string, position: 'before' | 'after') {
    if (!board || !userNpub || !canWrite || fromColumnId === toColumnId) return;
    applyBoardEdit(moveBoardColumnInState(board, tombstones, {
      actor: userNpub,
      fromColumnId,
      toColumnId,
      position,
    }));
  }

  function columnDropTargetClass(columnId: string): string {
    if (!columnDropTarget || columnDropTarget.columnId !== columnId) return '';
    return columnDropTarget.position === 'after'
      ? 'ring-2 ring-accent/80 ring-offset-2 ring-offset-surface-0'
      : 'ring-2 ring-emerald-500/80 ring-offset-2 ring-offset-surface-0';
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
    visibilityDraft = visibility;
    visibilityError = '';
    showPermissionsModal = true;
  }

  function validatePermissionAdd(targetNpub: string, role: string): string | null {
    if (!permissions) return 'Permissions unavailable.';
    if (role !== 'admin' && role !== 'writer') return 'Invalid role.';
    const alreadyAdmin = permissions.admins.includes(targetNpub);
    const alreadyWriter = permissions.writers.includes(targetNpub);
    if (role === 'admin' && alreadyAdmin) {
      return 'User is already an admin.';
    }
    if (role === 'writer' && alreadyAdmin) {
      return 'User is already an admin.';
    }
    if (role === 'writer' && alreadyWriter) {
      return 'User is already a writer.';
    }
    return null;
  }

  async function handleAddPermission(targetNpub: string, role: string): Promise<string | void> {
    if (!permissions || !userNpub) return 'Could not update permissions.';
    if (!isValidNpub(targetNpub)) return 'Enter a valid npub.';
    if (role !== 'admin' && role !== 'writer') return 'Invalid role.';
    const validationError = validatePermissionAdd(targetNpub, role);
    if (validationError) return validationError;

    const next = addBoardPermission(permissions, role, targetNpub, userNpub);
    permissions = next;
    await persistPermissions(next);
  }

  async function handleRemovePermission(role: string, targetNpub: string): Promise<string | void> {
    if (!permissions || !userNpub) return 'Could not update permissions.';
    if (role !== 'admin' && role !== 'writer') return 'Invalid role.';
    const next = removeBoardPermission(permissions, role, targetNpub, userNpub);
    if (next === permissions) {
      return role === 'admin'
        ? 'Board must have at least one admin.'
        : 'Could not update permissions.';
    }

    permissions = next;
    await persistPermissions(next);
  }

  function handleShare() {
    openShareModal(window.location.href);
  }

  onMount(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        flushPendingBoardSave('hidden');
      }
    };
    const handlePageHide = () => {
      flushPendingBoardSave('pagehide');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
    };
  });

  onDestroy(() => {
    flushPendingBoardSave('destroy');
    clearHydrateRetry();
    clearParticipantHydrateTimer();
    for (const previewUrl of Object.values(localAttachmentPreviewUrls)) {
      URL.revokeObjectURL(previewUrl);
    }
    for (const draftAttachment of commentDraftAttachments) {
      if (draftAttachment.previewUrl) URL.revokeObjectURL(draftAttachment.previewUrl);
    }
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
{:else if isProtectedBoardWithoutAccess}
  <div class="flex-1 flex items-center justify-center p-8">
    <div class="text-center">
      <div class="inline-flex items-center justify-center mb-4">
        {#if resolvedVisibility === 'link-visible'}
          {#if linkKey}
            <span class="i-lucide-key-round text-3xl text-danger"></span>
          {:else}
            <span class="relative inline-block shrink-0 text-3xl text-text-3">
              <span class="i-lucide-link"></span>
              <span class="i-lucide-lock absolute -bottom-0.5 -right-1.5 text-[0.6em]"></span>
            </span>
          {/if}
        {:else}
          <span class="i-lucide-lock text-3xl text-text-3"></span>
        {/if}
      </div>
      <div class="text-text-2 font-medium mb-2">
        {#if resolvedVisibility === 'link-visible'}
          {linkKey ? 'Invalid Link Key' : 'Link Required'}
        {:else}
          Private Board
        {/if}
      </div>
      <div class="text-text-3 text-sm max-w-xs mx-auto">
        {#if resolvedVisibility === 'link-visible'}
          {linkKey
            ? 'The link key provided is invalid or has expired. Ask the owner for a new link.'
            : 'This board requires a special link to access. Ask the owner for the link with the access key.'}
        {:else}
          This board is private and can only be accessed by its owner.
        {/if}
      </div>
    </div>
  </div>
{:else if board && permissions}
  <div class="flex-1 flex flex-col min-h-0">
    <input
      bind:this={cardAttachmentInputRef}
      type="file"
      multiple
      class="hidden"
      data-testid="board-card-draft-attachment-input"
      onchange={handleCardDraftAttachmentInputChange}
    />
    <input
      bind:this={attachmentInputRef}
      type="file"
      multiple
      class="hidden"
      data-testid="board-attachment-input"
      onchange={handleAttachmentInputChange}
    />
    <input
      bind:this={commentAttachmentInputRef}
      type="file"
      multiple
      class="hidden"
      data-testid="board-comment-attachment-input"
      onchange={handleCommentAttachmentInputChange}
    />

    <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-surface-3 bg-surface-0">
      <div class="min-w-0">
        {#if ownerNpub && ownerPubkey}
          <a
            href={`#/${ownerNpub}/profile`}
            aria-label="View board owner profile"
            data-testid="board-owner-link"
            class="inline-flex max-w-full items-center gap-2 no-underline text-xs text-text-3 hover:text-text-2"
          >
            <Avatar pubkey={ownerPubkey} size={20} showBadge class="shrink-0" />
            <Name pubkey={ownerPubkey} class="min-w-0 truncate font-medium" />
          </a>
        {/if}
        <h1 class={`text-lg font-semibold truncate ${ownerPubkey ? 'mt-1' : ''}`}>{board.title}</h1>
        <div class="mt-1 flex items-center gap-2 text-xs text-text-3">
          <VisibilityIcon {visibility} class="text-xs" />
          {#if canWrite}<span class="text-success">Write access</span>{:else}<span>Read-only</span>{/if}
          {#if savingBoard || savingPermissions || savingVisibility}<span class="animate-pulse">Saving...</span>{/if}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn-circle btn-ghost" onclick={handleShare} title="Share board">
          <span class="i-lucide-share-2"></span>
        </button>
        <button
          class="btn-ghost"
          onclick={handleOpenPermissions}
          title={canManage ? 'Manage permissions' : 'View permissions'}
        >
          <span class="i-lucide-shield-check mr-1"></span>
          Permissions
        </button>
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
            role="group"
            aria-label={`${column.title} column`}
            draggable={canWrite}
            ondragstart={(event) => handleColumnDragStart(event as DragEvent, column.id)}
            ondragend={handleColumnDragEnd}
            ondragover={(event) => handleColumnReorderDragOver(event as DragEvent, column.id)}
            ondrop={(event) => handleColumnReorderDrop(event as DragEvent, column.id)}
            class={`board-column-hover w-80 max-w-80 shrink-0 bg-surface-1 rounded-xl border border-surface-3 p-3 shadow-sm space-y-3 ${canWrite ? 'cursor-grab active:cursor-grabbing' : ''} ${draggingColumn?.columnId === column.id ? 'opacity-50' : ''} ${columnDropTargetClass(column.id)}`}
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <h2 class="font-semibold text-sm truncate">{column.title}</h2>
                <p class="text-[11px] text-text-3 mt-1">
                  {column.cards.length} {column.cards.length === 1 ? 'card' : 'cards'}
                </p>
              </div>
              {#if canWrite}
                <div class="h-8 w-8 shrink-0">
                  <button
                    class="board-column-action btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8 opacity-0 pointer-events-none transition-opacity"
                    aria-label="Edit column"
                    title="Edit column"
                    onclick={() => openEditColumnModal(column.id, column.title)}
                  >
                    <span class="i-lucide-pencil text-sm"></span>
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
                  class={`board-card-hover bg-surface-0 border border-surface-3 rounded-lg p-3 transition-shadow ${canWrite ? 'cursor-grab active:cursor-grabbing hover:shadow-md' : ''} ${draggingCard?.cardId === card.id ? 'opacity-50' : ''} ${cardDropTargetClass(column.id, card.id)}`}
                >
                  <div class="flex items-start gap-2">
                    <button
                      type="button"
                      class="min-w-0 flex-1 text-left"
                      aria-label="Open card details"
                      onclick={() => openCardViewModal(column.id, card.id)}
                    >
                      <h3 class="text-sm font-medium break-words">{card.title}</h3>
                      {#if card.description}
                        <p class="text-xs text-text-3 mt-1 whitespace-pre-wrap line-clamp-3">{card.description}</p>
                      {/if}
                    </button>
                    {#if canWrite}
                      <div class="h-8 w-8 shrink-0">
                        <button
                          type="button"
                          class="board-card-action btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8 opacity-0 pointer-events-none transition-opacity"
                          aria-label="Quick edit card"
                          title="Edit card"
                          onclick={(event) => {
                            event.stopPropagation();
                            openEditCardModal(column.id, card);
                          }}
                        >
                          <span class="i-lucide-pencil text-[11px]"></span>
                        </button>
                      </div>
                    {/if}
                  </div>

                  {#if card.assigneeNpubs.length > 0}
                    <div class="mt-2 text-[11px] text-text-3 flex items-center gap-1">
                      <span class="i-lucide-users text-[11px]"></span>
                      <span>{card.assigneeNpubs.length} {card.assigneeNpubs.length === 1 ? 'assignee' : 'assignees'}</span>
                    </div>
                  {/if}

                  {#if card.attachments.length > 0}
                    <div class="mt-2 space-y-1">
                      {#each card.attachments as attachment (attachment.id)}
                        {@const attachmentUrl = cardAttachmentUrl(attachment)}
                        {@const attachmentImageUrl = attachmentImageSrc(attachment)}
                        <div
                          class="rounded-md border border-surface-3 bg-surface-1 px-2 py-1.5"
                          data-testid={`board-card-attachment-${attachment.displayName}`}
                        >
                          {#if isImageAttachment(attachment) && attachmentImageUrl}
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
                                src={attachmentImageUrl}
                                alt={attachment.displayName}
                                onerror={(event) => handleAttachmentImageError(event as Event, attachment)}
                              />
                            </button>
                          {/if}
                          <div class="mt-1 flex items-center justify-between gap-2">
                            {#if isModalPreviewAttachment(attachment) && (attachmentUrl || attachmentImageUrl)}
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
                            </div>
                          </div>
                        </div>
                      {/each}
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

<style>
  .board-column-hover:hover .board-column-action,
  .board-column-hover:focus-within .board-column-action,
  .board-column-action:focus {
    opacity: 1;
    pointer-events: auto;
  }

  .board-card-hover:hover .board-card-action,
  .board-card-hover:focus-within .board-card-action,
  .board-card-action:focus {
    opacity: 1;
    pointer-events: auto;
  }
</style>

<Modal
  open={showColumnModal}
  onClose={closeColumnModal}
  label={columnModalMode === 'create' ? 'Create Column' : 'Edit Column'}
  panelClass="w-full max-w-md mx-4"
>
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
        bind:this={columnTitleInputRef}
        bind:value={columnDraftTitle}
        placeholder="Backlog"
      />
      {#if columnFormError}
        <p class="text-xs text-danger">{columnFormError}</p>
      {/if}
    </div>

    <div class="flex items-center justify-between gap-2">
      {#if columnModalMode === 'edit'}
        <button
          type="button"
          class="btn-danger"
          aria-label="Delete column"
          onclick={removeColumnFromModal}
        >
          <span class="i-lucide-trash-2 mr-1"></span>
          Delete column
        </button>
      {:else}
        <span></span>
      {/if}
      <div class="flex items-center gap-2">
      <button type="button" class="btn-ghost" onclick={closeColumnModal}>Cancel</button>
      <button type="submit" class="btn-primary">
        {columnModalMode === 'create' ? 'Create Column' : 'Save Column'}
      </button>
      </div>
    </div>
  </form>
</Modal>

{#if showCardModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    data-modal-backdrop
    onclick={closeCardModal}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="w-full max-w-lg mx-4" onclick={(event) => event.stopPropagation()}>
      <form
        class="bg-surface-1 rounded-lg shadow-lg border border-surface-3 p-5 space-y-4 max-h-[90vh] overflow-y-auto"
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
            bind:this={cardTitleInputRef}
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

        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-medium">Attachments</div>
            <button
              type="button"
              class="btn-ghost"
              onclick={triggerCardDraftAttachmentPicker}
              disabled={cardDraftUploading}
            >
              {#if cardDraftUploading}
                <span class="i-lucide-loader-2 animate-spin mr-1"></span>
              {:else}
                <span class="i-lucide-paperclip mr-1"></span>
              {/if}
              Attach files
            </button>
          </div>

          {#if cardDraftAttachments.length === 0}
            <p class="text-xs text-text-3">No attachments.</p>
          {:else}
            <div class="max-h-44 overflow-auto rounded-lg border border-surface-3 bg-surface-0 p-2 space-y-2">
              {#each cardDraftAttachments as draftAttachment (draftAttachment.id)}
                {@const draftPreviewUrl = attachmentImageSrc(draftAttachment)}
                <div class="rounded-md border border-surface-3 bg-surface-1 px-2 py-2 space-y-2">
                  {#if isImageAttachment(draftAttachment) && draftPreviewUrl}
                    <img
                      class="w-full h-24 object-cover rounded border border-surface-3"
                      src={draftPreviewUrl}
                      alt={draftAttachment.displayName}
                      onerror={(event) => handleAttachmentImageError(event as Event, draftAttachment)}
                    />
                  {/if}
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs truncate" title={draftAttachment.displayName}>
                      {draftAttachment.displayName}
                    </span>
                    <div class="flex items-center gap-2 shrink-0">
                      <span class="text-[10px] text-text-3">{formatAttachmentSize(draftAttachment.size)}</span>
                      <button
                        type="button"
                        class="btn-circle btn-ghost text-danger"
                        title={`Remove ${draftAttachment.displayName}`}
                        onclick={() => removeCardDraftAttachment(draftAttachment.id)}
                      >
                        <span class="i-lucide-x text-[10px]"></span>
                      </button>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="space-y-2">
          <div class="text-sm font-medium">Assignees</div>
          {#if boardMemberNpubs.length === 0}
            <p class="text-xs text-text-3">No board members available.</p>
          {:else}
            <div class="max-h-40 overflow-auto rounded-lg border border-surface-3 bg-surface-0 p-2 space-y-1">
              {#each boardMemberNpubs as memberNpub (memberNpub)}
                {@const memberPubkey = npubToPubkey(memberNpub)}
                <label class="flex items-center justify-between gap-2 px-1 py-1 rounded hover:bg-surface-2 cursor-pointer">
                  <span class="flex items-center gap-2 min-w-0">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-xs"
                      checked={cardDraftAssigneeNpubs.includes(memberNpub)}
                      onchange={(event) => {
                        const target = event.currentTarget as HTMLInputElement;
                        toggleCardDraftAssignee(memberNpub, target.checked);
                      }}
                    />
                    {#if memberPubkey}
                      <Avatar pubkey={memberPubkey} size={18} />
                      <Name pubkey={memberPubkey} class="text-xs truncate" />
                    {:else}
                      <span class="text-xs font-mono truncate" title={memberNpub}>{shortNpub(memberNpub)}</span>
                    {/if}
                  </span>
                  <span class="text-[10px] text-text-3">{boardMemberRoleLabel(memberNpub)}</span>
                </label>
              {/each}
            </div>
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

{#if showCardViewModal && viewedCardState}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[55] flex items-center justify-center bg-black/70 p-4"
    data-modal-backdrop
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Card details"
    onclick={closeCardViewModal}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-surface-1 rounded-lg shadow-lg border border-surface-3 p-5 space-y-4"
      onclick={(event) => event.stopPropagation()}
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-lg font-semibold break-words">{viewedCardState.card.title}</h3>
          <p class="text-xs text-text-3 mt-1">in {viewedCardState.column.title}</p>
        </div>
        <button type="button" class="btn-circle btn-ghost" onclick={closeCardViewModal} aria-label="Close card details">
          <span class="i-lucide-x"></span>
        </button>
      </div>

      {#if viewedCardState.card.description}
        <p class="text-sm whitespace-pre-wrap">{viewedCardState.card.description}</p>
      {:else}
        <p class="text-sm text-text-3">No description.</p>
      {/if}

      <div class="space-y-2">
        <div class="text-sm font-medium">Assignees</div>
        {#if viewedCardState.card.assigneeNpubs.length === 0}
          <p class="text-xs text-text-3">No assignees.</p>
        {:else}
          <div class="flex flex-wrap gap-2">
            {#each viewedCardState.card.assigneeNpubs as assigneeNpub (assigneeNpub)}
              {@const assigneePubkey = npubToPubkey(assigneeNpub)}
              <span class="inline-flex items-center gap-1 rounded-full border border-surface-3 bg-surface-0 px-2 py-0.5 text-xs">
                {#if assigneePubkey}
                  <Avatar pubkey={assigneePubkey} size={16} />
                  <Name pubkey={assigneePubkey} class="truncate max-w-28" />
                {:else}
                  <span class="font-mono" title={assigneeNpub}>{shortNpub(assigneeNpub)}</span>
                {/if}
                <span class="text-text-3">{boardMemberRoleLabel(assigneeNpub)}</span>
              </span>
            {/each}
          </div>
        {/if}
      </div>

      <div class="space-y-2">
        <div class="text-sm font-medium">Attachments</div>
        {#if viewedCardState.card.attachments.length === 0}
          <p class="text-xs text-text-3">No attachments.</p>
        {:else}
          <div class="space-y-2">
            {#each viewedCardState.card.attachments as attachment (attachment.id)}
              {@const attachmentUrl = cardAttachmentUrl(attachment)}
              {@const attachmentImageUrl = attachmentImageSrc(attachment)}
              <div class="rounded-md border border-surface-3 bg-surface-0 px-2 py-2 space-y-2">
                {#if isImageAttachment(attachment) && attachmentImageUrl}
                  <button
                    type="button"
                    class="block w-full bg-transparent border-none p-0 cursor-zoom-in"
                    title={attachment.displayName}
                    onclick={() => openAttachmentPreview(attachment)}
                  >
                    <img
                      class="w-full max-h-56 object-cover rounded border border-surface-3"
                      src={attachmentImageUrl}
                      alt={attachment.displayName}
                      onerror={(event) => handleAttachmentImageError(event as Event, attachment)}
                    />
                  </button>
                {/if}
                <div class="flex items-center justify-between gap-2">
                  {#if isModalPreviewAttachment(attachment) && (attachmentUrl || attachmentImageUrl)}
                    <button
                      type="button"
                      class="text-xs text-accent hover:underline truncate bg-transparent border-none p-0 text-left"
                      title={attachment.displayName}
                      onclick={() => openAttachmentPreview(attachment)}
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
                    <span class="text-xs text-text-3 truncate">{attachment.displayName}</span>
                  {/if}
                  <div class="flex items-center gap-2">
                    <span class="text-[10px] text-text-3">{formatAttachmentSize(attachment.size)}</span>
                    {#if canWrite}
                      <button
                        type="button"
                        class="btn-circle btn-ghost text-danger"
                        title={`Remove ${attachment.displayName}`}
                        onclick={() => removeAttachment(viewedCardState.column.id, viewedCardState.card.id, attachment.id)}
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
      </div>

      <div class="space-y-2">
        <div class="text-sm font-medium">Comments</div>
        {#if viewedCardState.card.comments.length === 0}
          <p class="text-xs text-text-3">No comments yet.</p>
        {:else}
          <div class="space-y-2">
            {#each viewedCardState.card.comments as comment (comment.id)}
              {@const commentAuthorPubkey = npubToPubkey(comment.authorNpub)}
              <article class="rounded-md border border-surface-3 bg-surface-0 p-3 space-y-2" data-testid={`board-comment-${comment.id}`}>
                <div class="flex items-center justify-between gap-2 text-[11px] text-text-3">
                  <div class="min-w-0 inline-flex items-center gap-2">
                    {#if commentAuthorPubkey}
                      <Avatar pubkey={commentAuthorPubkey} size={18} />
                      <Name pubkey={commentAuthorPubkey} class="text-xs text-text-2 truncate" />
                    {:else}
                      <span class="font-mono truncate" title={comment.authorNpub}>{shortNpub(comment.authorNpub)}</span>
                    {/if}
                  </div>
                  <span class="shrink-0">{formatCommentTimestamp(comment.createdAt)}</span>
                </div>
                {#if comment.markdown}
                  <div class="text-sm break-words leading-relaxed [&_a]:text-accent [&_a:hover]:underline [&_code]:bg-surface-2 [&_code]:rounded [&_code]:px-1 [&_pre]:bg-surface-2 [&_pre]:rounded [&_pre]:p-2">
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown is sanitized with DOMPurify in renderMarkdown -->
                    {@html renderMarkdown(comment.markdown)}
                  </div>
                {/if}
                {#if comment.attachments.length > 0}
                  <div class="grid grid-cols-2 gap-2">
                    {#each comment.attachments as commentAttachment (commentAttachment.id)}
                      {@const commentAttachmentUrl = cardAttachmentUrl(commentAttachment)}
                      {@const commentAttachmentImageUrl = attachmentImageSrc(commentAttachment)}
                      <div class="rounded-md border border-surface-3 bg-surface-1 p-2 space-y-1">
                        {#if isImageAttachment(commentAttachment) && commentAttachmentImageUrl}
                          <button
                            type="button"
                            class="block w-full bg-transparent border-none p-0 cursor-zoom-in"
                            onclick={() => openAttachmentPreview(commentAttachment)}
                            title={commentAttachment.displayName}
                          >
                            <img
                              class="w-full h-20 object-cover rounded border border-surface-3"
                              src={commentAttachmentImageUrl}
                              alt={commentAttachment.displayName}
                              onerror={(event) => handleAttachmentImageError(event as Event, commentAttachment)}
                            />
                          </button>
                        {/if}
                        <div class="flex items-center justify-between gap-2">
                          {#if isModalPreviewAttachment(commentAttachment) && (commentAttachmentUrl || commentAttachmentImageUrl)}
                            <button
                              type="button"
                              class="text-xs text-accent hover:underline truncate bg-transparent border-none p-0 text-left"
                              onclick={() => openAttachmentPreview(commentAttachment)}
                              title={commentAttachment.displayName}
                            >
                              {commentAttachment.displayName}
                            </button>
                          {:else if commentAttachmentUrl}
                            <a
                              class="text-xs text-accent hover:underline truncate"
                              href={commentAttachmentUrl}
                              target="_blank"
                              rel="noreferrer"
                              title={commentAttachment.displayName}
                            >
                              {commentAttachment.displayName}
                            </a>
                          {:else}
                            <span class="text-xs text-text-3 truncate">{commentAttachment.displayName}</span>
                          {/if}
                          <span class="text-[10px] text-text-3 shrink-0">{formatAttachmentSize(commentAttachment.size)}</span>
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      </div>

      {#if canWrite}
        <div class="space-y-2 border-t border-surface-3 pt-3">
          <div class="relative rounded-lg border border-surface-3 bg-surface-0">
            <textarea
              id="board-card-comment-markdown"
              aria-label="Add comment"
              class="w-full text-sm min-h-24 rounded-lg bg-transparent px-3 py-2 pb-14 resize-y focus:outline-none focus:ring-2 focus:ring-accent/40"
              bind:value={commentDraftMarkdown}
              placeholder="Add comment."
            ></textarea>
            <div class="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-2 py-2 border-t border-surface-3 bg-surface-0/95 rounded-b-lg">
              <button type="button" class="btn-ghost" onclick={triggerCommentAttachmentPicker}>
                <span class="i-lucide-paperclip mr-1"></span>
                Attach files
              </button>
              <button
                type="button"
                class="btn-primary"
                onclick={submitComment}
                disabled={commentSubmitting || (!commentDraftMarkdown.trim() && commentDraftAttachments.length === 0)}
              >
                {#if commentSubmitting}
                  <span class="i-lucide-loader-2 animate-spin mr-1"></span>
                {/if}
                Add comment
              </button>
            </div>
          </div>

          {#if commentDraftAttachments.length > 0}
            <div class="flex flex-wrap gap-2">
              {#each commentDraftAttachments as draftAttachment (draftAttachment.id)}
                <div class="rounded-md border border-surface-3 bg-surface-0 px-2 py-2 max-w-44">
                  {#if draftAttachment.previewUrl}
                    <img class="w-full h-20 object-cover rounded border border-surface-3 mb-1" src={draftAttachment.previewUrl} alt={draftAttachment.displayName} />
                  {/if}
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs truncate" title={draftAttachment.displayName}>{draftAttachment.displayName}</span>
                    <button
                      type="button"
                      class="btn-circle btn-ghost text-danger"
                      title={`Remove ${draftAttachment.displayName}`}
                      onclick={() => removeCommentDraftAttachment(draftAttachment.id)}
                    >
                      <span class="i-lucide-x text-[10px]"></span>
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          {#if commentFormError}
            <p class="text-xs text-danger">{commentFormError}</p>
          {/if}
        </div>
      {/if}

      {#if canWrite}
        <div class="flex items-center justify-end gap-2 pt-2 border-t border-surface-3">
          <button
            type="button"
            class="btn-ghost"
            onclick={attachToViewedCard}
            disabled={!viewedCardState || isUploadingCard(viewedCardState.column.id, viewedCardState.card.id)}
          >
            {#if viewedCardState && isUploadingCard(viewedCardState.column.id, viewedCardState.card.id)}
              <span class="i-lucide-loader-2 animate-spin mr-1"></span>
            {:else}
              <span class="i-lucide-paperclip mr-1"></span>
            {/if}
            Attach file
          </button>
          <button type="button" class="btn-ghost" onclick={openEditViewedCard}>
            <span class="i-lucide-pencil mr-1"></span>
            Edit card
          </button>
          <button type="button" class="btn-danger" onclick={removeViewedCard}>
            <span class="i-lucide-trash-2 mr-1"></span>
            Delete card
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

{#if showMediaModal && mediaAttachment}
  {@const mediaAttachmentUrl = cardAttachmentUrl(mediaAttachment)}
  {@const mediaAttachmentImageUrl = attachmentImageSrc(mediaAttachment)}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
    data-modal-backdrop
    role="dialog"
    tabindex="-1"
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
        {#if isImageAttachment(mediaAttachment) && mediaAttachmentImageUrl}
          <div class="h-full w-full flex items-center justify-center p-3">
            <img
              src={mediaAttachmentImageUrl}
              alt={mediaAttachment.displayName}
              class="max-w-full max-h-full object-contain"
              onerror={(event) => handleAttachmentImageError(event as Event, mediaAttachment)}
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

{#if permissions}
  <NpubAccessModal
    open={showPermissionsModal}
    onClose={() => showPermissionsModal = false}
    title="Board Permissions"
    intro={permissionIntro}
    sections={permissionSections}
    canEdit={canManage}
    validateAdd={validatePermissionAdd}
    onAdd={handleAddPermission}
    onRemove={handleRemovePermission}
    initialSectionId="writer"
    addPromptLabel="Assign role"
    requestAccess={permissionRequestAccess}
    panelClass="w-full max-w-lg mx-4"
    sectionsClass="grid grid-cols-1 gap-3 sm:grid-cols-2"
  >
    {#snippet beforeSections()}
      <div class="rounded-lg border border-surface-3 bg-surface-2 px-3 py-3 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-sm font-medium">Visibility</div>
            <p class="text-xs text-text-3 mt-1">This controls who can open the shared board link.</p>
          </div>
          <div class="inline-flex items-center gap-2 text-xs text-text-3">
            <VisibilityIcon {visibility} class="text-sm" />
            <span>{visibility}</span>
          </div>
        </div>

        {#if isOwnBoard}
          <VisibilityPicker value={visibilityDraft} onchange={(value) => {
            visibilityDraft = value;
            visibilityError = '';
          }} />
          <div class="flex items-center justify-between gap-3">
            <p class="text-xs text-text-3">
              Public boards are open to everyone. Link-visible boards need the URL key. Private boards are owner-only.
            </p>
            <button
              class="btn-primary shrink-0"
              onclick={handleUpdateVisibility}
              disabled={savingVisibility || visibilityDraft === visibility}
            >
              {#if savingVisibility}
                Updating...
              {:else if visibilityDraft === visibility}
                Current
              {:else}
                Update Visibility
              {/if}
            </button>
          </div>
          {#if visibilityError}
            <p class="text-xs text-danger">{visibilityError}</p>
          {/if}
        {:else}
          <p class="text-xs text-text-3">Only the board owner can change visibility for the shared board link.</p>
        {/if}
      </div>
    {/snippet}
  </NpubAccessModal>
{/if}
