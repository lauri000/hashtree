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
  opts: { host?: string; nhash?: string; npub?: string; treename?: string; path: string; query?: string },
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke<void>('create_htree_webview', {
    label,
    host: opts.host ?? null,
    nhash: opts.nhash ?? null,
    npub: opts.npub ?? null,
    treename: opts.treename ?? null,
    path: opts.path,
    query: opts.query ?? null,
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

export async function reloadWebview(label: string): Promise<void> {
  return invoke<void>('reload_webview', { label });
}

export async function setWebviewBounds(
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke<void>('set_webview_bounds', { label, x, y, width, height });
}

export async function webviewCurrentUrl(label: string): Promise<string> {
  return invoke<string>('webview_current_url', { label });
}

export async function startWindowDragging(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().startDragging();
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

export interface HistorySearchResult {
  entry: HistoryEntry;
  score: number;
}

export async function searchHistory(query: string, limit?: number): Promise<HistorySearchResult[]> {
  return invoke<HistorySearchResult[]>('search_history', { query, limit: limit ?? 10 });
}

export async function getRecentHistory(limit?: number): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>('get_recent_history', { limit: limit ?? 20 });
}

export async function deleteHistoryEntry(path: string): Promise<boolean> {
  return invoke<boolean>('delete_history_entry', { path });
}

export async function clearHistory(): Promise<void> {
  return invoke<void>('clear_history');
}

// ── Automation ──

export type AutomationAction =
  | 'open_url'
  | 'back'
  | 'forward'
  | 'reload'
  | 'home'
  | 'settings'
  | 'shutdown';

export interface AutomationCommandEvent {
  action: AutomationAction;
  url?: string | null;
}

export interface AutomationUiState {
  shellReady: boolean;
  currentView: string;
  currentUrl: string;
  addressValue: string;
  canGoBack: boolean;
  canGoForward: boolean;
  showDropdown: boolean;
  childWebviewReady: boolean;
  childPageLoadState: string;
  childPageLoadUrl: string;
  childDocumentTitle: string;
  childBodyText: string;
  childLastError: string;
  historyIndex: number;
  historyLength: number;
}

export interface AutomationState extends AutomationUiState {
  enabled: boolean;
  port: number | null;
}

export async function automationUpdateState(snapshot: AutomationUiState): Promise<void> {
  return invoke<void>('automation_update_state', { snapshot });
}

export async function automationGetState(): Promise<AutomationState> {
  return invoke<AutomationState>('automation_get_state');
}

export async function automationShutdown(): Promise<void> {
  return invoke<void>('automation_shutdown');
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
  source?: string;
}

export interface WebviewPageLoadEvent {
  label: string;
  url: string;
  event: string;
}

export interface WebviewDiagnosticEvent {
  label: string;
  url?: string | null;
  source?: string | null;
  title?: string | null;
  readyState?: string | null;
  bodyText?: string | null;
  error?: string | null;
}

export function onChildWebviewLocation(
  callback: (event: WebviewLocationEvent) => void,
): Promise<UnlistenFn> {
  return listen<WebviewLocationEvent>('child-webview-location', (event) => {
    callback(event.payload);
  });
}

export function onChildWebviewPageLoad(
  callback: (event: WebviewPageLoadEvent) => void,
): Promise<UnlistenFn> {
  return listen<WebviewPageLoadEvent>('child-webview-page-load', (event) => {
    callback(event.payload);
  });
}

export function onChildWebviewDiagnostic(
  callback: (event: WebviewDiagnosticEvent) => void,
): Promise<UnlistenFn> {
  return listen<WebviewDiagnosticEvent>('child-webview-diagnostic', (event) => {
    callback(event.payload);
  });
}

export function onAutomationCommand(
  callback: (event: AutomationCommandEvent) => void,
): Promise<UnlistenFn> {
  return listen<AutomationCommandEvent>('automation-command', (event) => {
    callback(event.payload);
  });
}
