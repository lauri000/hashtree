//! NIP-07 webview support for child webviews
//!
//! Provides window.nostr capability for child webviews.
//! NIP-07 signing is proxied to the main webview's window.nostr
//! (which the web app provides via its own identity management).
#![cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]

use crate::permissions::{PermissionStore, PermissionType};
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response as AxumResponse;
use once_cell::sync::OnceCell;
use parking_lot::RwLock;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl};
use tauri::{LogicalPosition, LogicalSize, Rect, WebviewBuilder};
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri_plugin_iris_mobile_browser::{
    BrowserBoundsRequest, BrowserCreateRequest, MobileBrowserExt, ShellOverlayRequest,
};
use tracing::{debug, error, info, warn};

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
const MOBILE_CHILD_WEBVIEWS_UNSUPPORTED: &str = "Mobile child webviews are not supported yet";

// ============================================
// htree:// URL helpers for origin isolation
// ============================================

pub fn htree_origin_from_nhash(nhash: &str) -> String {
    htree_url_from_nhash(nhash, "/")
        .trim_end_matches('/')
        .to_string()
}

pub fn htree_origin_from_tree_host(host: &str, treename: &str) -> String {
    htree_url_from_tree_host(host, treename, "/")
        .trim_end_matches('/')
        .to_string()
}

fn decode_url_component(value: &str) -> String {
    percent_decode_str(value).decode_utf8_lossy().into_owned()
}

fn decode_path_segments(path: &str) -> Vec<String> {
    path.trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(decode_url_component)
        .collect()
}

fn htree_url_with_segments(host: &str, segments: &[String]) -> String {
    let mut url = tauri::Url::parse(&format!("htree://{}/", host)).expect("valid htree base URL");
    {
        let mut path_segments = url
            .path_segments_mut()
            .expect("htree URL should support path segments");
        path_segments.pop_if_empty();
        for segment in segments {
            path_segments.push(segment);
        }
    }

    if segments.is_empty() {
        url.as_str().trim_end_matches('/').to_string()
    } else {
        url.into()
    }
}

fn htree_url_from_nhash(nhash: &str, path: &str) -> String {
    let segments = decode_path_segments(path);
    htree_url_with_segments(nhash, &segments)
}

fn htree_url_from_tree_host(host: &str, treename: &str, path: &str) -> String {
    let mut segments = vec![decode_url_component(treename)];
    let path_segments = decode_path_segments(path);
    let is_tree_root = path_segments.is_empty();
    segments.extend(path_segments);
    let url = htree_url_with_segments(host, &segments);
    if is_tree_root {
        format!("{}/", url)
    } else {
        url
    }
}

fn http_url_with_segments(base: &str, segments: &[String]) -> Result<String, String> {
    let mut url = tauri::Url::parse(base).map_err(|e| format!("Invalid base URL: {}", e))?;
    {
        let mut path_segments = url
            .path_segments_mut()
            .map_err(|_| "Base URL does not support path segments".to_string())?;
        path_segments.pop_if_empty();
        for segment in segments {
            path_segments.push(segment);
        }
    }
    Ok(url.into())
}

fn isolated_loopback_scope_label(canonical_root: &str) -> String {
    let digest = hashtree_core::sha256(canonical_root.as_bytes());
    format!("tree-{}", hex::encode(&digest[..16]))
}

fn use_origin_isolated_loopback_hosts() -> bool {
    !cfg!(target_os = "linux")
}

fn loopback_server_url(
    server_url: &str,
    canonical_root: &str,
    use_origin_isolated_hosts: bool,
) -> Result<String, String> {
    let mut url = tauri::Url::parse(server_url).map_err(|e| format!("Invalid base URL: {}", e))?;
    if use_origin_isolated_hosts {
        let isolated_host = format!(
            "{}.htree.localhost",
            isolated_loopback_scope_label(canonical_root)
        );
        url.set_host(Some(&isolated_host))
            .map_err(|e| format!("Failed to set isolated host: {}", e))?;
    }
    Ok(url.into())
}

fn daemon_proxy_url_from_nhash(
    server_url: &str,
    nhash: &str,
    path: &str,
) -> Result<String, String> {
    let canonical_root = htree_origin_from_nhash(nhash);
    let loopback_server_url = loopback_server_url(
        server_url,
        &canonical_root,
        use_origin_isolated_loopback_hosts(),
    )?;
    let mut segments = vec!["htree".to_string(), decode_url_component(nhash)];
    let path_segments = decode_path_segments(path);
    let is_tree_root = path_segments.is_empty();
    segments.extend(path_segments);
    let url = http_url_with_segments(&loopback_server_url, &segments)?;
    if is_tree_root {
        Ok(format!("{}/", url.trim_end_matches('/')))
    } else {
        Ok(url)
    }
}

fn daemon_proxy_url_from_tree_host(
    server_url: &str,
    host: &str,
    treename: &str,
    path: &str,
) -> Result<String, String> {
    let canonical_root = htree_origin_from_tree_host(host, treename);
    let loopback_server_url = loopback_server_url(
        server_url,
        &canonical_root,
        use_origin_isolated_loopback_hosts(),
    )?;
    let mut segments = vec![
        "htree".to_string(),
        decode_url_component(host),
        decode_url_component(treename),
    ];
    let path_segments = decode_path_segments(path);
    let is_tree_root = path_segments.is_empty();
    segments.extend(path_segments);
    let url = http_url_with_segments(&loopback_server_url, &segments)?;
    if is_tree_root {
        Ok(format!("{}/", url.trim_end_matches('/')))
    } else {
        Ok(url)
    }
}

fn append_query(mut url: String, query: Option<&str>) -> String {
    if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
        url.push('?');
        url.push_str(query);
    }
    url
}

fn append_fragment(mut url: String, fragment: Option<&str>) -> String {
    if let Some(fragment) = fragment
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_start_matches('#'))
    {
        url.push('#');
        url.push_str(fragment);
    }
    url
}

fn append_query_params(url: &str, params: &[(&str, &str)]) -> Result<String, String> {
    let mut parsed = tauri::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    {
        let mut query_pairs = parsed.query_pairs_mut();
        for (key, value) in params {
            query_pairs.append_pair(key, value);
        }
    }
    Ok(parsed.into())
}

fn resolve_tree_request_host<'a>(
    request_host: &'a str,
    self_npub: Option<&'a str>,
) -> Result<&'a str, String> {
    if request_host == "self" {
        self_npub.ok_or_else(|| "self identity is not available".to_string())
    } else {
        Ok(request_host)
    }
}

fn webview_url_for_parsed_url(url: &tauri::Url) -> WebviewUrl {
    match url.scheme() {
        "http" | "https" => WebviewUrl::External(url.clone()),
        _ => WebviewUrl::CustomProtocol(url.clone()),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn url_origin(url: &tauri::Url) -> Option<String> {
    let scheme = url.scheme();
    let host = url.host_str()?;
    let port = url.port();

    Some(if let Some(port) = port {
        format!("{scheme}://{host}:{port}")
    } else {
        format!("{scheme}://{host}")
    })
}

fn inject_child_init_script<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    script: &str,
    context: &str,
) {
    let Some(webview) = app.get_webview(label) else {
        warn!(
            "[child-webview:{}] Missing webview while injecting bridge script during {}",
            label, context
        );
        return;
    };

    match webview.eval(script) {
        Ok(()) => {
            debug!(
                "[child-webview:{}] Injected bridge script during {}",
                label, context
            );
        }
        Err(error) => {
            warn!(
                "[child-webview:{}] Failed to inject bridge script during {}: {}",
                label, context, error
            );
        }
    }
}

fn schedule_child_init_script_retry<R: Runtime + 'static>(
    app: AppHandle<R>,
    label: String,
    script: String,
    delay: Duration,
    context: String,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        inject_child_init_script(&app, &label, &script, &context);
    });
}

