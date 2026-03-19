//! Iris - Thin native shell with embedded htree daemon
//!
//! This is the native desktop app that:
//! 1. Starts an embedded htree daemon (content storage, P2P, Nostr relay)
//! 2. Opens a webview pointing to iris-files web app
//! 3. Injects window.__HTREE_SERVER_URL__ so the web app can use the daemon
//! 4. Provides htree:// URI scheme for child webviews
//! 5. Manages NIP-07 permissions for child webviews

pub mod automation;
pub mod history;
pub mod htree_protocol;
pub mod nip07;
pub mod permissions;
pub mod relay_proxy;

use axum::body::Bytes;
use axum::http::HeaderMap;
use axum::routing::{any, post};
use axum::Router;
use hashtree_cli::daemon::{EmbeddedDaemonInfo, EmbeddedDaemonOptions};
use hashtree_cli::server::AppState;
use parking_lot::RwLock;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Once;
use std::time::Duration;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use tracing_subscriber::EnvFilter;

static RUSTLS_PROVIDER_INIT: Once = Once::new();
const TRAY_ICON_ID: &str = "main";
const TRAY_OPEN_MENU_ID: &str = "tray_open_main";
const TRAY_HOME_MENU_ID: &str = "tray_home";
const TRAY_SETTINGS_MENU_ID: &str = "tray_settings";
const TRAY_QUIT_MENU_ID: &str = "tray_quit";

#[derive(Debug, Clone, PartialEq, Eq)]
struct IrisPaths {
    shell_data_dir: PathBuf,
    htree_config_dir: PathBuf,
    htree_data_dir: PathBuf,
}

