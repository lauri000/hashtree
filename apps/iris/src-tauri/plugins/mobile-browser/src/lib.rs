#[cfg(any(target_os = "android", target_os = "ios"))]
use serde::Deserialize;
use serde::Serialize;
#[cfg(any(target_os = "android", target_os = "ios"))]
use serde_json::json;
#[cfg(any(target_os = "android", target_os = "ios"))]
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Emitter, Manager,
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;

#[cfg(any(target_os = "android", target_os = "ios"))]
pub use mobile::MobileBrowser;

#[cfg(any(target_os = "android", target_os = "ios"))]
const MOBILE_PLUGIN_NAME: &str = "iris-mobile-browser";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCreateRequest {
    pub label: String,
    pub url: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub init_script: String,
    pub diagnostic_script: String,
    pub allowed_origin_rule: Option<String>,
    pub actual_url_root: Option<String>,
    pub canonical_url_root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigateRequest {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBoundsRequest {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHistoryRequest {
    pub label: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLabelRequest {
    pub label: String,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterListenerRequest {
    event: String,
    handler: Channel,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeLocationEvent {
    label: String,
    url: String,
    source: Option<String>,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePageLoadEvent {
    label: String,
    url: String,
    event: String,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeCurrentUrlResponse {
    url: Option<String>,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDiagnosticEvent {
    label: String,
    url: Option<String>,
    source: Option<String>,
    title: Option<String>,
    ready_state: Option<String>,
    body_text: Option<String>,
    media_summary: Option<String>,
    error: Option<String>,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(Debug, Clone, Default)]
struct UrlMapping {
    actual_url_root: Option<String>,
    canonical_url_root: Option<String>,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn decode_channel_payload<T: for<'de> Deserialize<'de>>(
    body: InvokeResponseBody,
) -> tauri::Result<T> {
    match body {
        InvokeResponseBody::Json(payload) => {
            serde_json::from_str::<T>(&payload).map_err(Into::into)
        }
        InvokeResponseBody::Raw(payload) => {
            serde_json::from_slice::<T>(&payload).map_err(Into::into)
        }
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn mobile_plugin_setup_error(action: &str, error: impl std::fmt::Display) -> tauri::Error {
    tauri::Error::PluginInitialization(MOBILE_PLUGIN_NAME.to_string(), format!("{action}: {error}"))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn strip_internal_htree_query_params(url: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(url) else {
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

    parsed.to_string()
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn canonicalize_url(url: &str, mapping: &UrlMapping) -> String {
    if let (Some(actual_root), Some(canonical_root)) = (
        mapping.actual_url_root.as_deref(),
        mapping.canonical_url_root.as_deref(),
    ) {
        if let Some(suffix) = url.strip_prefix(actual_root) {
            return strip_internal_htree_query_params(&format!("{canonical_root}{suffix}"));
        }
    }
    strip_internal_htree_query_params(url)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn register_native_listeners<R: Runtime>(
    app: &AppHandle<R>,
    browser: &MobileBrowser<R>,
    mappings: Arc<Mutex<HashMap<String, UrlMapping>>>,
) -> tauri::Result<()> {
    let location_app = app.clone();
    let location_mappings = mappings.clone();
    browser
        .handle
        .run_mobile_plugin::<()>(
            "registerListener",
            RegisterListenerRequest {
                event: "location".to_string(),
                handler: Channel::new(move |body| {
                    let mut payload = decode_channel_payload::<NativeLocationEvent>(body)?;
                    let mapping = location_mappings
                        .lock()
                        .unwrap()
                        .get(&payload.label)
                        .cloned()
                        .unwrap_or_default();
                    payload.url = canonicalize_url(&payload.url, &mapping);
                    let _ = location_app.emit(
                        "child-webview-location",
                        json!({
                            "label": payload.label,
                            "url": payload.url,
                            "source": payload.source.unwrap_or_else(|| "navigation".to_string()),
                        }),
                    );
                    Ok(())
                }),
            },
        )
        .map_err(|error| mobile_plugin_setup_error("register native location listener", error))?;

    let page_load_app = app.clone();
    let page_load_mappings = mappings.clone();
    browser
        .handle
        .run_mobile_plugin::<()>(
            "registerListener",
            RegisterListenerRequest {
                event: "page-load".to_string(),
                handler: Channel::new(move |body| {
                    let mut payload = decode_channel_payload::<NativePageLoadEvent>(body)?;
                    let mapping = page_load_mappings
                        .lock()
                        .unwrap()
                        .get(&payload.label)
                        .cloned()
                        .unwrap_or_default();
                    payload.url = canonicalize_url(&payload.url, &mapping);
                    let _ = page_load_app.emit(
                        "child-webview-page-load",
                        json!({
                            "label": payload.label,
                            "url": payload.url,
                            "event": payload.event,
                        }),
                    );
                    Ok(())
                }),
            },
        )
        .map_err(|error| mobile_plugin_setup_error("register native page-load listener", error))?;

    let diagnostic_app = app.clone();
    let diagnostic_mappings = mappings.clone();
    browser
        .handle
        .run_mobile_plugin::<()>(
            "registerListener",
            RegisterListenerRequest {
                event: "diagnostic".to_string(),
                handler: Channel::new(move |body| {
                    let mut payload = decode_channel_payload::<NativeDiagnosticEvent>(body)?;
                    let mapping = diagnostic_mappings
                        .lock()
                        .unwrap()
                        .get(&payload.label)
                        .cloned()
                        .unwrap_or_default();
                    payload.url = payload
                        .url
                        .as_deref()
                        .map(|url| canonicalize_url(url, &mapping));
                    let _ = diagnostic_app.emit(
                        "child-webview-diagnostic",
                        json!({
                            "label": payload.label,
                            "url": payload.url,
                            "source": payload.source,
                            "title": payload.title,
                            "readyState": payload.ready_state,
                            "bodyText": payload.body_text,
                            "mediaSummary": payload.media_summary,
                            "error": payload.error,
                        }),
                    );
                    Ok(())
                }),
            },
        )
        .map_err(|error| mobile_plugin_setup_error("register native diagnostic listener", error))?;

    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("iris-mobile-browser").build()
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("iris-mobile-browser")
        .setup(|app, api| {
            let browser = mobile::init(app, api)?;
            let mappings = browser.mappings();
            register_native_listeners(app, &browser, mappings)?;
            app.manage(browser);
            Ok(())
        })
        .build()
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub trait MobileBrowserExt<R: Runtime> {
    fn mobile_browser(&self) -> &MobileBrowser<R>;
}

#[cfg(any(target_os = "android", target_os = "ios"))]
impl<R: Runtime, T: Manager<R>> MobileBrowserExt<R> for T {
    fn mobile_browser(&self) -> &MobileBrowser<R> {
        self.state::<MobileBrowser<R>>().inner()
    }
}
