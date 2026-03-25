use tracing::{info, warn};

/// Configuration for the optional Bluetooth peer transport.
#[derive(Debug, Clone)]
pub struct BluetoothConfig {
    pub enabled: bool,
    pub max_peers: usize,
}

impl BluetoothConfig {
    pub fn is_enabled(&self) -> bool {
        self.enabled && self.max_peers > 0
    }
}

impl Default for BluetoothConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_peers: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BluetoothBackendState {
    Disabled,
    Unsupported,
}

/// Placeholder native Bluetooth backend.
///
/// The daemon can safely construct and start this on any host. Until the
/// radio-specific implementation lands, enabling Bluetooth just emits a clear
/// warning and leaves the rest of the daemon running.
pub struct BluetoothMesh {
    config: BluetoothConfig,
}

impl BluetoothMesh {
    pub fn new(config: BluetoothConfig) -> Self {
        Self { config }
    }

    pub async fn start(&self) -> BluetoothBackendState {
        if !self.config.is_enabled() {
            info!("Bluetooth transport disabled");
            return BluetoothBackendState::Disabled;
        }

        warn!(
            "Bluetooth transport requested (max_peers={}) but no native backend is implemented for this build yet",
            self.config.max_peers
        );
        BluetoothBackendState::Unsupported
    }
}