fn tauri_response_to_axum(response: tauri::http::Response<Vec<u8>>) -> AxumResponse<Body> {
    let status = StatusCode::from_u16(response.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = AxumResponse::builder().status(status);
    for (name, value) in response.headers() {
        builder = builder.header(name, value);
    }
    builder
        .body(Body::from(response.into_body()))
        .unwrap_or_else(|_| AxumResponse::new(Body::from("bridge response build failed")))
}

// ============================================
// Global state
// ============================================

static GLOBAL_NIP07_STATE: OnceCell<Arc<Nip07State>> = OnceCell::new();

pub fn init_global_state(nip07: Arc<Nip07State>) {
    let _ = GLOBAL_NIP07_STATE.set(nip07);
}

pub fn get_nip07_state() -> Option<Arc<Nip07State>> {
    GLOBAL_NIP07_STATE.get().cloned()
}

// ============================================
// State types
// ============================================

pub struct Nip07State {
    pub permissions: Arc<PermissionStore>,
    session_tokens: RwLock<HashMap<String, String>>,
}

impl Nip07State {
    pub fn new(permissions: Arc<PermissionStore>) -> Self {
        Self {
            permissions,
            session_tokens: RwLock::new(HashMap::new()),
        }
    }

    pub fn new_session(&self, origin: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.session_tokens
            .write()
            .insert(origin.to_string(), token.clone());
        token
    }

    pub fn validate_token(&self, origin: &str, token: &str) -> bool {
        self.session_tokens
            .read()
            .get(origin)
            .map(|t| t == token)
            .unwrap_or(false)
    }
}

#[derive(Debug, Deserialize)]
pub struct Nip07Request {
    pub method: String,
    pub params: serde_json::Value,
    pub origin: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct Nip07Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================
// Script generation
// ============================================

/// Generate NIP-07 script for main window (uses Tauri invoke -> proxied to main webview's window.nostr)
pub fn generate_main_window_nip07_script() -> String {
    r#"
(function() {
  if (window.nostr) {
    console.log('[NIP-07] Already initialized');
    return;
  }

  console.log('[NIP-07] Initializing for main window via Tauri invoke');

  async function getInvoke() {
    if (window.__TAURI_INTERNALS__?.invoke) return window.__TAURI_INTERNALS__.invoke;
    if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke;
    if (window.__TAURI__?.invoke) return window.__TAURI__.invoke;

    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (window.__TAURI_INTERNALS__?.invoke) return window.__TAURI_INTERNALS__.invoke;
      if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke;
      if (window.__TAURI__?.invoke) return window.__TAURI__.invoke;
    }
    throw new Error('Tauri invoke not available after timeout');
  }

  async function callNip07(method, params) {
    console.log('[NIP-07] Calling:', method, params);
    try {
      const invoke = await getInvoke();
      const result = await invoke('nip07_request', {
        method,
        params: params || {},
        origin: 'tauri://localhost'
      });
      console.log('[NIP-07] Result:', result);
      if (result.error) {
        throw new Error(result.error);
      }
      return result.result;
    } catch (e) {
      console.error('[NIP-07] Error:', e);
      throw e;
    }
  }

  window.nostr = {
    async getPublicKey() {
      return callNip07('getPublicKey', {});
    },
    async signEvent(event) {
      return callNip07('signEvent', { event });
    },
    async getRelays() {
      return callNip07('getRelays', {});
    },
    nip04: {
      async encrypt(pubkey, plaintext) {
        return callNip07('nip04.encrypt', { pubkey, plaintext });
      },
      async decrypt(pubkey, ciphertext) {
        return callNip07('nip04.decrypt', { pubkey, ciphertext });
      }
    },
    nip44: {
      async encrypt(pubkey, plaintext) {
        return callNip07('nip44.encrypt', { pubkey, plaintext });
      },
      async decrypt(pubkey, ciphertext) {
        return callNip07('nip44.decrypt', { pubkey, ciphertext });
      }
    }
  };

  console.log('[NIP-07] window.nostr initialized for main window');
})();
"#
    .to_string()
}

/// Generate NIP-07 init script for child webviews (uses htree://nip07/ protocol)
pub fn generate_nip07_script(
    server_url: &str,
    session_token: &str,
    label: &str,
    canonical_origin: Option<&str>,
    canonical_url_root: Option<&str>,
    actual_url_root: Option<&str>,
) -> String {
    let canonical_origin_json = canonical_origin
        .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let canonical_url_root_json = canonical_url_root
        .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let actual_url_root_json = actual_url_root
        .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());

    format!(
        r#"
(function() {{
  if (window.__IRIS_CHILD_BRIDGE_INITIALIZED__) {{
    return;
  }}
  window.__IRIS_CHILD_BRIDGE_INITIALIZED__ = true;
  const hasNostr = !!window.nostr;
  const SERVER_URL = "{}";
  const SESSION_TOKEN = "{}";
  const WEBVIEW_LABEL = "{}";
  const CANONICAL_ORIGIN = {};
  const CANONICAL_URL_ROOT = {};
  const ACTUAL_URL_ROOT = {};
  const WEBVIEW_ENDPOINT = `${{SERVER_URL}}/__iris_webview`;
  const NIP07_ENDPOINT = `${{SERVER_URL}}/__iris_nip07`;
  console.log('[NIP-07] Initializing with server:', SERVER_URL);
  window.__HTREE_SERVER_URL__ = SERVER_URL;
  window.__HTREE_CANONICAL_URL__ = null;

  let invokePromise = null;
  let resolvedInvoke = null;
  let flushPromise = null;
  let flushTimer = null;
  const pendingWebviewEvents = [];
  async function getInvoke() {{
    if (resolvedInvoke) return resolvedInvoke;
    const getNow = () =>
      window.__TAURI_INTERNALS__?.invoke ||
      window.__TAURI__?.core?.invoke ||
      window.__TAURI__?.invoke ||
      null;
    const immediate = getNow();
    if (immediate) {{
      resolvedInvoke = immediate;
      return resolvedInvoke;
    }}
    if (!invokePromise) {{
      invokePromise = (async () => {{
        for (let i = 0; i < 20; i++) {{
          await new Promise((resolve) => setTimeout(resolve, 50));
          const candidate = getNow();
          if (candidate) {{
            resolvedInvoke = candidate;
            return candidate;
          }}
        }}
        return null;
      }})().finally(() => {{
        if (!resolvedInvoke) {{
          invokePromise = null;
        }}
      }});
    }}
    return invokePromise;
  }}

  function scheduleWebviewEventFlush() {{
    if (flushTimer) return;
    flushTimer = setTimeout(() => {{
      flushTimer = null;
      flushPendingWebviewEvents().catch((error) => {{
        console.warn('[WebviewBridge] Delayed flush failed', error);
      }});
    }}, 250);
  }}

  async function flushPendingWebviewEvents() {{
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {{
      const invoke = await getInvoke();
      while (pendingWebviewEvents.length > 0) {{
        const payload = pendingWebviewEvents[0];
        try {{
          if (invoke) {{
            await invoke('webview_event', {{
              payload,
              session_token: SESSION_TOKEN
            }});
          }} else {{
            const response = await fetch(WEBVIEW_ENDPOINT, {{
              method: 'POST',
              headers: {{
                'Content-Type': 'text/plain;charset=UTF-8'
              }},
              body: JSON.stringify({{
                sessionToken: SESSION_TOKEN,
                payload
              }})
            }});
            if (!response.ok) {{
              throw new Error(`Protocol bridge request failed: ${{response.status}}`);
            }}
          }}
          pendingWebviewEvents.shift();
        }} catch (error) {{
          if (invoke) {{
            resolvedInvoke = null;
            invokePromise = null;
          }}
          console.warn('[WebviewBridge] Failed to flush event', error);
          scheduleWebviewEventFlush();
          return false;
        }}
      }}
      return true;
    }})();
    try {{
      return await flushPromise;
    }} finally {{
      flushPromise = null;
    }}
  }}

  function stripInternalHtreeQueryParams(url) {{
    try {{
      const parsed = new URL(url);
      parsed.searchParams.delete('iris_htree_server');
      parsed.searchParams.delete('iris_htree_canonical');
      return parsed.toString();
    }} catch (_error) {{
      return url;
    }}
  }}

  function canonicalizeUrl(url) {{
    let mappedUrl = url;
    if (
      typeof url === 'string' &&
      typeof CANONICAL_URL_ROOT === 'string' &&
      typeof ACTUAL_URL_ROOT === 'string' &&
      url.startsWith(ACTUAL_URL_ROOT)
    ) {{
      mappedUrl = `${{CANONICAL_URL_ROOT}}${{url.slice(ACTUAL_URL_ROOT.length)}}`;
    }}
    return stripInternalHtreeQueryParams(mappedUrl);
  }}

  function updateCanonicalLocation() {{
    const canonicalUrl = canonicalizeUrl(window.location.href);
    if (typeof canonicalUrl === 'string') {{
      window.__HTREE_CANONICAL_URL__ = canonicalUrl;
    }}
    return canonicalUrl;
  }}

  function getOrigin() {{
    if (typeof CANONICAL_ORIGIN === 'string' && CANONICAL_ORIGIN) {{
      return CANONICAL_ORIGIN;
    }}
    const origin = window.location.origin;
    if (origin && origin !== 'null') return origin;
    const protocol = window.location.protocol || '';
    const normalizedProtocol = protocol.endsWith(':') ? protocol.slice(0, -1) : protocol;
    const host = window.location.host || '';
    if (host) return `${{normalizedProtocol}}://${{host}}`;
    return normalizedProtocol || 'null';
  }}

  async function postWebviewEvent(payload) {{
    pendingWebviewEvents.push(payload);
    try {{
      const sent = await flushPendingWebviewEvents();
      if (!sent) {{
        scheduleWebviewEventFlush();
      }}
    }} catch (error) {{
      console.warn('[WebviewBridge] Failed to queue event', error);
      scheduleWebviewEventFlush();
    }}
  }}

  let lastLocation = null;
  function notifyLocation(source) {{
    const url = updateCanonicalLocation();
    if (url === lastLocation) return;
    lastLocation = url;
    postWebviewEvent({{
      kind: 'location',
      label: WEBVIEW_LABEL,
      origin: getOrigin(),
      url,
      source
    }});
  }}

  function getBodyTextPreview() {{
    try {{
      const text = document.body?.innerText || '';
      return text.replace(/\s+/g, ' ').trim().slice(0, 240);
    }} catch (_error) {{
      return '';
    }}
  }}

  function formatDebugValue(value) {{
    if (value instanceof Error) {{
      return value.stack || `${{value.name}}: ${{value.message}}`;
    }}
    if (typeof value === 'string') {{
      return value;
    }}
    try {{
      return JSON.stringify(value);
    }} catch (_error) {{
      return String(value);
    }}
  }}

  function getDebugSummary() {{
    try {{
      const entries = Array.isArray(window.__HTREE_DEBUG_LOG__) ? window.__HTREE_DEBUG_LOG__ : [];
      const relevant = entries.filter((entry) => {{
        const event = entry?.event;
        return event === 'window:error' ||
          event === 'window:unhandledrejection' ||
          event === 'console:error';
      }});
      if (relevant.length === 0) return '';
      const tail = relevant.slice(-3).map((entry) => {{
        const event = typeof entry?.event === 'string' ? entry.event : 'debug';
        const data = entry?.data;
        if (data?.message) return `${{event}} ${{data.message}}`;
        if (Array.isArray(data?.args) && data.args.length > 0) {{
          return `${{event}} ${{data.args.join(' ')}}`;
        }}
        if (data?.reason) return `${{event}} ${{data.reason}}`;
        return event;
      }});
      return tail.join(' | ').slice(0, 240);
    }} catch (_error) {{
      return '';
    }}
  }}

  function getMediaSummary() {{
    try {{
      const images = Array.from(document.images || []);
      const thumbImages = images.filter((img) => (img.currentSrc || img.src || '').includes('/thumbnail'));
      const loadedThumbImages = thumbImages.filter((img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
      const visibleLoadedThumbImages = loadedThumbImages.filter((img) => {{
        const style = window.getComputedStyle(img);
        const rect = img.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 20 &&
          rect.height > 20;
      }});
      const videos = Array.from(document.querySelectorAll('video'));
      const readyVideos = videos.filter((video) => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
      const appChildren = document.getElementById('app')?.childElementCount ?? 0;
      const smokeEnabled = new URLSearchParams(window.location.search).get('smoke') === '1' ? 1 : 0;
      return `thumbs=${{loadedThumbImages.length}}/${{thumbImages.length}} visible=${{visibleLoadedThumbImages.length}} videos=${{readyVideos.length}}/${{videos.length}} app=${{appChildren}} smoke=${{smokeEnabled}}`;
    }} catch (_error) {{
      return '';
    }}
  }}

  function notifyDiagnostic(phase, errorMessage) {{
    const debugSummary = getDebugSummary();
    postWebviewEvent({{
      kind: 'diagnostic',
      label: WEBVIEW_LABEL,
      origin: getOrigin(),
      url: updateCanonicalLocation(),
      source: phase,
      title: document.title || '',
      readyState: document.readyState || '',
      bodyText: getBodyTextPreview(),
      mediaSummary: getMediaSummary(),
      error: errorMessage || debugSummary || null
    }});
  }}

  let diagnosticTimer = null;
  function queueDiagnostic(phase, errorMessage) {{
    if (diagnosticTimer) clearTimeout(diagnosticTimer);
    diagnosticTimer = setTimeout(() => {{
      diagnosticTimer = null;
      notifyDiagnostic(phase, errorMessage);
    }}, 75);
  }}

  const originalPushState = history.pushState;
  history.pushState = function(state, title, url) {{
    const result = originalPushState.apply(this, arguments);
    notifyLocation('pushState');
    return result;
  }};

  const originalReplaceState = history.replaceState;
  history.replaceState = function(state, title, url) {{
    const result = originalReplaceState.apply(this, arguments);
    notifyLocation('replaceState');
    return result;
  }};

  window.addEventListener('popstate', () => notifyLocation('popstate'));
  window.addEventListener('hashchange', () => notifyLocation('hashchange'));
  window.addEventListener('DOMContentLoaded', () => {{
    notifyLocation('domcontentloaded');
    notifyDiagnostic('domcontentloaded');
    if (document.body) {{
      const observer = new MutationObserver(() => queueDiagnostic('mutation'));
      observer.observe(document.body, {{
        childList: true,
        subtree: true,
        characterData: true
      }});
    }}
  }});
  window.addEventListener('load', () => {{
    notifyLocation('load');
    notifyDiagnostic('load');
    setTimeout(() => notifyDiagnostic('post-load'), 250);
    setTimeout(() => notifyDiagnostic('post-load-late'), 1500);
  }});
  document.addEventListener('load', (event) => {{
    if (event.target instanceof HTMLImageElement || event.target instanceof HTMLVideoElement) {{
      queueDiagnostic('resource-load');
    }}
  }}, true);
  document.addEventListener('error', (event) => {{
    if (
      event.target instanceof HTMLImageElement ||
      event.target instanceof HTMLVideoElement ||
      event.target instanceof HTMLScriptElement ||
      event.target instanceof HTMLLinkElement
    ) {{
      const targetUrl = event.target instanceof HTMLImageElement || event.target instanceof HTMLVideoElement
        ? (event.target.currentSrc || event.target.src || '')
        : event.target instanceof HTMLScriptElement
          ? (event.target.src || '')
          : (event.target.href || '');
      const suffix = targetUrl ? `: ${{targetUrl}}` : '';
      queueDiagnostic('resource-error', `${{event.target.tagName.toLowerCase()}} failed to load${{suffix}}`);
    }}
  }}, true);
  document.addEventListener('loadeddata', (event) => {{
    if (event.target instanceof HTMLVideoElement) {{
      queueDiagnostic('video-loadeddata');
    }}
  }}, true);
  window.addEventListener('error', (event) => {{
    const filename = event.filename || '';
    const line = event.lineno || 0;
    const column = event.colno || 0;
    const location = filename ? ` @ ${{filename}}:${{line}}:${{column}}` : '';
    notifyDiagnostic('error', `${{event.message || 'Script error'}}${{location}}`);
  }});
  window.addEventListener('unhandledrejection', (event) => {{
    const reason = event.reason;
    const message = reason instanceof Error
      ? (reason.stack || reason.message)
      : typeof reason === 'string'
        ? reason
        : JSON.stringify(reason);
    notifyDiagnostic('unhandledrejection', message);
  }});
  const originalConsoleError = console.error?.bind(console);
  if (originalConsoleError) {{
    console.error = (...args) => {{
      queueDiagnostic('console-error', args.map(formatDebugValue).join(' ').slice(0, 240));
      originalConsoleError(...args);
    }};
  }}
  queueMicrotask(() => {{
    updateCanonicalLocation();
    notifyLocation('init');
    notifyDiagnostic('init');
  }});

  async function callNip07(method, params) {{
    console.log('[NIP-07] Calling:', method, params);
    try {{
      const response = await fetch(NIP07_ENDPOINT, {{
        method: 'POST',
        headers: {{ 'Content-Type': 'text/plain;charset=UTF-8' }},
        body: JSON.stringify({{ method, params, origin: getOrigin() }})
      }});
      if (!response.ok) {{
        throw new Error(`NIP-07 request failed: ${{response.status}}`);
      }}
      const result = await response.json();
      if (result.error) throw new Error(result.error);
      return result.result;
    }} catch (e) {{
      console.error('[NIP-07] Error:', e);
      throw e;
    }}
  }}

  if (!hasNostr) {{
    window.nostr = {{
      async getPublicKey() {{ return callNip07('getPublicKey', {{}}); }},
      async signEvent(event) {{ return callNip07('signEvent', {{ event }}); }},
      async getRelays() {{ return callNip07('getRelays', {{}}); }},
      nip04: {{
        async encrypt(pubkey, plaintext) {{ return callNip07('nip04.encrypt', {{ pubkey, plaintext }}); }},
        async decrypt(pubkey, ciphertext) {{ return callNip07('nip04.decrypt', {{ pubkey, ciphertext }}); }}
      }},
      nip44: {{
        async encrypt(pubkey, plaintext) {{ return callNip07('nip44.encrypt', {{ pubkey, plaintext }}); }},
        async decrypt(pubkey, ciphertext) {{ return callNip07('nip44.decrypt', {{ pubkey, ciphertext }}); }}
      }}
    }};
    console.log('[NIP-07] window.nostr initialized');
  }}
}})();
"#,
        server_url,
        session_token,
        label,
        canonical_origin_json,
        canonical_url_root_json,
        actual_url_root_json
    )
}

fn body_text_preview_js() -> &'static str {
    r#"
function getBodyTextPreview() {
  try {
    const text = document.body?.innerText || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 240);
  } catch (_error) {
    return '';
  }
}
"#
}

