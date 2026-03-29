<script lang="ts">
  /**
   * VideoNHashView - Video player for content-addressed permalinks
   * The nhash points to the video file content; directory metadata is optional.
   */
  import { untrack } from 'svelte';
  import { LinkType, nhashDecode, type CID } from '@hashtree/core';
  import { getTree } from '../../store';
  import ShareButton from '../ShareButton.svelte';
  import { getNhashFileUrl } from '../../lib/mediaUrl';
  import VideoComments from './VideoComments.svelte';
  import VideoDetails from './VideoDetails.svelte';
  import VideoLayout from './VideoLayout.svelte';
  import { routeStore } from '../../stores';
  import {
    buildTreeEventPermalink,
    ensureLatestTreeEventSnapshot,
    isNewerTreeEventSnapshot,
    readTreeEventSnapshot,
    resolveSnapshotRootCid,
    type TreeEventSnapshotInfo,
  } from '../../lib/treeEventSnapshots';
  import { readVideoDirectoryMetadata } from '../../lib/videoMetadata';
  import { FollowButton } from '../User';

  interface Props {
    nhash: string;
    wild?: string;
  }

  let { nhash, wild = '' }: Props = $props();

  let videoFileName = $state<string>('video.mp4');
  let error = $state<string | null>(null);
  let videoCid = $state<CID | null>(null);
  let videoRef: HTMLVideoElement | undefined = $state();
  let snapshotInfo = $state<TreeEventSnapshotInfo | null>(null);
  let newerSnapshot = $state<TreeEventSnapshotInfo | null>(null);

  // Metadata
  let videoTitle = $state<string>('');
  let videoDescription = $state<string>('');
  let route = $derived($routeStore);
  let isSnapshotPermalink = $derived(route.params.get('snapshot') === '1');
  let snapshotPath = $derived(wild ? wild.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment)) : []);
  let ownerNpub = $derived(snapshotInfo?.npub ?? null);
  let ownerPubkey = $derived(snapshotInfo?.event.pubkey ?? null);
  let snapshotVisibility = $derived(snapshotInfo?.visibility ?? null);
  let latestSnapshotHref = $derived.by(() =>
    newerSnapshot
      ? buildTreeEventPermalink(newerSnapshot, snapshotPath, route.params.get('k'))
      : null
  );
  let currentHref = $derived.by(() => {
    if (snapshotInfo) {
      return buildTreeEventPermalink(snapshotInfo, snapshotPath, route.params.get('k'));
    }
    return `#/${nhash}`;
  });

  let normalizedNhash = $derived.by(() => {
    if (typeof nhash !== 'string') return '';
    return nhash.startsWith('hashtree:') ? nhash.slice(9) : nhash;
  });

  // Decode nhash to CID
  let decodedCid = $derived.by(() => {
    if (!normalizedNhash) return null;
    try {
      return nhashDecode(normalizedNhash);
    } catch (e) {
      console.error('[VideoNHashView] Failed to decode nhash:', normalizedNhash, e);
      return null;
    }
  });

  let nhashError = $derived.by(() => {
    if (!normalizedNhash) return 'Invalid nhash format';
    if (!decodedCid) return 'Invalid nhash format';
    return null;
  });

  let activeVideoCid = $derived.by(() => videoCid ?? decodedCid);

  let videoSrc = $derived.by(() => {
    if (!activeVideoCid) return '';
    return getNhashFileUrl(activeVideoCid, videoFileName || 'video.mp4');
  });

  let displayError = $derived.by(() => nhashError || error);
  let loading = $derived.by(() => !displayError && !videoSrc);

  // Load video when nhash changes
  $effect(() => {
    error = null;
    videoTitle = '';
    videoDescription = '';
    videoFileName = 'video.mp4';
    snapshotInfo = null;
    newerSnapshot = null;

    const cid = decodedCid;
    if (cid) {
      videoCid = cid;
      if (isSnapshotPermalink) {
        untrack(() => loadSnapshotPermalink(cid, snapshotPath, route.params.get('k')));
      } else {
        untrack(() => loadVideoDirectory(cid));
      }
    } else {
      videoCid = null;
    }
  });

  async function loadVideoDirectory(cidParam: CID) {
    try {
      const tree = getTree();
      const metadata = await readVideoDirectoryMetadata(tree, cidParam);
      const { videoEntry } = metadata;
      if (!videoEntry) return;

      videoCid = videoEntry.cid;
      videoFileName = videoEntry.name;
      videoTitle = metadata.title;
      videoDescription = metadata.description;
    } catch (e) {
      console.error('[VideoNHashView] Failed to load directory:', e);
    }
  }

  async function loadSnapshotPermalink(snapshotCid: CID, path: string[], linkKey: string | null) {
    try {
      const snapshot = await readTreeEventSnapshot(snapshotCid);
      if (!snapshot) {
        error = 'Invalid tree snapshot permalink';
        return;
      }

      snapshotInfo = snapshot;
      const rootCid = await resolveSnapshotRootCid(snapshot, linkKey);
      if (!rootCid) {
        error = 'Missing decryption key for tree snapshot';
        return;
      }

      if (path.length === 0) {
        await loadVideoDirectory(rootCid);
      } else {
        const tree = getTree();
        const resolved = await tree.resolvePath(rootCid, path.join('/'));
        if (!resolved) {
          error = 'Video path not found in tree snapshot';
          return;
        }

        if (resolved.type === LinkType.Dir) {
          await loadVideoDirectory(resolved.cid);
        } else {
          videoCid = resolved.cid;
          videoFileName = path[path.length - 1] || 'video.mp4';
        }
      }

      const latest = await ensureLatestTreeEventSnapshot(snapshot.npub, snapshot.treeName);
      if (latest && isNewerTreeEventSnapshot(latest, snapshot)) {
        newerSnapshot = latest;
      }
    } catch (e) {
      console.error('[VideoNHashView] Failed to load tree snapshot:', e);
      error = 'Failed to load tree snapshot';
    }
  }

  function handleDownload() {
    if (!activeVideoCid) return;
    const baseUrl = getNhashFileUrl(activeVideoCid, videoFileName || 'video.mp4');
    const separator = baseUrl.includes('?') ? '&' : '?';
    window.location.href = `${baseUrl}${separator}download=1`;
  }
