//! Iris - Thin native shell with embedded htree daemon
//!
//! This is the native desktop app that:
//! 1. Starts an embedded htree daemon (content storage, P2P, Nostr relay)
//! 2. Opens a webview pointing to iris-files web app
//! 3. Injects window.__HTREE_SERVER_URL__ so the web app can use the daemon
//! 4. Provides htree:// URI scheme for child webviews
//! 5. Manages NIP-07 permissions for child webviews

pub mod history;
pub mod htree_protocol;
pub mod nip07;
pub mod permissions;
pub mod relay_proxy;

use axum::routing::any;
use axum::Router;
use hashtree_cli::daemon::{EmbeddedDaemonOptions, EmbeddedDaemonInfo};
use hashtree_cli::server::AppState;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Once;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use tracing_subscriber::EnvFilter;

static RUSTLS_PROVIDER_INIT: Once = Once::new();

pub fn ensure_rustls_provider() {
    RUSTLS_PROVIDER_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Start the embedded htree daemon
async fn start_daemon(data_dir: PathBuf) -> Result<EmbeddedDaemonInfo, String> {
    relay_proxy::init_relay_proxy_state();

    let mut config = hashtree_cli::Config::load()
        .map_err(|e| format!("Failed to load config: {}", e))?;
    config.storage.data_dir = data_dir.to_string_lossy().to_string();
    config.server.bind_address = "127.0.0.1:21417".to_string();
    config.server.enable_auth = false;
    config.server.stun_port = 0;

    // Add extra routes for relay proxy and NIP-07
    let extra_routes = Router::<AppState>::new()
        .route("/relay", any(relay_proxy::handle_relay_websocket));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([
            axum::http::header::ACCEPT_RANGES,
            axum::http::header::CONTENT_RANGE,
            axum::http::header::CONTENT_LENGTH,
            axum::http::header::CONTENT_TYPE,
        ]);

    let info = hashtree_cli::daemon::start_embedded(EmbeddedDaemonOptions {
        config,
        data_dir,
        bind_address: "127.0.0.1:21417".to_string(),
        relays: None,
        extra_routes: Some(extra_routes),
        cors: Some(cors),
    })
    .await
    .map_err(|e| format!("Failed to start daemon: {}", e))?;

    Ok(info)
}

// ============================================
// Menu construction
// ============================================

#[cfg(test)]
fn build_edit_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    let cut = MenuItemBuilder::with_id("edit_cut", "Cut")
        .accelerator("CmdOrCtrl+X")
        .build(app)?;
    let copy = MenuItemBuilder::with_id("edit_copy", "Copy")
        .accelerator("CmdOrCtrl+C")
        .build(app)?;
    let paste = MenuItemBuilder::with_id("edit_paste", "Paste")
        .accelerator("CmdOrCtrl+V")
        .build(app)?;
    let select_all = MenuItemBuilder::with_id("edit_select_all", "Select All")
        .accelerator("CmdOrCtrl+A")
        .build(app)?;

    SubmenuBuilder::with_id(app, "edit_menu", "Edit")
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .item(&select_all)
        .build()
}

#[cfg(not(test))]
fn build_edit_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    SubmenuBuilder::with_id(app, "edit_menu", "Edit")
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
}

fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let app_name = app.package_info().name.clone();
    let quit = MenuItemBuilder::with_id("app_quit", "Quit")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, app_name).item(&quit).build()?;

    let back = MenuItemBuilder::with_id("nav_back", "Back")
        .accelerator("CmdOrCtrl+Left")
        .build(app)?;
    let forward = MenuItemBuilder::with_id("nav_forward", "Forward")
        .accelerator("CmdOrCtrl+Right")
        .build(app)?;

    let navigation = SubmenuBuilder::new(app, "Navigation")
        .item(&back)
        .item(&forward)
        .build()?;

    let edit = build_edit_menu(app)?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit)
        .item(&navigation)
        .build()
}