fn media_summary_js() -> &'static str {
    r#"
function getMediaSummary() {
  try {
    const images = Array.from(document.images || []);
    const thumbImages = images.filter((img) => (img.currentSrc || img.src || '').includes('/thumbnail'));
    const loadedThumbImages = thumbImages.filter((img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
    const visibleLoadedThumbImages = loadedThumbImages.filter((img) => {
      const style = window.getComputedStyle(img);
      const rect = img.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 20 &&
        rect.height > 20;
    });
    const videos = Array.from(document.querySelectorAll('video'));
    const readyVideos = videos.filter((video) => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
    const appChildren = document.getElementById('app')?.childElementCount ?? 0;
    const smokeEnabled = new URLSearchParams(window.location.search).get('smoke') === '1' ? 1 : 0;
    return `thumbs=${loadedThumbImages.length}/${thumbImages.length} visible=${visibleLoadedThumbImages.length} videos=${readyVideos.length}/${videos.length} app=${appChildren} smoke=${smokeEnabled}`;
  } catch (_error) {
    return '';
  }
}
"#
}

pub fn generate_webview_diagnostic_probe_script(
    server_url: &str,
    session_token: &str,
    label: &str,
    origin: &str,
    canonical_url_root: Option<&str>,
    actual_url_root: Option<&str>,
    source: &str,
) -> String {
    let webview_endpoint_json = serde_json::to_string(&format!("{server_url}/__iris_webview"))
        .unwrap_or_else(|_| "\"\"".to_string());
    let session_token_json =
        serde_json::to_string(session_token).unwrap_or_else(|_| "\"\"".to_string());
    let label_json = serde_json::to_string(label).unwrap_or_else(|_| "\"\"".to_string());
    let origin_json = serde_json::to_string(origin).unwrap_or_else(|_| "\"\"".to_string());
    let source_json = serde_json::to_string(source).unwrap_or_else(|_| "\"\"".to_string());
    let canonical_url_root_json = canonical_url_root
        .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());
    let actual_url_root_json = actual_url_root
        .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()))
        .unwrap_or_else(|| "null".to_string());

    format!(
        r#"
(() => {{
  const WEBVIEW_ENDPOINT = {webview_endpoint_json};
  const SESSION_TOKEN = {session_token_json};
  const LABEL = {label_json};
  const ORIGIN = {origin_json};
  const SOURCE = {source_json};
  const CANONICAL_URL_ROOT = {canonical_url_root_json};
  const ACTUAL_URL_ROOT = {actual_url_root_json};

  function stripInternalHtreeQueryParams(url) {{
    try {{
      const parsed = new URL(url);
      parsed.searchParams.delete('iris_htree_server');
      parsed.searchParams.delete('iris_htree_canonical');
      return parsed.toString();
    }} catch (_error) {{
      return url;
    }}
  }}

  function canonicalizeUrl(url) {{
    let mappedUrl = url;
    if (
      typeof url === 'string' &&
      typeof CANONICAL_URL_ROOT === 'string' &&
      typeof ACTUAL_URL_ROOT === 'string' &&
      url.startsWith(ACTUAL_URL_ROOT)
    ) {{
      mappedUrl = `${{CANONICAL_URL_ROOT}}${{url.slice(ACTUAL_URL_ROOT.length)}}`;
    }}
    return stripInternalHtreeQueryParams(mappedUrl);
  }}

  {body_text_preview}
  function getDebugSummary() {{
    try {{
      const entries = Array.isArray(window.__HTREE_DEBUG_LOG__) ? window.__HTREE_DEBUG_LOG__ : [];
      const relevant = entries.filter((entry) => {{
        const event = entry?.event;
        return event === 'window:error' ||
          event === 'window:unhandledrejection' ||
          event === 'console:error';
      }});
      if (relevant.length === 0) return '';
      const tail = relevant.slice(-3).map((entry) => {{
        const event = typeof entry?.event === 'string' ? entry.event : 'debug';
        const data = entry?.data;
        if (data?.message) return `${{event}} ${{data.message}}`;
        if (Array.isArray(data?.args) && data.args.length > 0) {{
          return `${{event}} ${{data.args.join(' ')}}`;
        }}
        if (data?.reason) return `${{event}} ${{data.reason}}`;
        return event;
      }});
      return tail.join(' | ').slice(0, 240);
    }} catch (_error) {{
      return '';
    }}
  }}
  {media_summary}

  const payload = {{
    kind: 'diagnostic',
    label: LABEL,
    origin: ORIGIN,
    url: canonicalizeUrl(window.location.href),
    source: SOURCE,
    title: document.title || '',
    readyState: document.readyState || '',
    bodyText: getBodyTextPreview(),
    mediaSummary: getMediaSummary(),
    error: getDebugSummary() || null
  }};

  fetch(WEBVIEW_ENDPOINT, {{
    method: 'POST',
    headers: {{ 'Content-Type': 'text/plain;charset=UTF-8' }},
    body: JSON.stringify({{ sessionToken: SESSION_TOKEN, payload }})
  }}).catch((error) => {{
    console.warn('[WebviewProbe] Failed to send diagnostic', error);
  }});
}})();
"#,
        body_text_preview = body_text_preview_js(),
        media_summary = media_summary_js()
    )
}

