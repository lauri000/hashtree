<script lang="ts">
  import { toHex } from '@hashtree/core';
  import { loginWithExtension, nostrStore } from '../../nostr';
  import { getWorkerAdapter, waitForWorkerAdapter } from '../../lib/workerInit';
  import { logVideoMigrationEvent } from '../../lib/videoMigrationLog';
  import {
    publishVideoMigration,
    scanVideoMigrations,
    type VideoMigrationCandidate,
    type VideoMigrationScanProgress,
  } from '../../lib/videoMigration';

  let open = $state(false);
  let scanning = $state(false);
  let batchPublishing = $state(false);
  let activeTreeName = $state<string | null>(null);
  let publishProgress = $state<{
    treeName: string;
    stage: 'preparing' | 'uploading' | 'nostr';
    current: number;
    total: number;
    pushed?: number;
    skipped?: number;
    failed?: number;
  } | null>(null);
  let progress = $state<VideoMigrationScanProgress | null>(null);
  let scanError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let items = $state<VideoMigrationCandidate[]>([]);

  let currentNpub = $derived($nostrStore.npub);
  let isLoggedIn = $derived($nostrStore.isLoggedIn);

  let readyItems = $derived(items.filter((item) => item.status === 'ready' && !item.publishBlockedReason));
  let cleanCount = $derived(items.filter((item) => item.status === 'clean').length);
  let blockedCount = $derived(items.filter((item) => item.status === 'unfixable').length);
  let errorCount = $derived(items.filter((item) => item.status === 'error').length);

  const issueLabels: Record<string, string> = {
    'legacy-metadata': 'legacy metadata',
    'missing-title': 'missing title',
    'missing-description': 'missing description',
    'missing-duration': 'missing duration',
    'missing-thumbnail': 'missing thumbnail',
    'playlist-metadata': 'playlist metadata',
    'historical-root': 'historical root',
    'historical-thumbnail': 'historical thumbnail',
    'missing-playable-media': 'missing media',
    'link-key-unavailable': 'missing link key',
  };

  function shortRoot(hashSource: { hash: Uint8Array } | null | undefined): string {
    if (!hashSource?.hash) {
      return 'unknown';
    }
    return toHex(hashSource.hash).slice(0, 12);
  }

  async function connectExtension() {
    actionError = null;
    logVideoMigrationEvent('connect-extension:start', {
      currentNpub,
      isLoggedIn,
    });
    const success = await loginWithExtension();
    if (!success) {
      actionError = 'NIP-7 login failed.';
      logVideoMigrationEvent('connect-extension:error', {
        currentNpub,
      });
      return;
    }
    logVideoMigrationEvent('connect-extension:success', {
      currentNpub: $nostrStore.npub,
    });
  }

  async function runScan() {
    if (!currentNpub) {
      scanError = 'Log in with the account you want to repair before scanning.';
      logVideoMigrationEvent('scan:blocked', {
        reason: 'missing-current-npub',
      });
      return;
    }

    scanning = true;
    scanError = null;
    actionError = null;
    progress = { stage: 'list', current: 0, total: 0 };
    logVideoMigrationEvent('scan:start', {
      npub: currentNpub,
    });

    try {
      items = await scanVideoMigrations({
        npub: currentNpub,
        onProgress: (next) => {
          progress = next;
          logVideoMigrationEvent(`scan:${next.stage}`, {
            current: next.current,
            total: next.total,
            treeName: next.treeName ?? null,
          });
        },
      });
      logVideoMigrationEvent('scan:complete', {
        npub: currentNpub,
        totals: {
          total: items.length,
          ready: items.filter((item) => item.status === 'ready').length,
          clean: items.filter((item) => item.status === 'clean').length,
          blocked: items.filter((item) => item.status === 'unfixable').length,
          error: items.filter((item) => item.status === 'error').length,
        },
        items: items.map((item) => ({
          treeName: item.treeName,
          status: item.status,
          issueCodes: item.issueCodes,
          unresolvedIssueCodes: item.unresolvedIssueCodes,
          currentRoot: shortRoot(item.currentRootCid),
          publishRoot: shortRoot(item.publishBaseRootCid),
          publishBlockedReason: item.publishBlockedReason ?? null,
          error: item.error ?? null,
        })),
      });
    } catch (error) {
      scanError = error instanceof Error ? error.message : 'Failed to scan videos.';
      logVideoMigrationEvent('scan:error', {
        npub: currentNpub,
        error,
      });
    } finally {
      scanning = false;
      progress = null;
    }
  }

  function markPublished(treeName: string, nextRoot: { hash: Uint8Array }) {
    items = items.map((item) => {
      if (item.treeName !== treeName) {
        return item;
      }
      return {
        ...item,
        currentRootCid: nextRoot,
        publishBaseRootCid: nextRoot,
        thumbnailSourceRootCid: nextRoot,
        issueCodes: [],
        unresolvedIssueCodes: [],
        summary: ['Published migration. Re-scan to verify the current relay state.'],
        plan: null,
        currentRootWasReplaced: false,
        publishBlockedReason: undefined,
        status: 'clean',
      } satisfies VideoMigrationCandidate;
    });
  }

  function publishButtonLabel(treeName: string): string {
    if (activeTreeName !== treeName) {
      return 'Publish Fix';
    }
    if (!publishProgress || publishProgress.treeName !== treeName) {
      return 'Publishing…';
    }
    if (publishProgress.stage === 'uploading') {
      return publishProgress.total > 0
        ? `Uploading ${publishProgress.current}/${publishProgress.total}…`
        : 'Uploading…';
    }
    if (publishProgress.stage === 'nostr') {
      return 'Publishing root…';
    }
    return 'Preparing…';
  }

  function publishStatusText(treeName: string): string | null {
    if (activeTreeName !== treeName) {
      return null;
    }
    if (!publishProgress || publishProgress.treeName !== treeName || publishProgress.stage === 'preparing') {
      return 'Preparing repaired root…';
    }
    if (publishProgress.stage === 'uploading') {
      return publishProgress.total > 0
        ? `Uploading to Blossom ${publishProgress.current} / ${publishProgress.total}…`
        : 'Uploading to Blossom…';
    }

    const pushed = publishProgress.pushed ?? 0;
    const skipped = publishProgress.skipped ?? 0;
    const failed = publishProgress.failed ?? 0;
    const uploadSummary = failed > 0
      ? `${pushed} pushed, ${skipped} skipped, ${failed} failed`
      : `${pushed} pushed, ${skipped} skipped`;
    return `Upload complete (${uploadSummary}). Publishing root event…`;
  }

  async function attachPublishProgress(treeName: string): Promise<() => void> {
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(10000);
    if (!adapter) {
      return () => {
        if (publishProgress?.treeName === treeName) {
          publishProgress = null;
        }
      };
    }

    let lastLoggedAt = 0;
    let lastLoggedCurrent = -1;

    adapter.onBlossomPushProgress((progressTreeName, current, total) => {
      if (progressTreeName !== treeName) {
        return;
      }
      publishProgress = { treeName, stage: 'uploading', current, total };

      const now = Date.now();
      const boundaryStep = current <= 1 || (total > 0 && current === total);
      const progressStep = total > 0 && current - lastLoggedCurrent >= Math.max(1, Math.ceil(total / 10));
      if (boundaryStep || progressStep || now - lastLoggedAt >= 5000) {
        lastLoggedAt = now;
        lastLoggedCurrent = current;
        logVideoMigrationEvent('publish:blossom-progress', {
          treeName,
          current,
          total,
        });
      }
    });

    adapter.onBlossomPushComplete((completeTreeName, pushed, skipped, failed) => {
      if (completeTreeName !== treeName) {
        return;
      }
      publishProgress = {
        treeName,
        stage: 'nostr',
        current: 0,
        total: 0,
        pushed,
        skipped,
        failed,
      };
      logVideoMigrationEvent('publish:blossom-complete', {
        treeName,
        pushed,
        skipped,
        failed,
      });
    });

    return () => {
      adapter.onBlossomPushProgress(() => {});
      adapter.onBlossomPushComplete(() => {});
      if (publishProgress?.treeName === treeName) {
        publishProgress = null;
      }
    };
  }

  async function publishOne(item: VideoMigrationCandidate) {
    actionError = null;
    activeTreeName = item.treeName;
    publishProgress = {
      treeName: item.treeName,
      stage: 'preparing',
      current: 0,
      total: 0,
    };
    const resetPublishProgress = await attachPublishProgress(item.treeName);
    logVideoMigrationEvent('publish:start', {
      treeName: item.treeName,
      visibility: item.visibility,
      issueCodes: item.issueCodes,
      currentRoot: shortRoot(item.currentRootCid),
      publishRoot: shortRoot(item.publishBaseRootCid),
    });
    try {
      const result = await publishVideoMigration(item);
      markPublished(item.treeName, result.cid);
      logVideoMigrationEvent('publish:success', {
        treeName: item.treeName,
        visibility: result.visibility,
        cid: shortRoot(result.cid),
        blossom: result.blossom ?? null,
      });
    } catch (error) {
      actionError = error instanceof Error ? error.message : `Failed to publish ${item.displayName}.`;
      logVideoMigrationEvent('publish:error', {
        treeName: item.treeName,
        error,
      });
    } finally {
      resetPublishProgress();
      activeTreeName = null;
    }
  }

  async function publishAll() {
    batchPublishing = true;
    actionError = null;
    const targets = [...readyItems];
    const failures: string[] = [];
    logVideoMigrationEvent('publish-all:start', {
      count: targets.length,
      treeNames: targets.map((item) => item.treeName),
    });

    for (const item of targets) {
      activeTreeName = item.treeName;
      publishProgress = {
        treeName: item.treeName,
        stage: 'preparing',
        current: 0,
        total: 0,
      };
      const resetPublishProgress = await attachPublishProgress(item.treeName);
      try {
        const result = await publishVideoMigration(item);
        markPublished(item.treeName, result.cid);
        logVideoMigrationEvent('publish-all:item-success', {
          treeName: item.treeName,
          cid: shortRoot(result.cid),
          blossom: result.blossom ?? null,
        });
      } catch (error) {
        failures.push(`${item.displayName}: ${error instanceof Error ? error.message : 'publish failed'}`);
        logVideoMigrationEvent('publish-all:item-error', {
          treeName: item.treeName,
          error,
        });
      } finally {
        resetPublishProgress();
      }
    }

    activeTreeName = null;
    publishProgress = null;
    batchPublishing = false;
    if (failures.length > 0) {
      actionError = failures.join(' | ');
    }
    logVideoMigrationEvent('publish-all:complete', {
      attempted: targets.length,
      failures,
    });
  }
