//! Permission system for child webviews
//!
//! Tracks which apps have permission to perform sensitive operations.
//! Permissions are scoped per app origin (URL).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

/// Permission types for Nostr operations
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PermissionType {
    /// Get public key (always allowed - never exposes nsec)
    GetPublicKey,
    /// Sign an event
    SignEvent,
    /// Encrypt data (NIP-44)
    Encrypt,
    /// Decrypt data (NIP-44)
    Decrypt,
    /// Read events (with optional kind filter)
    ReadEvents { kinds: Option<Vec<u16>> },
    /// Publish events (with optional kind filter)
    PublishEvent { kinds: Option<Vec<u16>> },
}

/// Permission store - manages permission state
#[derive(Clone)]
pub struct PermissionStore {
    /// In-memory cache of permissions: app_origin -> (permission_type -> granted)
    cache: Arc<RwLock<HashMap<String, HashMap<PermissionType, bool>>>>,
    /// Path to persist permissions (optional)
    _storage_path: Option<PathBuf>,
}

impl PermissionStore {
    /// Create a new permission store
    pub fn new(storage_path: Option<PathBuf>) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            _storage_path: storage_path,
        }
    }

    /// Check if a permission is granted
    pub async fn is_granted(&self, app_origin: &str, permission_type: &PermissionType) -> Option<bool> {
        // GetPublicKey is always allowed
        if matches!(permission_type, PermissionType::GetPublicKey) {
            return Some(true);
        }

        let cache = self.cache.read().await;
        cache
            .get(app_origin)
            .and_then(|perms| perms.get(permission_type))
            .copied()
    }

    /// Check if we need to prompt for a permission
    pub async fn needs_prompt(&self, app_origin: &str, permission_type: &PermissionType) -> bool {
        if matches!(permission_type, PermissionType::GetPublicKey) {
            return false;
        }
        self.is_granted(app_origin, permission_type).await.is_none()
    }

    /// Grant a permission
    pub async fn grant(&self, app_origin: &str, permission_type: PermissionType, _persistent: bool) {
        info!("Granting permission {:?} to {}", permission_type, app_origin);
        let mut cache = self.cache.write().await;
        cache
            .entry(app_origin.to_string())
            .or_default()
            .insert(permission_type, true);
    }

    /// Deny a permission
    pub async fn deny(&self, app_origin: &str, permission_type: PermissionType, _persistent: bool) {
        info!("Denying permission {:?} to {}", permission_type, app_origin);
        let mut cache = self.cache.write().await;
        cache
            .entry(app_origin.to_string())
            .or_default()
            .insert(permission_type, false);
    }

    /// Revoke all permissions for an app
    pub async fn revoke_all(&self, app_origin: &str) {
        info!("Revoking all permissions for {}", app_origin);
        let mut cache = self.cache.write().await;
        cache.remove(app_origin);
    }

    /// Get all permissions for an app
    pub async fn get_permissions(&self, app_origin: &str) -> HashMap<PermissionType, bool> {
        let cache = self.cache.read().await;
        cache.get(app_origin).cloned().unwrap_or_default()
    }
}

impl Default for PermissionStore {
    fn default() -> Self {
        Self::new(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_public_key_always_granted() {
        let store = PermissionStore::new(None);
        let app = "http://example.com";
        assert_eq!(
            store.is_granted(app, &PermissionType::GetPublicKey).await,
            Some(true)
        );
        assert!(!store.needs_prompt(app, &PermissionType::GetPublicKey).await);
    }

    #[tokio::test]
    async fn test_sign_event_needs_prompt() {
        let store = PermissionStore::new(None);
        let app = "http://example.com";
        assert!(store.is_granted(app, &PermissionType::SignEvent).await.is_none());
        assert!(store.needs_prompt(app, &PermissionType::SignEvent).await);
    }

    #[tokio::test]
    async fn test_grant_permission() {
        let store = PermissionStore::new(None);
        let app = "http://example.com";
        store.grant(app, PermissionType::SignEvent, false).await;
        assert_eq!(
            store.is_granted(app, &PermissionType::SignEvent).await,
            Some(true)
        );
    }

    #[tokio::test]
    async fn test_permissions_scoped_by_app() {
        let store = PermissionStore::new(None);
        let app1 = "http://app1.com";
        let app2 = "http://app2.com";
        store.grant(app1, PermissionType::SignEvent, false).await;
        assert_eq!(
            store.is_granted(app1, &PermissionType::SignEvent).await,
            Some(true)
        );
        assert!(store.is_granted(app2, &PermissionType::SignEvent).await.is_none());
    }

    #[tokio::test]
    async fn test_revoke_all() {
        let store = PermissionStore::new(None);
        let app = "http://example.com";
        store.grant(app, PermissionType::SignEvent, false).await;
        store.grant(app, PermissionType::Encrypt, false).await;
        store.revoke_all(app).await;
        assert!(store.needs_prompt(app, &PermissionType::SignEvent).await);
        assert!(store.needs_prompt(app, &PermissionType::Encrypt).await);
    }
}
