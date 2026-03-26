#[cfg(target_os = "android")]
use async_trait::async_trait;
#[cfg(target_os = "android")]
use hashtree_cli::webrtc::{
    install_mobile_bluetooth_bridge, BluetoothFrame, BluetoothLink, MobileBluetoothBridge,
    PeerDirection, PendingBluetoothLink,
};
#[cfg(target_os = "android")]
use std::collections::HashMap;
#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "android")]
use std::sync::Arc;
#[cfg(target_os = "android")]
use std::sync::Mutex as StdMutex;
#[cfg(target_os = "android")]
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri_plugin_iris_mobile_bluetooth::{
    MobileBluetooth, MobileBluetoothEvent, MobileBluetoothExt,
};
#[cfg(target_os = "android")]
use tokio::sync::{mpsc, Mutex};
#[cfg(target_os = "android")]
use tracing::{debug, info, warn};

#[cfg(target_os = "android")]
struct LinkEntry<R: Runtime> {
    link: Arc<PluginBluetoothLink<R>>,
    pending_emitted: bool,
}

#[cfg(target_os = "android")]
static PRESTARTED_PEER_ID: OnceLock<StdMutex<Option<String>>> = OnceLock::new();

#[cfg(target_os = "android")]
fn prestarted_peer_id() -> &'static StdMutex<Option<String>> {
    PRESTARTED_PEER_ID.get_or_init(|| StdMutex::new(None))
}

#[cfg(target_os = "android")]
fn remember_prestarted_peer_id(peer_id: String) {
    if let Ok(mut slot) = prestarted_peer_id().lock() {
        *slot = Some(peer_id);
    }
}

#[cfg(target_os = "android")]
fn matches_prestarted_peer_id(peer_id: &str) -> bool {
    prestarted_peer_id()
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .as_deref()
        == Some(peer_id)
}

#[cfg(target_os = "android")]
struct BridgeState<R: Runtime> {
    bluetooth: MobileBluetooth<R>,
    links: Mutex<HashMap<String, LinkEntry<R>>>,
}

#[cfg(target_os = "android")]
impl<R: Runtime> BridgeState<R> {
    fn new(bluetooth: MobileBluetooth<R>) -> Self {
        Self {
            bluetooth,
            links: Mutex::new(HashMap::new()),
        }
    }

    async fn ensure_link(&self, address: &str) -> Arc<PluginBluetoothLink<R>> {
        let mut links = self.links.lock().await;
        links
            .entry(address.to_string())
            .or_insert_with(|| LinkEntry {
                link: PluginBluetoothLink::new(address.to_string(), self.bluetooth.clone()),
                pending_emitted: false,
            })
            .link
            .clone()
    }

    async fn remove_link(&self, address: &str) -> Option<Arc<PluginBluetoothLink<R>>> {
        self.links
            .lock()
            .await
            .remove(address)
            .map(|entry| entry.link)
    }
}

#[cfg(target_os = "android")]
#[derive(Clone)]
struct AndroidMobileBluetoothBridge<R: Runtime> {
    state: Arc<BridgeState<R>>,
}

#[cfg(target_os = "android")]
impl<R: Runtime> AndroidMobileBluetoothBridge<R> {
    fn new(bluetooth: MobileBluetooth<R>) -> Self {
        Self {
            state: Arc::new(BridgeState::new(bluetooth)),
        }
    }
}

