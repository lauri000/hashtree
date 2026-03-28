import { writable, get, type Readable } from 'svelte/store';
import type { CID } from '@hashtree/core';
import { routeStore, getRouteSync } from './route';
import type { RouteInfo } from '../utils/route';
import {
  readTreeEventSnapshot,
  resolveSnapshotRootCid,
  type TreeEventSnapshotInfo,
} from '../lib/treeEventSnapshots';

export interface PermalinkSnapshotState {
  active: boolean;
  loading: boolean;
  snapshot: TreeEventSnapshotInfo | null;
  rootCid: CID | null;
  error: string | null;
}

const initialState: PermalinkSnapshotState = {
  active: false,
  loading: false,
  snapshot: null,
  rootCid: null,
  error: null,
};

function isSnapshotPermalinkRoute(route: RouteInfo): boolean {
  return route.isPermalink && route.params.get('snapshot') === '1' && !!route.cid;
}

const permalinkSnapshotWritable = writable<PermalinkSnapshotState>(initialState);
let requestToken = 0;

async function updatePermalinkSnapshot(route: RouteInfo): Promise<void> {
  const token = ++requestToken;

  if (!isSnapshotPermalinkRoute(route) || !route.cid) {
    permalinkSnapshotWritable.set(initialState);
    return;
  }

  permalinkSnapshotWritable.set({
    active: true,
    loading: true,
    snapshot: null,
    rootCid: null,
    error: null,
  });

  const snapshot = await readTreeEventSnapshot(route.cid);
  if (token !== requestToken) {
    return;
  }
  if (!snapshot) {
    permalinkSnapshotWritable.set({
      active: true,
      loading: false,
      snapshot: null,
      rootCid: null,
      error: 'Invalid tree snapshot permalink',
    });
    return;
  }

  const rootCid = await resolveSnapshotRootCid(snapshot, route.params.get('k'));
  if (token !== requestToken) {
    return;
  }

  permalinkSnapshotWritable.set({
    active: true,
    loading: false,
    snapshot,
    rootCid,
    error: rootCid ? null : 'Missing decryption key for tree snapshot',
  });
}

routeStore.subscribe((route) => {
  void updatePermalinkSnapshot(route);
});

export const permalinkSnapshotStore: Readable<PermalinkSnapshotState> = {
  subscribe: permalinkSnapshotWritable.subscribe,
};

export function getPermalinkSnapshotSync(): PermalinkSnapshotState {
  return get(permalinkSnapshotWritable);
}

export function isSnapshotPermalinkSync(route: RouteInfo = getRouteSync()): boolean {
  return isSnapshotPermalinkRoute(route);
}
