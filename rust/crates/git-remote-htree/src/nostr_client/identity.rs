use anyhow::{Context, Result};
use nostr_sdk::prelude::{Keys, PublicKey, SecretKey, ToBech32};
use tracing::{debug, info};

/// A stored key with optional petname
#[derive(Debug, Clone)]
pub struct StoredKey {
    /// Secret key in hex format, when this identity can sign
    pub secret_hex: Option<String>,
    /// Public key in hex format
    pub pubkey_hex: String,
    /// Optional petname (e.g., "default", "work")
    pub petname: Option<String>,
}

/// Identities grouped by their source file.
#[derive(Debug, Clone, Default)]
pub struct StoredKeyLists {
    /// Identities loaded from `~/.hashtree/keys`.
    pub keys_file_entries: Vec<StoredKey>,
    /// Public read-only identities loaded from `~/.hashtree/aliases`.
    pub alias_file_entries: Vec<StoredKey>,
}

impl StoredKey {
    /// Create from secret key hex, deriving pubkey
    pub fn from_secret_hex(secret_hex: &str, petname: Option<String>) -> Result<Self> {
        use secp256k1::{Secp256k1, SecretKey as SecpSecretKey};

        let sk_bytes = hex::decode(secret_hex).context("Invalid hex in secret key")?;
        let sk = SecpSecretKey::from_slice(&sk_bytes).context("Invalid secret key")?;
        let secp = Secp256k1::new();
        let pk = sk.x_only_public_key(&secp).0;
        let pubkey_hex = hex::encode(pk.serialize());

        Ok(Self {
            secret_hex: Some(secret_hex.to_string()),
            pubkey_hex,
            petname,
        })
    }

    /// Create from nsec bech32 format
    pub fn from_nsec(nsec: &str, petname: Option<String>) -> Result<Self> {
        let secret_key =
            SecretKey::parse(nsec).map_err(|e| anyhow::anyhow!("Invalid nsec format: {}", e))?;
        let secret_hex = hex::encode(secret_key.to_secret_bytes());
        Self::from_secret_hex(&secret_hex, petname)
    }

    /// Create from pubkey hex without a signing key
    pub fn from_pubkey_hex(pubkey_hex: &str, petname: Option<String>) -> Result<Self> {
        let pubkey = PublicKey::from_hex(pubkey_hex)
            .map_err(|e| anyhow::anyhow!("Invalid pubkey hex: {}", e))?;

        Ok(Self {
            secret_hex: None,
            pubkey_hex: hex::encode(pubkey.to_bytes()),
            petname,
        })
    }

    /// Create from npub bech32 format without a signing key
    pub fn from_npub(npub: &str, petname: Option<String>) -> Result<Self> {
        let pubkey =
            PublicKey::parse(npub).map_err(|e| anyhow::anyhow!("Invalid npub format: {}", e))?;

        Ok(Self {
            secret_hex: None,
            pubkey_hex: hex::encode(pubkey.to_bytes()),
            petname,
        })
    }
}

#[derive(Clone, Copy)]
enum IdentityFileKind {
    Keys,
    Aliases,
}

fn ensure_aliases_file_hint() {
    let aliases_path = hashtree_config::get_aliases_path();
    if aliases_path.exists() {
        return;
    }

    let Some(parent) = aliases_path.parent() else {
        return;
    };

    if !parent.exists() {
        return;
    }

    let template = format!(
        "# Public read-only aliases for repos you clone or fetch.\n# Format: npub1... alias\n{} {}\n",
        hashtree_config::DEFAULT_SOCIALGRAPH_ENTRYPOINT_NPUB,
        hashtree_config::DEFAULT_SOCIALGRAPH_ENTRYPOINT_ALIAS
    );

    let _ = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&aliases_path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, template.as_bytes()));
}

fn parse_identity_entry(
    raw: &str,
    petname: Option<String>,
    kind: IdentityFileKind,
) -> Option<StoredKey> {
    let key = match kind {
        IdentityFileKind::Keys => {
            if raw.starts_with("nsec1") {
                StoredKey::from_nsec(raw, petname)
            } else if raw.starts_with("npub1") {
                StoredKey::from_npub(raw, petname)
            } else if raw.len() == 64 {
                StoredKey::from_secret_hex(raw, petname)
            } else {
                return None;
            }
        }
        IdentityFileKind::Aliases => {
            if raw.starts_with("npub1") {
                StoredKey::from_npub(raw, petname)
            } else if raw.len() == 64 {
                StoredKey::from_pubkey_hex(raw, petname)
            } else {
                return None;
            }
        }
    };

    key.ok()
}