// ============================================
// NIP-07 request handler (proxies to main webview)
// ============================================

/// Handle NIP-07 request - for now returns "not implemented" for signing
/// (the plan says signing is proxied to main webview's window.nostr)
pub async fn handle_nip07_request_inner(
    permissions: Option<&PermissionStore>,
    method: &str,
    _params: &serde_json::Value,
    origin: &str,
) -> Nip07Response {
    debug!("[NIP-07] Request: {} from {}", method, origin);

    match method {
        "getPublicKey" => {
            if let Some(perms) = permissions {
                if !perms
                    .is_granted(origin, &PermissionType::GetPublicKey)
                    .await
                    .unwrap_or(true)
                {
                    return Nip07Response {
                        result: None,
                        error: Some("Permission denied".to_string()),
                    };
                }
            }

            // In the thin native shell, signing keys are managed by the web app.
            // The web app's window.nostr provides the pubkey.
            // For now, return an error until the main webview proxy is wired up.
            Nip07Response {
                result: None,
                error: Some("NIP-07 signing is handled by the web app's identity".to_string()),
            }
        }

        "signEvent" => {
            if let Some(perms) = permissions {
                if !perms
                    .is_granted(origin, &PermissionType::SignEvent)
                    .await
                    .unwrap_or(false)
                {
                    return Nip07Response {
                        result: None,
                        error: Some("Permission denied".to_string()),
                    };
                }
            }

            Nip07Response {
                result: None,
                error: Some("NIP-07 signing is handled by the web app's identity".to_string()),
            }
        }

        "getRelays" => Nip07Response {
            result: Some(serde_json::json!({})),
            error: None,
        },

        "nip04.encrypt" | "nip04.decrypt" | "nip44.encrypt" | "nip44.decrypt" => Nip07Response {
            result: None,
            error: Some("Not implemented".to_string()),
        },

        _ => Nip07Response {
            result: None,
            error: Some(format!("Unknown method: {}", method)),
        },
    }
}

/// Handle NIP-07 requests via htree://nip07/ protocol
pub fn handle_nip07_protocol_request(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let body = request.body();
    info!("[htree://nip07] Request: {} bytes", body.len());

    let nip07_request: Nip07Request = match serde_json::from_slice(body) {
        Ok(req) => req,
        Err(e) => {
            error!("[htree://nip07] Failed to parse request body: {}", e);
            let response = Nip07Response {
                result: None,
                error: Some(format!("Invalid request: {}", e)),
            };
            return tauri::http::Response::builder()
                .status(400)
                .header("content-type", "application/json")
                .header("access-control-allow-origin", "*")
                .body(serde_json::to_vec(&response).unwrap_or_default())
                .unwrap();
        }
    };

    let nip07_state = get_nip07_state();
    let permissions = nip07_state.as_ref().map(|s| &*s.permissions);

    let response = tauri::async_runtime::block_on(async {
        handle_nip07_request_inner(
            permissions,
            &nip07_request.method,
            &nip07_request.params,
            &nip07_request.origin,
        )
        .await
    });

    tauri::http::Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(serde_json::to_vec(&response).unwrap_or_default())
        .unwrap()
}

