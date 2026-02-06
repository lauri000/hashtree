use anyhow::{Context, Result};
use hashtree_cli::{
    Config, HashtreeStore, NostrKeys, NostrResolverConfig, NostrRootResolver, RootResolver,
};
use hashtree_fuse::{FsError as FuseFsError, HashtreeFuse, RootPublisher};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use super::resolve::{resolve_cid_input_with_opts, ResolveOptions};

struct MountVisibility {
    visibility: hashtree_core::TreeVisibility,
    link_key: Option<[u8; 32]>,
}

fn parse_mount_visibility(
    visibility: Option<String>,
    link_key: Option<String>,
    private: bool,
    fragment: Option<&str>,
) -> Result<MountVisibility> {
    use hashtree_core::TreeVisibility;

    let mut resolved_visibility: Option<TreeVisibility> = None;
    let mut resolved_link_key: Option<[u8; 32]> = None;

    if let Some(fragment) = fragment {
        if fragment == "private" {
            resolved_visibility = Some(TreeVisibility::Private);
        } else if fragment == "link-visible" {
            resolved_visibility = Some(TreeVisibility::LinkVisible);
        } else if let Some(hex_key) = fragment.strip_prefix("k=") {
            resolved_visibility = Some(TreeVisibility::LinkVisible);
            resolved_link_key = Some(
                hashtree_core::key_from_hex(hex_key)
                    .map_err(|e| anyhow::anyhow!("Invalid link key: {}", e))?,
            );
        }
    }

    if let Some(vis) = visibility {
        let parsed = TreeVisibility::from_str(&vis)
            .map_err(|e| anyhow::anyhow!("Invalid visibility: {}", e))?;
        if let Some(existing) = resolved_visibility {
            if existing != parsed {
                anyhow::bail!("Conflicting visibility options");
            }
        }
        resolved_visibility = Some(parsed);
    }

    if let Some(link_key) = link_key {
        let parsed = hashtree_core::key_from_hex(&link_key)
            .map_err(|e| anyhow::anyhow!("Invalid link key: {}", e))?;
        if let Some(existing) = resolved_link_key {
            if existing != parsed {
                anyhow::bail!("Conflicting link key options");
            }
        }
        resolved_link_key = Some(parsed);
        if let Some(existing) = resolved_visibility {
            if existing != TreeVisibility::LinkVisible {
                anyhow::bail!("Link key only applies to link-visible trees");
            }
        }
        resolved_visibility = Some(TreeVisibility::LinkVisible);
    }

    if private {
        if let Some(existing) = resolved_visibility {
            if existing != TreeVisibility::Private {
                anyhow::bail!("Conflicting visibility options");
            }
        }
        resolved_visibility = Some(TreeVisibility::Private);
    }

    let visibility = resolved_visibility.unwrap_or(TreeVisibility::Public);
    if visibility == TreeVisibility::LinkVisible && resolved_link_key.is_none() {
        anyhow::bail!("Link-visible trees require a link key");
    }
    if visibility == TreeVisibility::Private && resolved_link_key.is_some() {
        anyhow::bail!("Private trees cannot use a link key");
    }

    Ok(MountVisibility {
        visibility,
        link_key: resolved_link_key,
    })
}

struct NostrRootPublisher {
    resolver: NostrRootResolver,
    key: String,
    visibility: hashtree_core::TreeVisibility,
    link_key: Option<[u8; 32]>,
    store: Arc<HashtreeStore>,
    pubkey_hex: String,
    tree_name: String,
    handle: tokio::runtime::Handle,
}

impl RootPublisher for NostrRootPublisher {
    fn publish(&self, cid: &hashtree_core::Cid) -> Result<(), FuseFsError> {
        let visibility = self.visibility;
        let link_key = self.link_key;
        let key = self.key.clone();
        let resolver = &self.resolver;

        let published = self
            .handle
            .block_on(async move {
                match visibility {
                    hashtree_core::TreeVisibility::Public => resolver.publish(&key, cid).await,
                    hashtree_core::TreeVisibility::LinkVisible => {
                        let Some(link_key) = link_key else {
                            return Err(hashtree_cli::ResolverError::Other(
                                "Missing link key".into(),
                            ));
                        };
                        resolver.publish_shared(&key, cid, &link_key).await
                    }
                    hashtree_core::TreeVisibility::Private => {
                        resolver.publish_private(&key, cid).await
                    }
                }
            })
            .map_err(|e| FuseFsError::Publish(e.to_string()))?;

        if !published {
            return Err(FuseFsError::Publish("Publish returned false".into()));
        }

        let key_hex = cid.key.map(hex::encode);
        let updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.store
            .set_cached_root(
                &self.pubkey_hex,
                &self.tree_name,
                &hashtree_core::to_hex(&cid.hash),
                key_hex.as_deref(),
                self.visibility.as_str(),
                updated_at,
            )
            .map_err(|e| FuseFsError::Publish(e.to_string()))?;

        Ok(())
    }
}

