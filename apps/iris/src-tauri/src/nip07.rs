//! NIP-07 webview support for child webviews
//!
//! Provides window.nostr capability for child webviews.
//! NIP-07 signing is proxied to the main webview's window.nostr
//! (which the web app provides via its own identity management).

use crate::permissions::{PermissionStore, PermissionType};
use once_cell::sync::OnceCell;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewBuilder, WebviewUrl};
use tracing::{debug, error, info, warn};

// ============================================
// htree:// URL helpers for origin isolation
// ============================================

pub fn htree_origin_from_nhash(nhash: &str) -> String {
    format!("htree://{}", nhash)
}

pub fn htree_origin_from_npub(npub: &str, treename: &str) -> String {
    format!("htree://{}.{}", npub, treename)
}

fn htree_url_from_nhash(nhash: &str, path: &str) -> String {
    if path.is_empty() || path == "/" {
        format!("htree://{}", nhash)
    } else {
        let path = path.trim_start_matches('/');
        format!("htree://{}/{}", nhash, path)
    }
}

fn htree_url_from_npub(npub: &str, treename: &str, path: &str) -> String {
    if path.is_empty() || path == "/" {
        format!("htree://{}.{}", npub, treename)
    } else {
        let path = path.trim_start_matches('/');
        format!("htree://{}.{}/{}", npub, treename, path)
    }
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

    pub fn validate_any_token(&self, token: &str) -> bool {
        self.session_tokens
            .read()
            .values()
            .any(|stored| stored == token)
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
"#.to_string()
}

/// Generate NIP-07 init script for child webviews (uses htree://nip07/ protocol)
pub fn generate_nip07_script(server_url: &str, session_token: &str, label: &str) -> String {
    format!(
        r#"
(function() {{
  const hasNostr = !!window.nostr;
  const SERVER_URL = "{}";
  const SESSION_TOKEN = "{}";
  const WEBVIEW_LABEL = "{}";
  const NAV_ENDPOINT = `${{SERVER_URL}}/webview`;
  console.log('[NIP-07] Initializing with server:', SERVER_URL);
  window.__HTREE_SERVER_URL__ = SERVER_URL;

  let invokePromise = null;
  async function getInvoke() {{
    if (invokePromise) return invokePromise;
    invokePromise = (async () => {{
      const getNow = () =>
        window.__TAURI_INTERNALS__?.invoke ||
        window.__TAURI__?.core?.invoke ||
        window.__TAURI__?.invoke ||
        null;
      const immediate = getNow();
      if (immediate) return immediate;
      for (let i = 0; i < 20; i++) {{
        await new Promise((resolve) => setTimeout(resolve, 50));
        const candidate = getNow();
        if (candidate) return candidate;
      }}
      return null;
    }})();
    return invokePromise;
  }}

  function getOrigin() {{
    const origin = window.location.origin;
    if (origin && origin !== 'null') return origin;
    const protocol = window.location.protocol || '';
    const normalizedProtocol = protocol.endsWith(':') ? protocol.slice(0, -1) : protocol;
    const host = window.location.host || '';
    if (host) return `${{normalizedProtocol}}://${{host}}`;
    return normalizedProtocol || 'null';
  }}

  async function postWebviewEvent(payload) {{
    try {{
      const invoke = await getInvoke();
      if (invoke) {{
        await invoke('webview_event', {{
          payload,
          session_token: SESSION_TOKEN
        }});
        return;
      }}
    }} catch (error) {{
      console.warn('[WebviewBridge] Failed to send event via invoke', error);
    }}
    fetch(NAV_ENDPOINT, {{
      method: 'POST',
      headers: {{
        'Content-Type': 'application/json',
        'X-Session-Token': SESSION_TOKEN
      }},
      body: JSON.stringify(payload)
    }}).catch((error) => {{
      console.warn('[WebviewBridge] Failed to send event', error);
    }});
  }}

  let lastLocation = null;
  function notifyLocation(source) {{
    const url = window.location.href;
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
  window.addEventListener('DOMContentLoaded', () => notifyLocation('domcontentloaded'));
  window.addEventListener('load', () => notifyLocation('load'));
  queueMicrotask(() => notifyLocation('init'));

  async function callNip07(method, params) {{
    console.log('[NIP-07] Calling:', method, params);
    try {{
      const response = await fetch('htree://nip07/', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
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
        server_url, session_token, label
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

#[tauri::command]
pub async fn create_nip07_webview<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    info!("[NIP-07] Creating webview {} for {}", label, url);

    let server_url = crate::htree_protocol::get_htree_server_url()
        .ok_or("htree server not running")?;

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

    let init_script = generate_nip07_script(&server_url, &session_token, &label);

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
        WebviewUrl::External(parsed_url.clone())
    };

    let app_for_nav = app.clone();
    let label_for_nav = label.clone();

    let webview_builder = WebviewBuilder::new(&label, webview_url)
        .initialization_script(&init_script)
        .auto_resize()
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

#[tauri::command]
pub async fn create_htree_webview<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    nhash: Option<String>,
    npub: Option<String>,
    treename: Option<String>,
    path: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let (url, origin) = if let Some(nhash) = &nhash {
        let url = htree_url_from_nhash(nhash, &path);
        let origin = htree_origin_from_nhash(nhash);
        (url, origin)
    } else if let (Some(npub), Some(treename)) = (&npub, &treename) {
        let url = htree_url_from_npub(npub, treename, &path);
        let origin = htree_origin_from_npub(npub, treename);
        (url, origin)
    } else {
        return Err("Either nhash or (npub + treename) must be provided".to_string());
    };

    info!("[htree] Creating webview {} for {} (origin: {})", label, url, origin);

    let server_url = crate::htree_protocol::get_htree_server_url()
        .ok_or("htree server not running")?;

    let nip07_state = app
        .try_state::<Arc<Nip07State>>()
        .ok_or("Nip07State not found")?;
    let session_token = nip07_state.new_session(&origin);

    let init_script = generate_nip07_script(&server_url, &session_token, &label);

    let window = app.get_window("main").ok_or("Main window not found")?;
    let parsed_url = tauri::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    let app_for_nav = app.clone();
    let label_for_nav = label.clone();

    let webview_builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
        .initialization_script(&init_script)
        .auto_resize()
        .on_navigation(move |nav_url| {
            let url_str = nav_url.to_string();
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
        });

    window
        .add_child(
            webview_builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create webview: {}", e))?;

    info!("[htree] Webview created with session token for origin {}", origin);
    Ok(())
}

#[tauri::command]
pub fn close_webview<R: Runtime>(
    app: AppHandle<R>,
    label: String,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|e| format!("Failed to close webview: {}", e))?;
        info!("[NIP-07] Closed webview {}", label);
    }
    Ok(())
}

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

#[tauri::command]
pub fn webview_current_url<R: Runtime>(
    app: AppHandle<R>,
    label: String,
) -> Result<String, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview {} not found", label))?;
    webview
        .url()
        .map(|url| url.to_string())
        .map_err(|e| format!("Failed to read webview URL: {}", e))
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
}

#[tauri::command]
pub fn webview_event<R: Runtime>(
    app: AppHandle<R>,
    payload: WebviewEventRequest,
    session_token: String,
) -> Result<(), String> {
    let nip07_state = get_nip07_state()
        .ok_or_else(|| "NIP-07 state not initialized".to_string())?;

    if !nip07_state.validate_token(&payload.origin, &session_token)
        && !nip07_state.validate_any_token(&session_token)
    {
        return Err("Invalid session token".to_string());
    }

    match payload.kind.as_str() {
        "location" => {
            let url = payload.url.clone().ok_or_else(|| "Missing url".to_string())?;
            let source = payload.source.clone().unwrap_or_else(|| "unknown".to_string());
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
        _ => {
            return Err("Invalid event kind".to_string());
        }
    }

    Ok(())
}