#[cfg(target_os = "android")]
#[async_trait]
impl<R> MobileBluetoothBridge for AndroidMobileBluetoothBridge<R>
where
    R: Runtime + 'static,
{
    async fn start(
        &self,
        local_peer_id: String,
    ) -> anyhow::Result<mpsc::Receiver<PendingBluetoothLink>> {
        let (pending_tx, pending_rx) = mpsc::channel::<PendingBluetoothLink>(32);
        let mut events = self.state.bluetooth.subscribe();
        let state = self.state.clone();
        let pending_tx_for_events = pending_tx.clone();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        if let Err(error) =
                            handle_mobile_event(state.clone(), &pending_tx_for_events, event).await
                        {
                            warn!("Android Bluetooth bridge event failed: {}", error);
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!("Android Bluetooth bridge lagged by {} events", skipped);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        info!(
            "Starting Android Bluetooth bridge for peer {}",
            local_peer_id
        );
        if matches_prestarted_peer_id(&local_peer_id) {
            info!("Android Bluetooth bridge already prestarted");
        } else {
            self.state
                .bluetooth
                .start(local_peer_id.clone())
                .map_err(anyhow::Error::msg)?;
            remember_prestarted_peer_id(local_peer_id.clone());
            info!("Android Bluetooth bridge start command accepted");
        }

        for peer in self
            .state
            .bluetooth
            .list_peers()
            .map_err(anyhow::Error::msg)?
        {
            if peer.ready {
                emit_pending_link(self.state.clone(), &pending_tx, peer.address).await;
            }
        }

        Ok(pending_rx)
    }
}

#[cfg(target_os = "android")]
async fn handle_mobile_event<R: Runtime>(
    state: Arc<BridgeState<R>>,
    pending_tx: &mpsc::Sender<PendingBluetoothLink>,
    event: MobileBluetoothEvent,
) -> anyhow::Result<()> {
    match event {
        MobileBluetoothEvent::PeerConnected { address } => {
            emit_pending_link(state.clone(), pending_tx, address.clone()).await;
            debug!("Android BLE peer connected: {}", address);
        }
        MobileBluetoothEvent::PeerReady { address } => {
            emit_pending_link(state.clone(), pending_tx, address).await;
        }
        MobileBluetoothEvent::PeerDisconnected { address } => {
            if let Some(link) = state.remove_link(&address).await {
                let _ = link.close().await;
            }
            debug!("Android BLE peer disconnected: {}", address);
        }
        MobileBluetoothEvent::Frame {
            address,
            kind,
            payload,
        } => {
            let frame = match kind.as_str() {
                "text" => match String::from_utf8(payload) {
                    Ok(text) => BluetoothFrame::Text(text),
                    Err(error) => {
                        warn!(
                            "Discarding invalid UTF-8 BLE text frame from {}: {}",
                            address, error
                        );
                        return Ok(());
                    }
                },
                "binary" => BluetoothFrame::Binary(payload),
                other => {
                    warn!(
                        "Discarding unknown BLE frame kind from {}: {}",
                        address, other
                    );
                    return Ok(());
                }
            };
            state.ensure_link(&address).await.enqueue(frame).await;
        }
    }
    Ok(())
}

#[cfg(target_os = "android")]
async fn emit_pending_link<R: Runtime>(
    state: Arc<BridgeState<R>>,
    pending_tx: &mpsc::Sender<PendingBluetoothLink>,
    address: String,
) {
    let mut links = state.links.lock().await;
    let entry = links.entry(address.clone()).or_insert_with(|| LinkEntry {
        link: PluginBluetoothLink::new(address.clone(), state.bluetooth.clone()),
        pending_emitted: false,
    });
    if entry.pending_emitted {
        return;
    }
    entry.pending_emitted = true;
    let pending = PendingBluetoothLink {
        link: entry.link.clone() as Arc<dyn BluetoothLink>,
        direction: PeerDirection::Inbound,
        // Android exposes hello through the readable TX characteristic immediately on connect.
        local_hello_sent: true,
        peer_hint: Some(address),
    };
    drop(links);
    let _ = pending_tx.send(pending).await;
}

#[cfg(target_os = "android")]
struct PluginBluetoothLink<R: Runtime> {
    address: String,
    bluetooth: MobileBluetooth<R>,
    inbound_tx: mpsc::Sender<BluetoothFrame>,
    inbound_rx: Mutex<mpsc::Receiver<BluetoothFrame>>,
    open: AtomicBool,
}

#[cfg(target_os = "android")]
impl<R: Runtime> PluginBluetoothLink<R> {
    fn new(address: String, bluetooth: MobileBluetooth<R>) -> Arc<Self> {
        let (inbound_tx, inbound_rx) = mpsc::channel(64);
        Arc::new(Self {
            address,
            bluetooth,
            inbound_tx,
            inbound_rx: Mutex::new(inbound_rx),
            open: AtomicBool::new(true),
        })
    }

    async fn enqueue(&self, frame: BluetoothFrame) {
        if !self.open.load(Ordering::Relaxed) {
            return;
        }
        let _ = self.inbound_tx.send(frame).await;
    }
}

#[cfg(target_os = "android")]
#[async_trait]
impl<R> BluetoothLink for PluginBluetoothLink<R>
where
    R: Runtime + 'static,
{
    async fn send(&self, frame: BluetoothFrame) -> anyhow::Result<()> {
        if !self.is_open() {
            return Ok(());
        }
        let (kind, payload) = match frame {
            BluetoothFrame::Text(text) => ("text".to_string(), text.into_bytes()),
            BluetoothFrame::Binary(payload) => ("binary".to_string(), payload),
        };
        self.bluetooth
            .send_frame(self.address.clone(), kind, payload)
            .map_err(anyhow::Error::msg)
    }

    async fn recv(&self) -> Option<BluetoothFrame> {
        self.inbound_rx.lock().await.recv().await
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::Relaxed)
    }

    async fn close(&self) -> anyhow::Result<()> {
        self.open.store(false, Ordering::Relaxed);
        self.inbound_rx.lock().await.close();
        Ok(())
    }
}

#[cfg(target_os = "android")]
pub fn install_from_app<R>(app: &AppHandle<R>) -> Result<(), String>
where
    R: Runtime + 'static,
{
    let bluetooth = app.mobile_bluetooth().clone();
    install_mobile_bluetooth_bridge(Arc::new(AndroidMobileBluetoothBridge::new(bluetooth)))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
pub fn prestart_from_app<R>(app: &AppHandle<R>, local_peer_id: String) -> Result<(), String>
where
    R: Runtime + 'static,
{
    app.mobile_bluetooth()
        .start(local_peer_id.clone())
        .map_err(|error| error.to_string())?;
    remember_prestarted_peer_id(local_peer_id);
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn install_from_app<R>(_app: &AppHandle<R>) -> Result<(), String>
where
    R: Runtime,
{
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn prestart_from_app<R>(_app: &AppHandle<R>, _local_peer_id: String) -> Result<(), String>
where
    R: Runtime,
{
    Ok(())
}