pub fn handle_webview_event_protocol_request<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let header_session_token = request
        .headers()
        .get("x-session-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    let (session_token, payload) = match header_session_token {
        Some(session_token) => match serde_json::from_slice(request.body()) {
            Ok(payload) => (session_token, payload),
            Err(error) => {
                warn!("[webview-event:http] Invalid payload: {}", error);
                return tauri::http::Response::builder()
                    .status(400)
                    .header("content-type", "text/plain")
                    .body(format!("Invalid webview event payload: {}", error).into_bytes())
                    .unwrap();
            }
        },
        None => match serde_json::from_slice::<WebviewEventHttpEnvelope>(request.body()) {
            Ok(envelope) if !envelope.session_token.trim().is_empty() => {
                (envelope.session_token, envelope.payload)
            }
            Ok(_) => {
                return tauri::http::Response::builder()
                    .status(401)
                    .header("content-type", "text/plain")
                    .body(b"Missing session token".to_vec())
                    .unwrap();
            }
            Err(error) => {
                warn!("[webview-event:http] Invalid payload envelope: {}", error);
                return tauri::http::Response::builder()
                    .status(400)
                    .header("content-type", "text/plain")
                    .body(format!("Invalid webview event payload: {}", error).into_bytes())
                    .unwrap();
            }
        },
    };

    debug!(
        "[webview-event:http] Received kind={} label={} origin={} url={:?}",
        payload.kind, payload.label, payload.origin, payload.url
    );

    match webview_event(app, payload, session_token) {
        Ok(()) => tauri::http::Response::builder()
            .status(204)
            .header("access-control-allow-origin", "*")
            .body(Vec::new())
            .unwrap(),
        Err(error) => {
            warn!("[webview-event:http] Rejected event: {}", error);
            tauri::http::Response::builder()
                .status(403)
                .header("content-type", "text/plain")
                .header("access-control-allow-origin", "*")
                .body(error.into_bytes())
                .unwrap()
        }
    }
}

pub async fn handle_nip07_http_bridge(body: Bytes) -> AxumResponse<Body> {
    let request = tauri::http::Request::builder()
        .uri("http://127.0.0.1/__iris_nip07")
        .body(body.to_vec())
        .unwrap_or_else(|_| tauri::http::Request::new(Vec::new()));
    tauri_response_to_axum(handle_nip07_protocol_request(request))
}

pub async fn handle_webview_event_http_bridge<R: Runtime>(
    app: AppHandle<R>,
    headers: HeaderMap,
    body: Bytes,
) -> AxumResponse<Body> {
    let mut builder = tauri::http::Request::builder().uri("http://127.0.0.1/__iris_webview");
    if let Some(session_token) = headers.get("x-session-token") {
        builder = builder.header("x-session-token", session_token);
    }
    let request = builder
        .body(body.to_vec())
        .unwrap_or_else(|_| tauri::http::Request::new(Vec::new()));
    tauri_response_to_axum(handle_webview_event_protocol_request(app, request))
}

// ============================================
// Tauri commands
// ============================================