// ============================================
// App entry point
// ============================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_rustls_provider();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("iris=info")),
        )
        .init();

    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "nav_back" => {
                    let _ = app.emit(
                        "child-webview-navigate",
                        serde_json::json!({ "action": "back" }),
                    );
                }
                "nav_forward" => {
                    let _ = app.emit(
                        "child-webview-navigate",
                        serde_json::json!({ "action": "forward" }),
                    );
                }
                "app_quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_os::init())
        .register_uri_scheme_protocol("htree", htree_protocol::handle_htree_protocol)
        .invoke_handler(tauri::generate_handler![
            htree_protocol::get_htree_server_url,
            htree_protocol::cache_tree_root,
            nip07::create_nip07_webview,
            nip07::create_htree_webview,
            nip07::navigate_webview,
            nip07::webview_history,
            nip07::webview_current_url,
            nip07::nip07_request,
            nip07::webview_event,
            history::record_history_visit,
            history::search_history,
            history::get_recent_history
        ])
        .on_page_load(|webview, payload| {
            if webview.label() == "main" {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    info!("Main window page loaded: {}", payload.url());

                    // Inject daemon server URL so the web app can find it
                    let port = htree_protocol::get_daemon_port().unwrap_or(21417);
                    let inject_url = format!(
                        "window.__HTREE_SERVER_URL__ = 'http://127.0.0.1:{}';",
                        port
                    );
                    if let Err(e) = webview.eval(&inject_url) {
                        tracing::warn!("Failed to inject __HTREE_SERVER_URL__: {}", e);
                    }

                    // Inject NIP-07 window.nostr
                    let script = nip07::generate_main_window_nip07_script();
                    if let Err(e) = webview.eval(&script) {
                        tracing::warn!("Failed to inject NIP-07 script: {}", e);
                    } else {
                        info!("Injected NIP-07 window.nostr and __HTREE_SERVER_URL__ into main window");
                    }
                }
            }
        })
        .setup(|app| {
            let data_dir = match std::env::var("HTREE_DATA_DIR") {
                Ok(dir) if !dir.trim().is_empty() => {
                    let path = PathBuf::from(dir);
                    info!("Using HTREE_DATA_DIR override: {:?}", path);
                    path
                }
                _ => app
                    .path()
                    .app_data_dir()
                    .expect("failed to get app data dir"),
            };
            std::fs::create_dir_all(&data_dir).expect("failed to create data dir");
            info!("App data directory: {:?}", data_dir);

            std::env::set_var("HTREE_CONFIG_DIR", &data_dir);
            std::env::set_var("HTREE_DATA_DIR", &data_dir);

            // Initialize NIP-07 permission state
            let permission_store = Arc::new(permissions::PermissionStore::new(None));
            let nip07_state = Arc::new(nip07::Nip07State::new(permission_store));
            nip07::init_global_state(nip07_state.clone());
            app.manage(nip07_state);

            // Initialize history store
            let history_store = Arc::new(
                history::HistoryStore::new(&data_dir)
                    .expect("failed to initialize history store"),
            );
            app.manage(history_store);

            // Start the embedded htree daemon
            let daemon_data_dir = data_dir.clone();
            tauri::async_runtime::spawn(async move {
                match start_daemon(daemon_data_dir).await {
                    Ok(info) => {
                        htree_protocol::set_daemon_port(info.port);
                        info!("Embedded daemon started on port {}", info.port);
                    }
                    Err(e) => {
                        tracing::error!("Failed to start embedded daemon: {}", e);
                    }
                }
            });

            // Check if launched with --minimized flag (from autostart)
            #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
            {
                let args: Vec<String> = std::env::args().collect();
                if args.contains(&"--minimized".to_string()) {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.minimize();
                        info!("Started minimized (autostart)");
                    }
                }
            }

            // Add plugins
            app.handle().plugin(tauri_plugin_notification::init())?;
            app.handle().plugin(tauri_plugin_opener::init())?;
            app.handle().plugin(tauri_plugin_dialog::init())?;

            #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--minimized"]),
            ))?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::build_menu;

    #[cfg_attr(target_os = "macos", ignore = "requires main thread for menu items")]
    #[test]
    fn app_menu_includes_quit_item() {
        let app = tauri::test::mock_app();
        let handle = app.handle();
        let menu = build_menu(&handle).expect("failed to build menu");
        let mut has_quit = false;

        for item in menu.items().unwrap_or_default() {
            if let tauri::menu::MenuItemKind::Submenu(submenu) = item {
                for subitem in submenu.items().unwrap_or_default() {
                    if subitem.id().as_ref() == "app_quit" {
                        has_quit = true;
                    }
                }
            }
        }

        assert!(has_quit, "expected app_quit menu item");
    }
}