pub(crate) async fn mount_fuse(
    target: String,
    mountpoint: PathBuf,
    visibility: Option<String>,
    link_key: Option<String>,
    private: bool,
    relays: Option<String>,
    allow_other: bool,
    data_dir: PathBuf,
) -> Result<()> {
    let target = target.strip_prefix("htree://").unwrap_or(&target);
    let (base, fragment) = match target.split_once('#') {
        Some((base, fragment)) => (base, Some(fragment)),
        None => (target, None),
    };

    let MountVisibility {
        visibility: mount_visibility,
        link_key: mount_link_key,
    } = parse_mount_visibility(visibility, link_key, private, fragment)?;

    let config = Config::load_or_default();
    let relays = if let Some(relays) = relays {
        relays.split(',').map(|s| s.trim().to_string()).collect()
    } else {
        config.nostr.relays.clone()
    };

    let mut opts = ResolveOptions::default();
    opts.link_key = mount_link_key;
    opts.private = mount_visibility == hashtree_core::TreeVisibility::Private;
    opts.relays = Some(relays);

    if opts.private {
        let keys =
            hashtree_cli::config::read_keys().context("Private mounts require a local nsec key")?;
        opts.secret_key = Some(keys);
    }

    let resolved = resolve_cid_input_with_opts(base, &opts).await?;

    let nostr_key = if base.starts_with("npub1") && base.contains('/') {
        let parts: Vec<&str> = base.splitn(3, '/').collect();
        if parts.len() >= 2 {
            Some(format!("{}/{}", parts[0], parts[1]))
        } else {
            None
        }
    } else {
        None
    };

    let max_size_bytes = config.storage.max_size_gb * 1024 * 1024 * 1024;
    let store = Arc::new(HashtreeStore::with_options(
        &data_dir,
        config.storage.s3.as_ref(),
        max_size_bytes,
    )?);
    let store_arc = store.store_arc();

    let mut root_cid = resolved.cid.clone();
    if let Some(path) = resolved.path.clone() {
        let tree =
            hashtree_core::HashTree::new(hashtree_core::HashTreeConfig::new(store_arc.clone()));
        let Some(path_cid) = tree.resolve(&root_cid, &path).await? else {
            anyhow::bail!("Path not found: {}", path);
        };
        let is_dir = tree.get_directory_node(&path_cid).await?.is_some();
        if !is_dir {
            anyhow::bail!("Path is not a directory: {}", path);
        }
        root_cid = path_cid;
    }

    let publisher = if let Some(nostr_key) = nostr_key {
        let keys = hashtree_cli::config::read_keys().context("Failed to read nostr keys")?;
        let mut resolver_config = NostrResolverConfig::default();
        if let Some(relays) = opts.relays.clone() {
            resolver_config.relays = relays;
        }
        resolver_config.secret_key = Some(keys.clone());
        let resolver = NostrRootResolver::new(resolver_config)
            .await
            .context("Failed to create nostr resolver")?;

        let (npub, tree_name) = nostr_key
            .split_once('/')
            .ok_or_else(|| anyhow::anyhow!("Invalid nostr key: {}", nostr_key))?;
        let pubkey_bytes = hashtree_cli::config::parse_npub(npub)?;
        if keys.public_key().to_bytes() != pubkey_bytes {
            anyhow::bail!("Nostr key does not match mounted npub");
        }
        let pubkey_hex = hex::encode(pubkey_bytes);

        Some(Arc::new(NostrRootPublisher {
            resolver,
            key: nostr_key,
            visibility: mount_visibility,
            link_key: mount_link_key,
            store: store.clone(),
            pubkey_hex,
            tree_name: tree_name.to_string(),
            handle: tokio::runtime::Handle::current(),
        }) as Arc<dyn RootPublisher>)
    } else {
        None
    };

    let fs = HashtreeFuse::new_with_publisher(store_arc, root_cid, publisher)?;
    let mut options = vec![
        fuser::MountOption::FSName("hashtree".to_string()),
        fuser::MountOption::DefaultPermissions,
    ];
    if allow_other {
        options.push(fuser::MountOption::AllowOther);
    }

    fs.mount(mountpoint, &options)?;
    Ok(())
}
