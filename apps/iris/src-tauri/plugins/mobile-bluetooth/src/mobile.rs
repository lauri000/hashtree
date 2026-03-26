use super::{MobileBluetooth, MobileBluetoothEvent};
use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};
use tokio::sync::broadcast;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "to.iris.browser.mobilebluetooth";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> tauri::Result<MobileBluetooth<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "MobileBluetoothPlugin")?;
    let (events, _) = broadcast::channel::<MobileBluetoothEvent>(256);
    Ok(MobileBluetooth { handle, events })
}