fn load_identities_from_path(path: &std::path::Path, kind: IdentityFileKind) -> Vec<StoredKey> {
    let mut keys = Vec::new();

    if let Ok(content) = std::fs::read_to_string(path) {
        for entry in hashtree_config::parse_keys_file(&content) {
            if let Some(key) = parse_identity_entry(&entry.secret, entry.alias, kind) {
                debug!(
                    "Loaded identity: pubkey={}, petname={:?}, has_secret={}",
                    key.pubkey_hex,
                    key.petname,
                    key.secret_hex.is_some()
                );
                keys.push(key);
            }
        }
    }

    keys
}

pub fn resolve_self_identity(keys: &[StoredKey]) -> Option<(String, Option<String>)> {
    keys.iter()
        .find(|k| k.petname.as_deref() == Some("self") && k.secret_hex.is_some())
        .or_else(|| {
            keys.iter()
                .find(|k| k.petname.as_deref() == Some("default") && k.secret_hex.is_some())
        })
        .or_else(|| keys.iter().find(|k| k.secret_hex.is_some()))
        .map(|key| (key.pubkey_hex.clone(), key.secret_hex.clone()))
}

/// Load identities from config files, grouped by source.
pub fn load_key_lists() -> StoredKeyLists {
    ensure_aliases_file_hint();

    StoredKeyLists {
        keys_file_entries: load_identities_from_path(
            &hashtree_config::get_keys_path(),
            IdentityFileKind::Keys,
        ),
        alias_file_entries: load_identities_from_path(
            &hashtree_config::get_aliases_path(),
            IdentityFileKind::Aliases,
        ),
    }
}

/// Load all keys from config files
pub fn load_keys() -> Vec<StoredKey> {
    let lists = load_key_lists();
    let mut keys = lists.keys_file_entries;
    keys.extend(lists.alias_file_entries);
    keys
}

/// Resolve an identifier to (pubkey_hex, secret_hex)
/// Identifier can be:
/// - "self" (uses default key, auto-generates if needed)
/// - petname (e.g., "work", "default")
/// - pubkey hex (64 chars)
/// - npub bech32
pub fn resolve_identity(identifier: &str) -> Result<(String, Option<String>)> {
    let keys = load_keys();

    if identifier == "self" {
        if let Some(resolved) = resolve_self_identity(&keys) {
            return Ok(resolved);
        }
        let new_key = generate_and_save_key("self")?;
        info!("Generated new identity: npub1{}", &new_key.pubkey_hex[..12]);
        return Ok((new_key.pubkey_hex, new_key.secret_hex));
    }

    for key in &keys {
        if key.petname.as_deref() == Some(identifier) {
            return Ok((key.pubkey_hex.clone(), key.secret_hex.clone()));
        }
    }

    if identifier.starts_with("npub1") {
        let pk = PublicKey::parse(identifier)
            .map_err(|e| anyhow::anyhow!("Invalid npub format: {}", e))?;
        let pubkey_hex = hex::encode(pk.to_bytes());

        let secret = keys
            .iter()
            .find(|k| k.pubkey_hex == pubkey_hex)
            .and_then(|k| k.secret_hex.clone());

        return Ok((pubkey_hex, secret));
    }

    if identifier.len() == 64 && hex::decode(identifier).is_ok() {
        let secret = keys
            .iter()
            .find(|k| k.pubkey_hex == identifier)
            .and_then(|k| k.secret_hex.clone());

        return Ok((identifier.to_string(), secret));
    }

    anyhow::bail!(
        "Unknown identity '{}'. Add it to ~/.hashtree/aliases (preferred) or ~/.hashtree/keys, or use a pubkey/npub.",
        identifier
    )
}

/// Generate a new key and save it to ~/.hashtree/keys with the given petname
fn generate_and_save_key(petname: &str) -> Result<StoredKey> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;

    let keys = Keys::generate();
    let secret_hex = hex::encode(keys.secret_key().to_secret_bytes());
    let pubkey_hex = hex::encode(keys.public_key().to_bytes());

    let keys_path = hashtree_config::get_keys_path();
    if let Some(parent) = keys_path.parent() {
        fs::create_dir_all(parent)?;
    }
    ensure_aliases_file_hint();

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&keys_path)?;

    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|e| anyhow::anyhow!("Failed to encode nsec: {}", e))?;
    writeln!(file, "{} {}", nsec, petname)?;

    info!(
        "Saved new key to {:?} with petname '{}'",
        keys_path, petname
    );

    Ok(StoredKey {
        secret_hex: Some(secret_hex),
        pubkey_hex,
        petname: Some(petname.to_string()),
    })
}