#[tauri::command]
pub async fn nip07_request<R: Runtime>(
    app: AppHandle<R>,
    method: String,
    params: serde_json::Value,
    origin: String,
) -> Nip07Response {
    let nip07_state = app.try_state::<Arc<Nip07State>>();
    let permissions = nip07_state.as_ref().map(|s| &*s.permissions);

    handle_nip07_request_inner(permissions, &method, &params, &origin).await
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[tauri::command]
pub async fn create_nip07_webview<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    _scale: Option<f64>,
) -> Result<(), String> {
    info!("[NIP-07] Creating webview {} for {}", label, url);

    let server_url =
        crate::htree_protocol::get_htree_server_url().ok_or("htree server not running")?;

    let parsed_url = tauri::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    let origin = if let Some(host) = parsed_url.host_str() {
        if let Some(port) = parsed_url.port() {
            format!("{}://{}:{}", parsed_url.scheme(), host, port)
        } else {
            format!("{}://{}", parsed_url.scheme(), host)
        }
    } else {
        parsed_url.scheme().to_string()
    };

    let nip07_state = app
        .try_state::<Arc<Nip07State>>()
        .ok_or("Nip07State not found")?;
    let session_token = nip07_state.new_session(&origin);

    let init_script = generate_nip07_script(&server_url, &session_token, &label, None, None, None);
    let diagnostic_probe_script = generate_webview_diagnostic_probe_script(
        &server_url,
        &session_token,
        &label,
        &origin,
        None,
        None,
        "page-load-probe",
    );

    let window = app.get_window("main").ok_or("Main window not found")?;

    let mut navigate_after_create: Option<tauri::Url> = None;
    let webview_url = if url.starts_with("tauri://localhost/") {
        let mut path = parsed_url.path().trim_start_matches('/').to_string();
        if path.is_empty() {
            path = "index.html".to_string();
        }
        if parsed_url.fragment().is_some() || parsed_url.query().is_some() {
            navigate_after_create = Some(parsed_url.clone());
        }
        WebviewUrl::App(path.into())
    } else {
        webview_url_for_parsed_url(&parsed_url)
    };

    let app_for_nav = app.clone();
    let label_for_nav = label.clone();
    let app_for_load = app.clone();
    let label_for_load = label.clone();
    let init_script_for_load = init_script.clone();
    let diagnostic_probe_script_for_load = diagnostic_probe_script.clone();

    let webview_builder = WebviewBuilder::new(&label, webview_url)
        .initialization_script(&init_script)
        .auto_resize()
        .background_color(tauri::utils::config::Color(15, 15, 15, 255))
        .on_navigation(move |nav_url| {
            let url_str = nav_url.to_string();
            debug!("[NIP-07] Child webview navigating to: {}", url_str);
            let _ = app_for_nav.emit(
                "child-webview-location",
                serde_json::json!({
                    "label": label_for_nav,
                    "url": url_str,
                    "source": "navigation"
                }),
            );
            true
        })
        .on_page_load(move |_webview, payload| {
            let event = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "started",
                tauri::webview::PageLoadEvent::Finished => "finished",
            };
            let context = format!("page-load:{event}");
            inject_child_init_script(
                &app_for_load,
                &label_for_load,
                &init_script_for_load,
                &context,
            );
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                inject_child_init_script(
                    &app_for_load,
                    &label_for_load,
                    &diagnostic_probe_script_for_load,
                    "page-load:finished-diagnostic-probe",
                );
                schedule_child_init_script_retry(
                    app_for_load.clone(),
                    label_for_load.clone(),
                    init_script_for_load.clone(),
                    Duration::from_millis(150),
                    "page-load:finished-retry-150ms".to_string(),
                );
                schedule_child_init_script_retry(
                    app_for_load.clone(),
                    label_for_load.clone(),
                    init_script_for_load.clone(),
                    Duration::from_millis(1000),
                    "page-load:finished-retry-1000ms".to_string(),
                );
                schedule_child_init_script_retry(
                    app_for_load.clone(),
                    label_for_load.clone(),
                    diagnostic_probe_script_for_load.clone(),
                    Duration::from_millis(150),
                    "page-load:finished-diagnostic-probe-150ms".to_string(),
                );
                schedule_child_init_script_retry(
                    app_for_load.clone(),
                    label_for_load.clone(),
                    diagnostic_probe_script_for_load.clone(),
                    Duration::from_millis(1000),
                    "page-load:finished-diagnostic-probe-1000ms".to_string(),
                );
            }
            let _ = app_for_load.emit(
                "child-webview-page-load",
                serde_json::json!({
                    "label": label_for_load,
                    "url": payload.url().to_string(),
                    "event": event
                }),
            );
        });

    let webview = window
        .add_child(
            webview_builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create webview: {}", e))?;

    if let Some(target_url) = navigate_after_create {
        if let Err(e) = webview.navigate(target_url) {
            warn!("[NIP-07] Failed to set initial URL: {}", e);
        }
    }

    info!("[NIP-07] Webview created with session token for {}", origin);
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[tauri::command]
pub async fn create_nip07_webview<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<(), String> {
    let server_url =
        crate::htree_protocol::get_htree_server_url().ok_or("htree server not running")?;

    let parsed_url = tauri::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    let origin = url_origin(&parsed_url).unwrap_or_else(|| parsed_url.scheme().to_string());
    let allowed_origin_rule = url_origin(&parsed_url);

    let nip07_state = app
        .try_state::<Arc<Nip07State>>()
        .ok_or("Nip07State not found")?;
    let session_token = nip07_state.new_session(&origin);

    let init_script = generate_nip07_script(&server_url, &session_token, &label, None, None, None);
    let diagnostic_probe_script = generate_webview_diagnostic_probe_script(
        &server_url,
        &session_token,
        &label,
        &origin,
        None,
        None,
        "page-load-probe",
    );

    app.mobile_browser().create(BrowserCreateRequest {
        label,
        url,
        x,
        y,
        width,
        height,
        scale,
        init_script,
        diagnostic_script: diagnostic_probe_script,
        allowed_origin_rule,
        actual_url_root: None,
        canonical_url_root: None,
    })
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[tauri::command]
pub async fn create_htree_webview<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    host: Option<String>,
    nhash: Option<String>,
    npub: Option<String>,
    treename: Option<String>,
    path: String,
    query: Option<String>,
    fragment: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    _scale: Option<f64>,
) -> Result<(), String> {
    let server_url =
        crate::htree_protocol::get_htree_server_url().ok_or("htree server not running")?;

    // The child webview keeps a canonical htree:// identity for permissions and
    // diagnostics, but it loads over a per-root loopback host so the browser's
    // own origin model isolates storage, service workers, and other origin-
    // scoped state between different trees and nhashes.
    let (canonical_url, actual_url, origin, canonical_url_root, actual_url_root) =
        if let Some(nhash) = &nhash {
            let request_host = host.as_deref().unwrap_or(nhash);
            let (canonical_url, canonical_root) = if let Some(treename) = &treename {
                let resolved_host = resolve_tree_request_host(
                    request_host,
                    crate::htree_protocol::get_self_npub(),
                )?;
                (
                    append_fragment(
                        append_query(
                            htree_url_from_tree_host(resolved_host, treename, &path),
                            query.as_deref(),
                        ),
                        fragment.as_deref(),
                    ),
                    htree_url_from_tree_host(resolved_host, treename, "/")
                        .trim_end_matches('/')
                        .to_string(),
                )
            } else {
                (
                    append_fragment(
                        append_query(htree_url_from_nhash(request_host, &path), query.as_deref()),
                        fragment.as_deref(),
                    ),
                    htree_url_from_nhash(request_host, "/")
                        .trim_end_matches('/')
                        .to_string(),
                )
            };
            let actual_url = append_query(
                daemon_proxy_url_from_nhash(&server_url, nhash, &path)?,
                query.as_deref(),
            );
            let actual_url = append_query_params(
                &actual_url,
                &[
                    ("iris_htree_server", &server_url),
                    ("iris_htree_canonical", &canonical_url),
                ],
            )?;
            let actual_url = append_fragment(actual_url, fragment.as_deref());
            let actual_root = daemon_proxy_url_from_nhash(&server_url, nhash, "/")?
                .trim_end_matches('/')
                .to_string();
            let origin = canonical_root.clone();
            (
                canonical_url,
                actual_url,
                origin,
                canonical_root,
                actual_root,
            )
        } else if let Some(treename) = &treename {
            let request_host = host
                .as_deref()
                .or(npub.as_deref())
                .ok_or_else(|| "Either nhash or (host + treename) must be provided".to_string())?;
            let resolved_host =
                resolve_tree_request_host(request_host, crate::htree_protocol::get_self_npub())?;
            let canonical_url = append_fragment(
                append_query(
                    htree_url_from_tree_host(resolved_host, treename, &path),
                    query.as_deref(),
                ),
                fragment.as_deref(),
            );
            let canonical_root = htree_url_from_tree_host(resolved_host, treename, "/")
                .trim_end_matches('/')
                .to_string();
            let actual_url = append_query(
                daemon_proxy_url_from_tree_host(&server_url, resolved_host, treename, &path)?,
                query.as_deref(),
            );
            let actual_url = append_query_params(
                &actual_url,
                &[
                    ("iris_htree_server", &server_url),
                    ("iris_htree_canonical", &canonical_url),
                ],
            )?;
            let actual_url = append_fragment(actual_url, fragment.as_deref());
            let actual_root =
                daemon_proxy_url_from_tree_host(&server_url, resolved_host, treename, "/")?
                    .trim_end_matches('/')
                    .to_string();
            let origin = canonical_root.clone();
            (
                canonical_url,
                actual_url,
                origin,
                canonical_root,
                actual_root,
            )
        } else {
            return Err("Either nhash or (host + treename) must be provided".to_string());
        };

    info!(
        "[htree] Creating webview {} for {} (origin: {})",
        label, canonical_url, origin
    );

    let nip07_state = app
        .try_state::<Arc<Nip07State>>()
        .ok_or("Nip07State not found")?;
    let session_token = nip07_state.new_session(&origin);

    let init_script = generate_nip07_script(
        &server_url,
        &session_token,
        &label,
        Some(&origin),
        Some(&canonical_url_root),
        Some(&actual_url_root),
    );
    let diagnostic_probe_script = generate_webview_diagnostic_probe_script(
        &server_url,
        &session_token,
        &label,
        &origin,
        Some(&canonical_url_root),
        Some(&actual_url_root),
        "page-load-probe",
    );

    let window = app.get_window("main").ok_or("Main window not found")?;
    let parsed_url = tauri::Url::parse(&actual_url).map_err(|e| format!("Invalid URL: {}", e))?;

    let app_for_nav = app.clone();
    let label_for_nav = label.clone();
    let app_for_load = app.clone();
    let label_for_load = label.clone();
    let init_script_for_load = init_script.clone();
    let diagnostic_probe_script_for_load = diagnostic_probe_script.clone();

    let canonical_url_root_for_nav = canonical_url_root.clone();
    let actual_url_root_for_nav = actual_url_root.clone();
    let canonical_url_root_for_load = canonical_url_root.clone();
    let actual_url_root_for_load = actual_url_root.clone();

    let webview_builder = WebviewBuilder::new(&label, webview_url_for_parsed_url(&parsed_url))
        .initialization_script(&init_script)
        .auto_resize()
        .background_color(tauri::utils::config::Color(15, 15, 15, 255))
        .on_navigation(move |nav_url| {
            let url_str = canonicalize_child_webview_url(
                &nav_url.to_string(),
                &actual_url_root_for_nav,
                &canonical_url_root_for_nav,
            );
            debug!("[htree] Child webview navigating to: {}", url_str);
            let _ = app_for_nav.emit(
                "child-webview-location",
                serde_json::json!({
                    "label": label_for_nav,
                    "url": url_str,
                    "source": "navigation"
                }),
            );
            true
        })
        .on_page_load(move |_webview, payload| {
            let event = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "started",
                tauri::webview::PageLoadEvent::Finished => "finished",
            };
            let context = format!("page-load:{event}");
            inject_child_init_script(
                &app_for_load,
                &label_for_load,
                &init_script_for_load,
                &context,
            );
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                inject_child_init_script(
                    &app_for_load,
                    &label_for_load,
                    &diagnostic_probe_script_for_load,
                    "page-load:finished-diagnostic-probe",
                );
                schedule_child_init_script_retry(
                    app_for_load.clone(),
                    label_for_load.clone(),
                    init_script_for_load.clone(),
                    Duration::from_millis(150),
                    "page-load:finished-retry-150ms".to_string(),
                );
                schedule_child_init_script_retry(
                    app_for_load.clone(),
                    label_for_load.clone(),
                    init_script_for_load.clone(),
                    Duration::from_millis(1000),
                    "page-load:finished-retry-1000ms".to_string(),
                );
                schedule_child_init_script_retry(
                    app_for_load.clone(),
                    label_for_load.clone(),
                    diagnostic_probe_script_for_load.clone(),
                    Duration::from_millis(150),
                    "page-load:finished-diagnostic-probe-150ms".to_string(),
                );
                schedule_child_init_script_retry(
                    app_for_load.clone(),
                    label_for_load.clone(),
                    diagnostic_probe_script_for_load.clone(),
                    Duration::from_millis(1000),
                    "page-load:finished-diagnostic-probe-1000ms".to_string(),
                );
            }
            let url_str = canonicalize_child_webview_url(
                &payload.url().to_string(),
                &actual_url_root_for_load,
                &canonical_url_root_for_load,
            );
            let _ = app_for_load.emit(
                "child-webview-page-load",
                serde_json::json!({
                    "label": label_for_load,
                    "url": url_str,
                    "event": event
                }),
            );
        });

    window
        .add_child(
            webview_builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create webview: {}", e))?;

    info!(
        "[htree] Webview created with session token for origin {}",
        origin
    );
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[tauri::command]
pub async fn create_htree_webview<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    host: Option<String>,
    nhash: Option<String>,
    npub: Option<String>,
    treename: Option<String>,
    path: String,
    query: Option<String>,
    fragment: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<(), String> {
    let server_url =
        crate::htree_protocol::get_htree_server_url().ok_or("htree server not running")?;

    let (_canonical_url, actual_url, origin, canonical_url_root, actual_url_root) =
        if let Some(nhash) = &nhash {
            let request_host = host.as_deref().unwrap_or(nhash);
            let canonical_url = append_fragment(
                append_query(htree_url_from_nhash(request_host, &path), query.as_deref()),
                fragment.as_deref(),
            );
            let canonical_root = htree_url_from_nhash(request_host, "/")
                .trim_end_matches('/')
                .to_string();
            let actual_url = append_query(
                daemon_proxy_url_from_nhash(&server_url, request_host, &path)?,
                query.as_deref(),
            );
            let actual_url = append_query_params(
                &actual_url,
                &[
                    ("iris_htree_server", &server_url),
                    ("iris_htree_canonical", &canonical_url),
                ],
            )?;
            let actual_url = append_fragment(actual_url, fragment.as_deref());
            let actual_root = daemon_proxy_url_from_nhash(&server_url, request_host, "/")?
                .trim_end_matches('/')
                .to_string();
            let origin = canonical_root.clone();
            (
                canonical_url,
                actual_url,
                origin,
                canonical_root,
                actual_root,
            )
        } else if let Some(treename) = &treename {
            let request_host = host
                .as_deref()
                .or(npub.as_deref())
                .ok_or_else(|| "Either nhash or (host + treename) must be provided".to_string())?;
            let resolved_host =
                resolve_tree_request_host(request_host, crate::htree_protocol::get_self_npub())?;
            let canonical_url = append_fragment(
                append_query(
                    htree_url_from_tree_host(resolved_host, treename, &path),
                    query.as_deref(),
                ),
                fragment.as_deref(),
            );
            let canonical_root = htree_url_from_tree_host(resolved_host, treename, "/")
                .trim_end_matches('/')
                .to_string();
            let actual_url = append_query(
                daemon_proxy_url_from_tree_host(&server_url, resolved_host, treename, &path)?,
                query.as_deref(),
            );
            let actual_url = append_query_params(
                &actual_url,
                &[
                    ("iris_htree_server", &server_url),
                    ("iris_htree_canonical", &canonical_url),
                ],
            )?;
            let actual_url = append_fragment(actual_url, fragment.as_deref());
            let actual_root =
                daemon_proxy_url_from_tree_host(&server_url, resolved_host, treename, "/")?
                    .trim_end_matches('/')
                    .to_string();
            let origin = canonical_root.clone();
            (
                canonical_url,
                actual_url,
                origin,
                canonical_root,
                actual_root,
            )
        } else {
            return Err("Either nhash or (host + treename) must be provided".to_string());
        };

    let nip07_state = app
        .try_state::<Arc<Nip07State>>()
        .ok_or("Nip07State not found")?;
    let session_token = nip07_state.new_session(&origin);

    let init_script = generate_nip07_script(
        &server_url,
        &session_token,
        &label,
        Some(&origin),
        Some(&canonical_url_root),
        Some(&actual_url_root),
    );
    let diagnostic_probe_script = generate_webview_diagnostic_probe_script(
        &server_url,
        &session_token,
        &label,
        &origin,
        Some(&canonical_url_root),
        Some(&actual_url_root),
        "page-load-probe",
    );
    let actual_parsed_url =
        tauri::Url::parse(&actual_url).map_err(|e| format!("Invalid URL: {}", e))?;

    app.mobile_browser().create(BrowserCreateRequest {
        label,
        url: actual_url,
        x,
        y,
        width,
        height,
        scale,
        init_script,
        diagnostic_script: diagnostic_probe_script,
        allowed_origin_rule: url_origin(&actual_parsed_url),
        actual_url_root: Some(actual_url_root),
        canonical_url_root: Some(canonical_url_root),
    })
}

fn canonicalize_child_webview_url(
    url: &str,
    actual_url_root: &str,
    canonical_url_root: &str,
) -> String {
    let canonical_url = url
        .strip_prefix(actual_url_root)
        .map(|suffix| format!("{}{}", canonical_url_root, suffix))
        .unwrap_or_else(|| url.to_string());
    strip_internal_htree_query_params(&canonical_url)
}

fn strip_internal_htree_query_params(url: &str) -> String {
    let Ok(mut parsed) = tauri::Url::parse(url) else {
        return url.to_string();
    };

    let retained_query: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| key != "iris_htree_server" && key != "iris_htree_canonical")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();

    parsed.set_query(None);
    if !retained_query.is_empty() {
        let mut query_pairs = parsed.query_pairs_mut();
        for (key, value) in retained_query {
            query_pairs.append_pair(&key, &value);
        }
    }

    parsed.into()
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[tauri::command]
pub fn close_webview<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|e| format!("Failed to close webview: {}", e))?;
        info!("[NIP-07] Closed webview {}", label);
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[tauri::command]
pub fn close_webview<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    app.mobile_browser().close(label)
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[tauri::command]
pub fn navigate_webview<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    url: String,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("Failed to navigate: {}", e))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[tauri::command]
pub fn navigate_webview<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    url: String,
) -> Result<(), String> {
    app.mobile_browser().navigate(label, url)
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[tauri::command]
pub fn set_webview_bounds<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    _scale: Option<f64>,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    let bounds = Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(width.max(0.0), height.max(0.0)).into(),
    };
    webview
        .set_bounds(bounds)
        .map_err(|e| format!("Failed to set bounds: {}", e))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[tauri::command]