pub fn ensure_rustls_provider() {
    RUSTLS_PROVIDER_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn daemon_bind_address() -> String {
    if let Ok(bind) = std::env::var("IRIS_DAEMON_BIND") {
        let trimmed = bind.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    if let Ok(port) = std::env::var("IRIS_DAEMON_PORT") {
        let trimmed = port.trim();
        if !trimmed.is_empty() {
            return format!("127.0.0.1:{}", trimmed);
        }
    }

    "127.0.0.1:21417".to_string()
}

fn env_path(var: &str) -> Option<PathBuf> {
    let value = std::env::var(var).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn resolve_iris_paths(
    shell_data_dir: PathBuf,
    env_config_dir: Option<PathBuf>,
    env_data_dir: Option<PathBuf>,
    shared_config_dir: PathBuf,
    shared_data_dir: PathBuf,
) -> IrisPaths {
    IrisPaths {
        shell_data_dir,
        htree_config_dir: env_config_dir.unwrap_or(shared_config_dir),
        htree_data_dir: env_data_dir.unwrap_or(shared_data_dir),
    }
}

/// Start the embedded htree daemon
async fn start_daemon<R: tauri::Runtime + 'static>(
    app: AppHandle<R>,
    data_dir: PathBuf,
) -> Result<EmbeddedDaemonInfo, String> {
    relay_proxy::init_relay_proxy_state();

    let bind_address = daemon_bind_address();
    let mut config =
        hashtree_cli::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    config.storage.data_dir = data_dir.to_string_lossy().to_string();
    config.server.bind_address = bind_address.clone();
    config.server.enable_auth = false;
    config.server.stun_port = 0;

    // Add extra routes for relay proxy and NIP-07
    let app_for_webview_bridge = app.clone();
    let extra_routes = Router::<AppState>::new()
        .route("/relay", any(relay_proxy::handle_relay_websocket))
        .route(
            "/__iris_nip07",
            post(|body: Bytes| async move { nip07::handle_nip07_http_bridge(body).await }),
        )
        .route(
            "/__iris_webview",
            post(move |headers: HeaderMap, body: Bytes| {
                let app = app_for_webview_bridge.clone();
                async move { nip07::handle_webview_event_http_bridge(app, headers, body).await }
            }),
        );

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
        bind_address,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayConnectionStatus {
    Starting,
    Running { connected_peers: Option<usize> },
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TrayMenuItemSpec {
    Text {
        id: Option<String>,
        text: String,
        enabled: bool,
    },
    Separator,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayRuntimeState {
    connection_status: TrayConnectionStatus,
}

impl Default for TrayRuntimeState {
    fn default() -> Self {
        Self {
            connection_status: TrayConnectionStatus::Starting,
        }
    }
}

struct TrayState {
    runtime: RwLock<TrayRuntimeState>,
}

impl TrayState {
    fn new() -> Self {
        Self {
            runtime: RwLock::new(TrayRuntimeState::default()),
        }
    }

    fn snapshot(&self) -> TrayRuntimeState {
        self.runtime.read().clone()
    }

    fn set_connection_status(&self, connection_status: TrayConnectionStatus) -> bool {
        let mut runtime = self.runtime.write();
        if runtime.connection_status == connection_status {
            return false;
        }
        runtime.connection_status = connection_status;
        true
    }
}

#[derive(Debug, Deserialize, Default)]
struct TrayPeersResponse {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    connected: usize,
}

fn tray_connection_status_from_peers(response: TrayPeersResponse) -> TrayConnectionStatus {
    let connected_peers = if response.enabled {
        Some(response.connected)
    } else {
        None
    };
    TrayConnectionStatus::Running { connected_peers }
}

fn tray_status_text(connection_status: TrayConnectionStatus) -> String {
    match connection_status {
        TrayConnectionStatus::Starting => "Starting daemon...".to_string(),
        TrayConnectionStatus::Running {
            connected_peers: None,
        } => "Daemon running".to_string(),
        TrayConnectionStatus::Running {
            connected_peers: Some(1),
        } => "Daemon running, 1 peer connected".to_string(),
        TrayConnectionStatus::Running {
            connected_peers: Some(connected_peers),
        } => format!("Daemon running, {} peers connected", connected_peers),
        TrayConnectionStatus::Failed => "Daemon failed to start".to_string(),
    }
}

fn tray_menu_spec(connection_status: TrayConnectionStatus) -> Vec<TrayMenuItemSpec> {
    vec![
        TrayMenuItemSpec::Text {
            id: None,
            text: tray_status_text(connection_status),
            enabled: false,
        },
        TrayMenuItemSpec::Separator,
        TrayMenuItemSpec::Text {
            id: Some(TRAY_OPEN_MENU_ID.to_string()),
            text: "Open Iris".to_string(),
            enabled: true,
        },
        TrayMenuItemSpec::Text {
            id: Some(TRAY_HOME_MENU_ID.to_string()),
            text: "Home".to_string(),
            enabled: true,
        },
        TrayMenuItemSpec::Text {
            id: Some(TRAY_SETTINGS_MENU_ID.to_string()),
            text: "Settings".to_string(),
            enabled: true,
        },
        TrayMenuItemSpec::Separator,
        TrayMenuItemSpec::Text {
            id: Some(TRAY_QUIT_MENU_ID.to_string()),
            text: "Quit".to_string(),
            enabled: true,
        },
    ]
}

fn append_tray_spec_to_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    menu: &Menu<R>,
    spec: &TrayMenuItemSpec,
) -> tauri::Result<()> {
    match spec {
        TrayMenuItemSpec::Text { id, text, enabled } => {
            let item = if let Some(id) = id {
                MenuItemBuilder::with_id(id.clone(), text)
                    .enabled(*enabled)
                    .build(app)?
            } else {
                MenuItemBuilder::new(text).enabled(*enabled).build(app)?
            };
            menu.append(&item)?;
        }
        TrayMenuItemSpec::Separator => {
            let separator = PredefinedMenuItem::separator(app)?;
            menu.append(&separator)?;
        }
    }

    Ok(())
}

fn build_tray_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    connection_status: TrayConnectionStatus,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for spec in tray_menu_spec(connection_status) {
        append_tray_spec_to_menu(app, &menu, &spec)?;
    }
    Ok(menu)
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let _ = window.unminimize();
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn hide_main_window_to_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.minimize();
    let _ = window.hide();
}

fn started_minimized() -> bool {
    std::env::args().any(|arg| arg == "--minimized")
}

fn emit_tray_action<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: automation::AutomationAction,
) {
    let _ = app.emit(
        "automation-command",
        automation::AutomationCommand { action, url: None },
    );
}

fn current_tray_connection_status<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> TrayConnectionStatus {
    app.try_state::<Arc<TrayState>>()
        .map(|state| state.snapshot().connection_status)
        .unwrap_or(TrayConnectionStatus::Starting)
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn refresh_tray_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return;
    };

    let connection_status = current_tray_connection_status(app);
    let status_text = tray_status_text(connection_status);

    if let Ok(menu) = build_tray_menu(app, connection_status) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(status_text));
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn update_tray_connection_status<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    connection_status: TrayConnectionStatus,
) {
    let Some(state) = app.try_state::<Arc<TrayState>>() else {
        return;
    };
    if !state.set_connection_status(connection_status) {
        return;
    }

    let refresh_app = app.clone();
    let _ = app.run_on_main_thread(move || refresh_tray_menu(&refresh_app));
}