</script>

<details bind:open={open} class="bg-surface-2 rounded p-3">
  <summary class="cursor-pointer list-none flex items-center justify-between gap-3">
    <span class="text-sm text-text-2">Advanced maintenance</span>
    <span class="text-xs text-text-3">video root repair</span>
  </summary>

  <div class="mt-4 space-y-4">
    <p class="text-sm text-text-2">
      Scans the current account’s published <span class="font-mono">videos/*</span> trees,
      repairs legacy metadata and recoverable thumbnails, and republishes fixed roots.
    </p>

    <div class="bg-surface-1 rounded p-3 text-sm">
      {#if currentNpub}
        <div class="flex flex-col gap-1">
          <span class="text-text-3">Current account</span>
          <span class="font-mono text-xs break-all text-text-1">{currentNpub}</span>
        </div>
      {:else}
        <div class="text-text-2">No account connected.</div>
      {/if}
      <div class="mt-3 flex flex-wrap gap-2">
        <button onclick={runScan} class="btn-ghost" disabled={scanning || batchPublishing || !isLoggedIn}>
          {#if scanning}
            Scanning…
          {:else}
            Scan Published Videos
          {/if}
        </button>
        <button onclick={connectExtension} class="btn-ghost" disabled={scanning || batchPublishing}>
          Use NIP-7 Extension
        </button>
      </div>
      <p class="mt-2 text-xs text-text-3">
        Signing uses the currently connected account. Reconnect with the extension first if you want NIP-7 prompts.
      </p>
    </div>

    {#if progress}
      <div class="text-xs text-text-3">
        {#if progress.stage === 'list'}
          Loading current video trees…
        {:else}
          Inspecting {progress.current} / {progress.total}
          {#if progress.treeName}
            <span class="font-mono">({progress.treeName})</span>
          {/if}
        {/if}
      </div>
    {/if}

    {#if scanError}
      <div class="rounded bg-red-500/10 px-3 py-2 text-sm text-red-300">
        {scanError}
      </div>
    {/if}

    {#if actionError}
      <div class="rounded bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
        {actionError}
      </div>
    {/if}

    {#if items.length > 0}
      <div class="flex flex-wrap items-center gap-3 text-xs text-text-3">
        <span>{readyItems.length} ready</span>
        <span>{cleanCount} clean</span>
        <span>{blockedCount} blocked</span>
        <span>{errorCount} errors</span>
      </div>

      {#if readyItems.length > 1}
        <button onclick={publishAll} class="btn-ghost" disabled={batchPublishing || scanning}>
          {#if batchPublishing}
            Publishing fixes…
          {:else}
            Publish All Repairs
          {/if}
        </button>
      {/if}

      <div class="space-y-3">
        {#each items as item (item.treeName)}
          <div class="rounded bg-surface-1 p-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="text-sm font-medium text-text-1 break-words">{item.displayName}</div>
                <div class="mt-1 flex flex-wrap gap-2 text-[11px] text-text-3">
                  <span class="font-mono">{item.treeName}</span>
                  <span>root {shortRoot(item.currentRootCid)}</span>
                  {#if item.currentRootWasReplaced}
                    <span>publish {shortRoot(item.publishBaseRootCid)}</span>
                  {/if}
                  {#if item.thumbnailSourceRootCid && shortRoot(item.thumbnailSourceRootCid) !== shortRoot(item.publishBaseRootCid)}
                    <span>thumb {shortRoot(item.thumbnailSourceRootCid)}</span>
                  {/if}
                </div>
              </div>

              <div class="flex flex-wrap gap-2">
                {#if item.status === 'ready'}
                  <button
                    onclick={() => publishOne(item)}
                    class="btn-ghost"
                    disabled={activeTreeName === item.treeName || batchPublishing || !!item.publishBlockedReason}
                  >
                    {publishButtonLabel(item.treeName)}
                  </button>
                {/if}
                <a href={`#/${item.npub}/${encodeURIComponent(item.treeName)}`} class="btn-ghost no-underline">
                  Open
                </a>
              </div>
            </div>

            {#if item.issueCodes.length > 0}
              <div class="mt-3 flex flex-wrap gap-2">
                {#each item.issueCodes as issue}
                  <span class="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-2">
                    {issueLabels[issue] ?? issue}
                  </span>
                {/each}
              </div>
            {/if}

            {#if item.summary.length > 0}
              <div class="mt-3 space-y-1 text-sm text-text-2">
                {#each item.summary as line}
                  <div>{line}</div>
                {/each}
              </div>
            {/if}

            {#if publishStatusText(item.treeName)}
              <div class="mt-3 rounded bg-surface-2 px-3 py-2 text-xs text-text-2">
                {publishStatusText(item.treeName)}
              </div>
            {/if}

            {#if item.publishBlockedReason}
              <div class="mt-3 rounded bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                {item.publishBlockedReason}
              </div>
            {/if}

            {#if item.error}
              <div class="mt-3 rounded bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {item.error}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else if !scanning}
      <div class="text-sm text-text-3">
        Run a scan to see which published videos can be repaired.
      </div>
    {/if}
  </div>
</details>
