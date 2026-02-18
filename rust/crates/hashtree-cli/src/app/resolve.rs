use anyhow::{Context, Result};
use hashtree_cli::{NostrKeys, NostrResolverConfig, NostrRootResolver, RootResolver};

/// Resolved CID with optional path.
pub(crate) struct ResolvedCid {
    pub(crate) cid: hashtree_core::Cid,
    pub(crate) path: Option<String>,
}

#[derive(Default, Clone)]
pub(crate) struct ResolveOptions {
    pub(crate) link_key: Option<[u8; 32]>,
    pub(crate) private: bool,
    pub(crate) relays: Option<Vec<String>>,
    pub(crate) secret_key: Option<NostrKeys>,
}

/// Resolve a CID input which can be:
/// - An nhash (bech32-encoded hash with optional key)
/// - An npub/repo path (e.g., "npub1.../myrepo")
/// - An htree:// URL (e.g., "htree://npub1.../myrepo")
/// Returns the resolved Cid (raw bytes) and optional path within the tree.
pub(crate) async fn resolve_cid_input(input: &str) -> Result<ResolvedCid> {
    resolve_cid_input_with_opts(input, &ResolveOptions::default()).await
}

pub(crate) async fn resolve_cid_input_with_opts(
    input: &str,
    opts: &ResolveOptions,
) -> Result<ResolvedCid> {
    use hashtree_core::{is_nhash, nhash_decode, Cid};

    // Strip htree:// prefix if present
    let input = input.strip_prefix("htree://").unwrap_or(input);

    // Check if it's an nhash (bech32-encoded) - gives us raw bytes directly
    // Support nhash1.../path/to/file format (path suffix after slash)
    if is_nhash(input) {
        let (nhash_part, url_path) = if let Some(slash_pos) = input.find('/') {
            (&input[..slash_pos], Some(&input[slash_pos + 1..]))
        } else {
            (input, None)
        };

        let data = nhash_decode(nhash_part).map_err(|e| anyhow::anyhow!("Invalid nhash: {}", e))?;

        return Ok(ResolvedCid {
            cid: Cid {
                hash: data.hash,
                key: data.decrypt_key,
            },
            path: url_path.map(|p| p.to_string()),
        });
    }

    // Check for hex CID format: "hash" or "hash:key", optionally with /path
    let (cid_part, url_path) = if let Some(slash_pos) = input.find('/') {
        (&input[..slash_pos], Some(&input[slash_pos + 1..]))
    } else {
        (input, None)
    };
    if let Ok(cid) = Cid::parse(cid_part) {
        return Ok(ResolvedCid {
            cid,
            path: url_path.map(|p| p.to_string()),
        });
    }

    // Check if it looks like an npub path (npub1.../name or npub1.../name/path)
    if input.starts_with("npub1") && input.contains('/') {
        let parts: Vec<&str> = input.splitn(3, '/').collect();
        if parts.len() >= 2 {
            let npub = parts[0];
            let repo = parts[1];
            let subpath = if parts.len() > 2 {
                Some(parts[2].to_string())
            } else {
                None
            };

            // Resolve via nostr
            let key = format!("{}/{}", npub, repo);
            eprintln!("Resolving {}...", key);

            let mut config = NostrResolverConfig::default();
            if let Some(relays) = &opts.relays {
                config.relays = relays.clone();
            }
            if opts.private {
                config.secret_key = opts.secret_key.clone();
            }

            let resolver = NostrRootResolver::new(config)
                .await
                .context("Failed to create nostr resolver")?;

            let resolved = if let Some(link_key) = opts.link_key {
                resolver.resolve_shared(&key, &link_key).await
            } else {
                resolver.resolve(&key).await
            };

            match resolved {
                Ok(Some(cid)) => {
                    eprintln!("Resolved to: {}", hashtree_core::to_hex(&cid.hash));
                    return Ok(ResolvedCid { cid, path: subpath });
                }
                Ok(None) => {
                    anyhow::bail!("No content found for {}", key);
                }
                Err(e) => {
                    anyhow::bail!("Failed to resolve {}: {}", key, e);
                }
            }
        }
    }

    anyhow::bail!("Invalid format. Use nhash1..., <hash>, <hash:key>, or npub1.../name")
}
