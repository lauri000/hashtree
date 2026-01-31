/**
 * Tauri invoke wrappers for the iris shell.
 *
 * These wrap the Rust commands exposed in src-tauri/src/ for
 * webview management, history, autostart, and daemon URL.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ── Daemon URL ──

export async function getHtreeServerUrl(): Promise<string> {
  return invoke<string>('get_htree_server_url');
}

// ── Child webview management ──

export async function createNip07Webview(
  label: string,
  url: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke<void>('create_nip07_webview', { label, url, x, y, width, height });
}

export async function createHtreeWebview(
  label: string,
  opts: { nhash?: string; npub?: string; treename?: string; path: string },
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke<void>('create_htree_webview', {
    label,
    nhash: opts.nhash ?? null,
    npub: opts.npub ?? null,
    treename: opts.treename ?? null,
    path: opts.path,
    x,
    y,
    width,
    height,
  });
}

export async function closeWebview(label: string): Promise<void> {
  return invoke<void>('close_webview', { label });
}

export async function navigateWebview(label: string, url: string): Promise<void> {
  return invoke<void>('navigate_webview', { label, url });
}

export async function webviewHistory(label: string, direction: 'back' | 'forward'): Promise<void> {
  return invoke<void>('webview_history', { label, direction });
}

export async function webviewCurrentUrl(label: string): Promise<string> {
  return invoke<string>('webview_current_url', { label });
}

// ── History ──

export interface HistoryEntry {
  path: string;
  label: string;
  entry_type: string;
  npub?: string;
  tree_name?: string;
  visit_count: number;
  last_visited: number;
  first_visited: number;
}

export async function recordHistoryVisit(entry: {
  path: string;
  label: string;
  entry_type: string;
  npub?: string;
  tree_name?: string;
}): Promise<void> {
  return invoke<void>('record_history_visit', entry);
}

export async function searchHistory(query: string, limit?: number): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>('search_history', { query, limit: limit ?? 10 });
}

export async function getRecentHistory(limit?: number): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>('get_recent_history', { limit: limit ?? 20 });
}

// ── Autostart ──

export async function isAutostartEnabled(): Promise<boolean> {
  try {
    const { isEnabled } = await import('@tauri-apps/plugin-autostart');
    return await isEnabled();
  } catch {
    return false;
  }
}

export async function toggleAutostart(enabled: boolean): Promise<boolean> {
  try {
    if (enabled) {
      const { enable } = await import('@tauri-apps/plugin-autostart');
      await enable();
    } else {
      const { disable } = await import('@tauri-apps/plugin-autostart');
      await disable();
    }
    return true;
  } catch {
    return false;
  }
}

// ── Events ──

export interface WebviewLocationEvent {
  label: string;
  url: string;
}

export function onChildWebviewLocation(
  callback: (event: WebviewLocationEvent) => void,
): Promise<UnlistenFn> {
  return listen<WebviewLocationEvent>('child-webview-location', (event) => {
    callback(event.payload);
  });
}