pub fn set_webview_bounds<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<(), String> {
    app.mobile_browser().set_bounds(BrowserBoundsRequest {
        label,
        x,
        y,
        width,
        height,
        scale,
    })
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[tauri::command]
pub fn set_mobile_shell_overlay<R: Runtime>(
    _app: AppHandle<R>,
    _enabled: bool,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
    _scale: Option<f64>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[tauri::command]
pub fn set_mobile_shell_overlay<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
) -> Result<(), String> {
    app.mobile_browser().set_shell_overlay(ShellOverlayRequest {
        enabled,
        x,
        y,
        width,
        height,
        scale,
    })
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[tauri::command]
pub fn webview_history<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    direction: String,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    let script = match direction.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        _ => return Err("Invalid history direction".to_string()),
    };
    webview
        .eval(script)
        .map_err(|e| format!("Failed to navigate history: {}", e))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[tauri::command]
pub fn webview_history<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    direction: String,
) -> Result<(), String> {
    app.mobile_browser().history(label, direction)
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[tauri::command]
pub fn reload_webview<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    webview
        .eval("location.reload()")
        .map_err(|e| format!("Failed to reload webview: {}", e))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[tauri::command]
pub fn reload_webview<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    app.mobile_browser().reload(label)
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
#[tauri::command]
pub fn webview_current_url<R: Runtime>(app: AppHandle<R>, label: String) -> Result<String, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    webview
        .url()
        .map(|url| url.to_string())
        .map_err(|e| format!("Failed to read webview URL: {}", e))
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[tauri::command]
pub fn webview_current_url<R: Runtime>(app: AppHandle<R>, label: String) -> Result<String, String> {
    app.mobile_browser().current_url(label)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewEventRequest {
    kind: String,
    label: String,
    origin: String,
    url: Option<String>,
    source: Option<String>,
    action: Option<String>,
    title: Option<String>,
    ready_state: Option<String>,
    body_text: Option<String>,
    media_summary: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebviewEventHttpEnvelope {
    session_token: String,
    payload: WebviewEventRequest,
}

#[tauri::command]
pub fn webview_event<R: Runtime>(
    app: AppHandle<R>,
    payload: WebviewEventRequest,
    session_token: String,
) -> Result<(), String> {
    let nip07_state =
        get_nip07_state().ok_or_else(|| "NIP-07 state not initialized".to_string())?;

    if !nip07_state.validate_token(&payload.origin, &session_token) {
        warn!(
            "[webview-event] Invalid session token for kind={} label={} origin={}",
            payload.kind, payload.label, payload.origin
        );
        return Err("Invalid session token".to_string());
    }

    debug!(
        "[webview-event] kind={} label={} origin={} url={:?}",
        payload.kind, payload.label, payload.origin, payload.url
    );

    match payload.kind.as_str() {
        "location" => {
            let url = payload
                .url
                .clone()
                .ok_or_else(|| "Missing url".to_string())?;
            let source = payload
                .source
                .clone()
                .unwrap_or_else(|| "unknown".to_string());
            let _ = app.emit(
                "child-webview-location",
                serde_json::json!({
                    "label": payload.label,
                    "url": url,
                    "source": source
                }),
            );
        }
        "navigate" => {
            let action = match payload.action.as_deref() {
                Some("back") => "back",
                Some("forward") => "forward",
                _ => return Err("Invalid action".to_string()),
            };
            let _ = app.emit(
                "child-webview-navigate",
                serde_json::json!({
                    "label": payload.label,
                    "action": action
                }),
            );
        }
        "diagnostic" => {
            let _ = app.emit(
                "child-webview-diagnostic",
                serde_json::json!({
                    "label": payload.label,
                    "url": payload.url,
                    "source": payload.source,
                    "title": payload.title,
                    "readyState": payload.ready_state,
                    "bodyText": payload.body_text,
                    "mediaSummary": payload.media_summary,
                    "error": payload.error
                }),
            );
        }
        _ => {
            return Err("Invalid event kind".to_string());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nhash_origin_uses_root_identity() {
        assert_eq!(
            htree_origin_from_nhash("nhash1example"),
            "htree://nhash1example"
        );
    }

    #[test]
    fn tree_origin_uses_tree_root_identity() {
        assert_eq!(
            htree_origin_from_tree_host("npub1example", "video"),
            "htree://npub1example/video"
        );
    }

    #[test]
    fn npub_urls_use_path_segments() {
        assert_eq!(
            htree_url_from_tree_host("npub1example", "public", "/index.html"),
            "htree://npub1example/public/index.html"
        );
    }

    #[test]
    fn npub_urls_encode_tree_name_as_single_segment() {
        assert_eq!(
            htree_url_from_tree_host("npub1example", "videos/My Clip", "/index.html"),
            "htree://npub1example/videos%2FMy%20Clip/index.html"
        );
    }

    #[test]
    fn append_fragment_keeps_hash_routes_after_query_strings() {
        let url = append_fragment(
            append_query("htree://npub1example/git/".to_string(), Some("smoke=1")),
            Some("/npub1owner/hashtree?tab=pulls"),
        );
        assert_eq!(
            url,
            "htree://npub1example/git/?smoke=1#/npub1owner/hashtree?tab=pulls"
        );
    }

    #[test]
    fn self_urls_use_same_tree_path_shape() {
        assert_eq!(
            htree_url_from_tree_host("self", "video", "/index.html"),
            "htree://self/video/index.html"
        );
    }

    #[test]
    fn tree_root_urls_keep_trailing_slash_for_relative_assets() {
        assert_eq!(
            htree_url_from_tree_host("self", "video", "/"),
            "htree://self/video/"
        );
    }

    #[test]
    fn daemon_proxy_tree_urls_use_origin_isolated_loopback_hosts() {
        let url = daemon_proxy_url_from_tree_host(
            "http://127.0.0.1:21417",
            "npub1example",
            "videos/My Clip",
            "/index.html",
        )
        .unwrap();
        let parsed = tauri::Url::parse(&url).expect("valid URL");
        assert_eq!(
            parsed.path(),
            "/htree/npub1example/videos%2FMy%20Clip/index.html"
        );
        let host = parsed.host_str().expect("loopback host");
        if use_origin_isolated_loopback_hosts() {
            assert!(
                host.ends_with(".htree.localhost"),
                "expected isolated loopback host, got {url}"
            );
        } else {
            assert_eq!(host, "127.0.0.1", "expected plain loopback host, got {url}");
        }
    }

    #[test]
    fn daemon_proxy_tree_root_urls_keep_trailing_slash() {
        let url =
            daemon_proxy_url_from_tree_host("http://127.0.0.1:21417", "npub1example", "video", "/")
                .unwrap();
        assert!(
            url.ends_with("/htree/npub1example/video/"),
            "expected tree root URL to keep trailing slash, got {url}"
        );
    }

    #[test]
    fn daemon_proxy_nhash_urls_use_embedded_server_paths() {
        let url =
            daemon_proxy_url_from_nhash("http://127.0.0.1:21417", "nhash1example", "/poster.png")
                .unwrap();
        let parsed = tauri::Url::parse(&url).expect("valid URL");
        assert_eq!(parsed.path(), "/htree/nhash1example/poster.png");
        let host = parsed.host_str().expect("loopback host");
        if use_origin_isolated_loopback_hosts() {
            assert!(
                host.ends_with(".htree.localhost"),
                "expected isolated loopback host, got {url}"
            );
        } else {
            assert_eq!(host, "127.0.0.1", "expected plain loopback host, got {url}");
        }
    }

    #[test]
    fn origin_isolated_loopback_hosts_are_stable_per_tree_root() {
        let canonical_root = htree_origin_from_tree_host("npub1example", "video");
        let first = loopback_server_url("http://127.0.0.1:21417", &canonical_root, true).unwrap();
        let second = loopback_server_url("http://127.0.0.1:21417", &canonical_root, true).unwrap();
        let first_host = tauri::Url::parse(&first)
            .expect("valid URL")
            .host_str()
            .expect("first host")
            .to_string();
        let second_host = tauri::Url::parse(&second)
            .expect("valid URL")
            .host_str()
            .expect("second host")
            .to_string();
        assert_eq!(first_host, second_host);
    }

    #[test]
    fn origin_isolated_loopback_hosts_differ_across_tree_roots_and_nhashes() {
        let owner_a = loopback_server_url(
            "http://127.0.0.1:21417",
            &htree_origin_from_tree_host("npub1alice", "video"),
            true,
        )
        .unwrap();
        let owner_b = loopback_server_url(
            "http://127.0.0.1:21417",
            &htree_origin_from_tree_host("npub1bob", "video"),
            true,
        )
        .unwrap();
        let nhash = loopback_server_url(
            "http://127.0.0.1:21417",
            &htree_origin_from_nhash("nhash1example"),
            true,
        )
        .unwrap();
        let owner_a_host = tauri::Url::parse(&owner_a)
            .expect("valid URL")
            .host_str()
            .expect("owner A host")
            .to_string();
        let owner_b_host = tauri::Url::parse(&owner_b)
            .expect("valid URL")
            .host_str()
            .expect("owner B host")
            .to_string();
        let nhash_host = tauri::Url::parse(&nhash)
            .expect("valid nhash URL")
            .host_str()
            .expect("nhash host")
            .to_string();
        assert_ne!(owner_a_host, owner_b_host);
        assert_ne!(owner_a_host, nhash_host);
        assert_ne!(owner_b_host, nhash_host);
    }

    #[test]
    fn canonicalized_child_urls_map_back_to_htree_identity() {
        let url = canonicalize_child_webview_url(
            "http://tree-deadbeef.htree.localhost:21417/htree/npub1example/video/index.html?smoke=1&iris_htree_server=http%3A%2F%2F127.0.0.1%3A21417&iris_htree_canonical=htree%3A%2F%2Fnpub1example%2Fvideo%2Findex.html%3Fsmoke%3D1#/feed",
            "http://tree-deadbeef.htree.localhost:21417/htree/npub1example/video",
            "htree://npub1example/video",
        );
        assert_eq!(url, "htree://npub1example/video/index.html?smoke=1#/feed");
    }

    #[test]
    fn canonicalized_child_urls_map_back_from_plain_loopback_transport() {
        let url = canonicalize_child_webview_url(
            "http://127.0.0.1:21417/htree/npub1example/video/index.html?smoke=1&iris_htree_server=http%3A%2F%2F127.0.0.1%3A21417&iris_htree_canonical=htree%3A%2F%2Fnpub1example%2Fvideo%2Findex.html%3Fsmoke%3D1#/feed",
            "http://127.0.0.1:21417/htree/npub1example/video",
            "htree://npub1example/video",
        );
        assert_eq!(url, "htree://npub1example/video/index.html?smoke=1#/feed");
    }

    #[test]
    fn canonicalized_child_urls_map_nhash_transport_back_to_tree_host_identity() {
        let url = canonicalize_child_webview_url(
            "http://127.0.0.1:21417/htree/nhash1example/index.html?smoke=1&iris_htree_server=http%3A%2F%2F127.0.0.1%3A21417&iris_htree_canonical=htree%3A%2F%2Fnpub1example%2Fvideo%2Findex.html%3Fsmoke%3D1#/feed",
            "http://127.0.0.1:21417/htree/nhash1example",
            "htree://npub1example/video",
        );
        assert_eq!(url, "htree://npub1example/video/index.html?smoke=1#/feed");
    }

    #[test]
    fn canonicalized_child_urls_strip_internal_query_params_without_removing_user_query() {
        let url = canonicalize_child_webview_url(
            "htree://npub1example/video/index.html?smoke=1&iris_htree_server=http%3A%2F%2F127.0.0.1%3A21417&iris_htree_canonical=htree%3A%2F%2Fnpub1example%2Fvideo%2Findex.html%3Fsmoke%3D1",
            "http://127.0.0.1:21417/htree/npub1example/video",
            "htree://npub1example/video",
        );
        assert_eq!(url, "htree://npub1example/video/index.html?smoke=1");
    }

    #[test]
    fn self_tree_host_resolves_to_owner_npub_before_loading() {
        assert_eq!(
            resolve_tree_request_host("self", Some("npub1owner")).unwrap(),
            "npub1owner"
        );
    }

    #[test]
    fn self_tree_host_requires_owner_identity() {
        let err =
            resolve_tree_request_host("self", None).expect_err("self should require identity");
        assert!(err.contains("self identity"));
    }

    #[test]
    fn http_urls_use_external_webview_variant() {
        let url = tauri::Url::parse("https://files.iris.to").unwrap();
        assert!(matches!(
            webview_url_for_parsed_url(&url),
            WebviewUrl::External(_)
        ));
    }

    #[test]
    fn custom_scheme_urls_use_custom_protocol_webview_variant() {
        let url = tauri::Url::parse("htree://self/video").unwrap();
        assert!(matches!(
            webview_url_for_parsed_url(&url),
            WebviewUrl::CustomProtocol(_)
        ));
    }
}
