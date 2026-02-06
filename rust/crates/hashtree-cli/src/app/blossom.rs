use anyhow::{Context, Result};
use std::collections::HashSet;
use std::path::PathBuf;

use hashtree_cli::config::ensure_keys_string;
use hashtree_cli::HashtreeStore;

fn parse_cid_root_hash(cid_str: &str) -> (String, Option<String>) {
    if let Some((h, k)) = cid_str.split_once(':') {
        (h.to_string(), Some(k.to_string()))
    } else {
        (cid_str.to_string(), None)
    }
}

fn collect_blocks_for_push(store: &HashtreeStore, root_hash: [u8; 32]) -> Vec<Vec<u8>> {
    let mut blocks_to_push: Vec<Vec<u8>> = Vec::new();
    let mut visited: HashSet<[u8; 32]> = HashSet::new();
    let mut queue = vec![root_hash];

    while let Some(hash) = queue.pop() {
        if visited.contains(&hash) {
            continue;
        }
        visited.insert(hash);

        // Try to get as tree node first (for directories/internal nodes)
        if let Ok(Some(node)) = store.get_tree_node(&hash) {
            if let Ok(Some(data)) = store.get_blob(&hash) {
                blocks_to_push.push(data);
            }
            for link in &node.links {
                if !visited.contains(&link.hash) {
                    queue.push(link.hash);
                }
            }
            continue;
        }

        // Chunked files: include chunk blobs + metadata blob.
        if let Ok(Some(metadata)) = store.get_file_chunk_metadata(&hash) {
            if metadata.is_chunked {
                for chunk_hash in &metadata.chunk_hashes {
                    if !visited.contains(chunk_hash) {
                        if let Ok(Some(chunk_data)) = store.get_blob(chunk_hash) {
                            blocks_to_push.push(chunk_data);
                            visited.insert(*chunk_hash);
                        }
                    }
                }
            }
            if let Ok(Some(data)) = store.get_blob(&hash) {
                blocks_to_push.push(data);
            }
            continue;
        }

        // Fall back to plain blob.
        if let Ok(Some(data)) = store.get_blob(&hash) {
            blocks_to_push.push(data);
        }
    }

    blocks_to_push
}

/// Push content to Blossom servers.
pub(crate) async fn push_to_blossom(
    data_dir: &PathBuf,
    cid_str: &str,
    server_override: Option<String>,
) -> Result<()> {
    use hashtree_blossom::BlossomClient;
    use hashtree_core::from_hex;
    use nostr::Keys;

    // Ensure nsec exists for signing
    let (nsec_str, _) = ensure_keys_string()?;
    let keys = Keys::parse(&nsec_str).context("Failed to parse nsec")?;

    // Create client (optionally with server override)
    let client = if let Some(server) = server_override {
        BlossomClient::new(keys).with_write_servers(vec![server])
    } else {
        BlossomClient::new(keys)
    };

    if client.write_servers().is_empty() {
        anyhow::bail!(
            "No file servers configured. Use --server or add write_servers to config.toml"
        );
    }

    // Open local store
    let store = HashtreeStore::new(data_dir)?;

    // Parse CID (hash or hash:key)
    let (hash_hex, _key_hex) = parse_cid_root_hash(cid_str);

    // Collect all blocks to push (walk the DAG)
    println!("Collecting blocks...");
    let root_hash = from_hex(&hash_hex).context("Invalid hash")?;
    let blocks_to_push = collect_blocks_for_push(&store, root_hash);

    println!("Found {} blocks to push", blocks_to_push.len());

    let mut uploaded = 0;
    let mut skipped = 0;
    let mut errors = 0;

    for data in &blocks_to_push {
        match client.upload_if_missing(data).await {
            Ok((_hash, was_uploaded)) => {
                if was_uploaded {
                    uploaded += 1;
                } else {
                    skipped += 1;
                }
            }
            Err(e) => {
                eprintln!("  Upload error: {}", e);
                errors += 1;
            }
        }
    }

    println!(
        "\nUploaded: {}, Skipped: {}, Errors: {}",
        uploaded, skipped, errors
    );
    println!("Done!");
    Ok(())
}

/// Push tree to Blossom servers using BlossomClient.
pub(crate) async fn background_blossom_push(
    data_dir: &PathBuf,
    cid_str: &str,
    _servers: &[String],
) -> Result<()> {
    use hashtree_blossom::BlossomClient;
    use hashtree_core::from_hex;
    use nostr::Keys;

    // Ensure nsec exists for signing
    let (nsec_str, _) = ensure_keys_string()?;
    let keys = Keys::parse(&nsec_str).context("Failed to parse nsec")?;

    // Open local store
    let store = HashtreeStore::new(data_dir)?;

    // Parse CID (hash or hash:key)
    let (hash_hex, _key_hex) = parse_cid_root_hash(cid_str);

    let root_hash = from_hex(&hash_hex).context("Invalid hash")?;
    let blocks_to_push = collect_blocks_for_push(&store, root_hash);

    if blocks_to_push.is_empty() {
        return Ok(());
    }

    // Use BlossomClient (auto-loads servers from config)
    let client = BlossomClient::new(keys);
    let mut total_uploaded = 0;
    let mut total_skipped = 0;

    for data in &blocks_to_push {
        match client.upload_if_missing(data).await {
            Ok((_hash, was_uploaded)) => {
                if was_uploaded {
                    total_uploaded += 1;
                } else {
                    total_skipped += 1;
                }
            }
            Err(e) => {
                tracing::warn!("Blossom upload failed: {}", e);
            }
        }
    }

    if total_uploaded > 0 || total_skipped > 0 {
        println!(
            "  file servers: {} uploaded, {} already exist",
            total_uploaded, total_skipped
        );
    }

    Ok(())
}