</script>

{#snippet ownerActions()}
  <FollowButton pubkey={ownerPubkey} />
{/snippet}

{#snippet pageActions()}
  <ShareButton url={window.location.href} />
  {#if latestSnapshotHref}
    <a href={latestSnapshotHref} class="btn-ghost no-underline">
      See latest version
    </a>
  {/if}
  <button onclick={handleDownload} class="btn-ghost" disabled={!videoCid} title="Download">
    <span class="i-lucide-download text-base"></span>
    <span class="hidden sm:inline ml-1">Download</span>
  </button>
{/snippet}

{#snippet videoPlayer()}
  {#if loading}
    <div class="w-full h-full flex items-center justify-center bg-black text-white" data-testid="video-loading">
      <span class="i-lucide-loader-2 text-4xl text-text-3 animate-spin"></span>
    </div>
  {:else if displayError}
    <div class="w-full h-full flex items-center justify-center bg-black text-red-400" data-testid="video-error">
      <span class="i-lucide-alert-circle mr-2"></span>
      {displayError}
    </div>
  {:else}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={videoRef}
      src={videoSrc}
      class="w-full h-full bg-black"
      controls
      autoplay
      playsinline
      data-testid="video-player"
    ></video>
  {/if}
{/snippet}

{#snippet videoContent()}
  <VideoDetails
    title={videoTitle}
    visibility={snapshotVisibility}
    ownerHref={ownerNpub ? `#/${ownerNpub}` : null}
    ownerPubkey={ownerPubkey}
    {ownerActions}
    {pageActions}
    description={videoDescription}
    descriptionClass="bg-surface-1 text-sm text-text-1"
  />
  <VideoComments {nhash} filename={videoFileName || 'video.mp4'} />
{/snippet}

<VideoLayout {videoPlayer} {videoContent} {currentHref} />