fn fetch_tray_connection_status(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Option<TrayConnectionStatus> {
    let response = client.get(url).send().ok()?;
    let status = response.json::<TrayPeersResponse>().ok()?;
    Some(tray_connection_status_from_peers(status))
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn spawn_tray_status_poller<R: tauri::Runtime + 'static>(app: tauri::AppHandle<R>, port: u16) {
    std::thread::spawn(move || {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                tracing::warn!("Failed to build tray status client: {}", error);
                return;
            }
        };
        let url = format!("http://127.0.0.1:{}/api/peers", port);

        loop {
            let connection_status = fetch_tray_connection_status(&client, &url).unwrap_or(
                TrayConnectionStatus::Running {
                    connected_peers: None,
                },
            );
            update_tray_connection_status(&app, connection_status);
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

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
                .unwrap_or_else(|_| EnvFilter::new("iris=info,hashtree_cli::server=info")),
        )
        .init();

    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_main_window(app);
        }));
    }

    builder
        .menu(build_menu)
        .on_tray_icon_event(|app, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    let _ = show_main_window(app);
                }
            }
        })
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
                TRAY_OPEN_MENU_ID => {
                    let _ = show_main_window(app);
                }
                TRAY_HOME_MENU_ID => {
                    let _ = show_main_window(app);
                    emit_tray_action(app, automation::AutomationAction::Home);
                }
                TRAY_SETTINGS_MENU_ID => {
                    let _ = show_main_window(app);
                    emit_tray_action(app, automation::AutomationAction::Settings);
                }
                TRAY_QUIT_MENU_ID => {
                    app.exit(0);
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
            automation::automation_update_state,
            automation::automation_get_state,
            automation::automation_shutdown,
            htree_protocol::get_htree_server_url,
            htree_protocol::cache_tree_root,
            nip07::create_nip07_webview,
            nip07::create_htree_webview,
            nip07::close_webview,
            nip07::navigate_webview,
            nip07::set_webview_bounds,
            nip07::webview_history,
            nip07::reload_webview,
            nip07::webview_current_url,
            nip07::nip07_request,
            nip07::webview_event,
            history::record_history_visit,
            history::search_history,
            history::get_recent_history,
            history::delete_history_entry,
            history::clear_history
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
            let paths = resolve_iris_paths(
                app.path()
                    .app_data_dir()
                    .expect("failed to get app data dir"),
                env_path("HTREE_CONFIG_DIR"),
                env_path("HTREE_DATA_DIR"),
                hashtree_cli::config::get_hashtree_dir(),
                PathBuf::from(
                    hashtree_cli::Config::load()
                        .unwrap_or_default()
                        .storage
                        .data_dir,
                ),
            );

            std::fs::create_dir_all(&paths.shell_data_dir)
                .expect("failed to create iris shell data dir");
            std::fs::create_dir_all(&paths.htree_config_dir)
                .expect("failed to create shared htree config dir");
            std::fs::create_dir_all(&paths.htree_data_dir)
                .expect("failed to create shared htree data dir");

            info!("Iris shell data directory: {:?}", paths.shell_data_dir);
            info!("Hashtree config directory: {:?}", paths.htree_config_dir);
            info!("Hashtree data directory: {:?}", paths.htree_data_dir);

            std::env::set_var("HTREE_CONFIG_DIR", &paths.htree_config_dir);
            std::env::set_var("HTREE_DATA_DIR", &paths.htree_data_dir);

            // Initialize NIP-07 permission state
            let permission_store = Arc::new(permissions::PermissionStore::new(None));
            let nip07_state = Arc::new(nip07::Nip07State::new(permission_store));
            nip07::init_global_state(nip07_state.clone());
            app.manage(nip07_state);

            // Initialize history store
            let history_store = Arc::new(
                history::HistoryStore::new(&paths.shell_data_dir)
                    .expect("failed to initialize history store"),
            );
            app.manage(history_store);

            let tray_state = Arc::new(TrayState::new());
            app.manage(tray_state);

            let automation_state = Arc::new(automation::AutomationState::new(
                automation::automation_requested(),
            ));
            automation::maybe_start_server(app.handle().clone(), automation_state.clone());
            app.manage(automation_state);

            // Start the embedded htree daemon
            let daemon_data_dir = paths.htree_data_dir.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match start_daemon(app_handle.clone(), daemon_data_dir).await {
                    Ok(info) => {
                        htree_protocol::set_daemon_port(info.port);
                        htree_protocol::set_self_npub(info.npub.clone());
                        info!("Embedded daemon started on port {}", info.port);
                        update_tray_connection_status(
                            &app_handle,
                            TrayConnectionStatus::Running {
                                connected_peers: None,
                            },
                        );
                        spawn_tray_status_poller(app_handle.clone(), info.port);
                    }
                    Err(e) => {
                        tracing::error!("Failed to start embedded daemon: {}", e);
                        update_tray_connection_status(&app_handle, TrayConnectionStatus::Failed);
                    }
                }
            });

            #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
            {
                if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
                    let _ = tray.set_show_menu_on_left_click(false);
                }
                refresh_tray_menu(app.handle());

                if started_minimized() {
                    hide_main_window_to_tray(app.handle());
                    info!("Started hidden in tray (autostart)");
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
    use super::{
        build_menu, resolve_iris_paths, tray_connection_status_from_peers, tray_menu_spec,
        tray_status_text, IrisPaths, TrayConnectionStatus, TrayMenuItemSpec, TrayPeersResponse,
    };
    use std::path::PathBuf;

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

    #[test]
    fn tray_status_text_covers_starting_running_and_failure_states() {
        assert_eq!(
            tray_status_text(TrayConnectionStatus::Starting),
            "Starting daemon..."
        );
        assert_eq!(
            tray_status_text(TrayConnectionStatus::Running {
                connected_peers: None,
            }),
            "Daemon running"
        );
        assert_eq!(
            tray_status_text(TrayConnectionStatus::Running {
                connected_peers: Some(1),
            }),
            "Daemon running, 1 peer connected"
        );
        assert_eq!(
            tray_status_text(TrayConnectionStatus::Running {
                connected_peers: Some(3),
            }),
            "Daemon running, 3 peers connected"
        );
        assert_eq!(
            tray_status_text(TrayConnectionStatus::Failed),
            "Daemon failed to start"
        );
    }

    #[test]
    fn tray_menu_spec_stays_small_and_action_focused() {
        let items = tray_menu_spec(TrayConnectionStatus::Running {
            connected_peers: Some(2),
        });

        assert_eq!(
            items,
            vec![
                TrayMenuItemSpec::Text {
                    id: None,
                    text: "Daemon running, 2 peers connected".to_string(),
                    enabled: false,
                },
                TrayMenuItemSpec::Separator,
                TrayMenuItemSpec::Text {
                    id: Some("tray_open_main".to_string()),
                    text: "Open Iris".to_string(),
                    enabled: true,
                },
                TrayMenuItemSpec::Text {
                    id: Some("tray_home".to_string()),
                    text: "Home".to_string(),
                    enabled: true,
                },
                TrayMenuItemSpec::Text {
                    id: Some("tray_settings".to_string()),
                    text: "Settings".to_string(),
                    enabled: true,
                },
                TrayMenuItemSpec::Separator,
                TrayMenuItemSpec::Text {
                    id: Some("tray_quit".to_string()),
                    text: "Quit".to_string(),
                    enabled: true,
                },
            ]
        );
    }

    #[test]
    fn tray_connection_status_uses_peer_endpoint_shape() {
        assert_eq!(
            tray_connection_status_from_peers(TrayPeersResponse {
                enabled: true,
                connected: 4,
            }),
            TrayConnectionStatus::Running {
                connected_peers: Some(4),
            }
        );
        assert_eq!(
            tray_connection_status_from_peers(TrayPeersResponse {
                enabled: false,
                connected: 99,
            }),
            TrayConnectionStatus::Running {
                connected_peers: None,
            }
        );
    }

    #[test]
    fn resolve_iris_paths_keeps_shell_state_separate_from_shared_hashtree_paths() {
        let paths = resolve_iris_paths(
            PathBuf::from("/tmp/iris"),
            None,
            None,
            PathBuf::from("/home/test/.hashtree"),
            PathBuf::from("/home/test/.hashtree/data"),
        );

        assert_eq!(
            paths,
            IrisPaths {
                shell_data_dir: PathBuf::from("/tmp/iris"),
                htree_config_dir: PathBuf::from("/home/test/.hashtree"),
                htree_data_dir: PathBuf::from("/home/test/.hashtree/data"),
            }
        );
    }

    #[test]
    fn resolve_iris_paths_respects_explicit_htree_overrides() {
        let paths = resolve_iris_paths(
            PathBuf::from("/tmp/iris"),
            Some(PathBuf::from("/tmp/htree-config")),
            Some(PathBuf::from("/tmp/htree-data")),
            PathBuf::from("/home/test/.hashtree"),
            PathBuf::from("/home/test/.hashtree/data"),
        );

        assert_eq!(
            paths,
            IrisPaths {
                shell_data_dir: PathBuf::from("/tmp/iris"),
                htree_config_dir: PathBuf::from("/tmp/htree-config"),
                htree_data_dir: PathBuf::from("/tmp/htree-data"),
            }
        );
    }
}
