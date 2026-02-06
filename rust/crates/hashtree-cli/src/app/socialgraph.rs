use anyhow::{Context, Result};
use hashtree_cli::Config;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn parse_pubkey_hex(hex_str: &str) -> Option<[u8; 32]> {
    if hex_str.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    if hex::decode_to_slice(hex_str, &mut bytes).is_err() {
        return None;
    }
    Some(bytes)
}

fn init_socialgraph(
    data_dir: &Path,
    config: &Config,
) -> Result<(Arc<hashtree_cli::socialgraph::Ndb>, [u8; 32])> {
    use hashtree_cli::config::{ensure_keys, parse_npub, pubkey_bytes};

    let nostr_db_max_bytes = config
        .nostr
        .db_max_size_gb
        .saturating_mul(1024 * 1024 * 1024);

    let (keys, _was_generated) = ensure_keys()?;
    let pk_bytes = pubkey_bytes(&keys);

    let social_graph_root_bytes = if let Some(ref root_npub) = config.nostr.socialgraph_root {
        match parse_npub(root_npub) {
            Ok(pk) => pk,
            Err(_) => {
                tracing::warn!("Invalid npub in socialgraph_root: {}", root_npub);
                pk_bytes
            }
        }
    } else {
        pk_bytes
    };

    let ndb = hashtree_cli::socialgraph::init_ndb_with_mapsize(data_dir, Some(nostr_db_max_bytes))
        .context("Failed to initialize nostrdb")?;
    hashtree_cli::socialgraph::set_social_graph_root(&ndb, &social_graph_root_bytes);

    Ok((ndb, social_graph_root_bytes))
}

pub(crate) fn run_socialgraph_filter(
    data_dir: PathBuf,
    max_distance: Option<u32>,
    overmute_threshold: f64,
) -> Result<()> {
    let config = Config::load()?;
    let max_distance = max_distance.unwrap_or(config.nostr.max_write_distance);

    let (ndb, social_graph_root_bytes) = init_socialgraph(&data_dir, &config)?;

    let mut distance_cache: HashMap<[u8; 32], Option<u32>> = HashMap::new();
    let mut overmute_cache: HashMap<[u8; 32], bool> = HashMap::new();

    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let event_value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("Skipping invalid JSON line: {}", err);
                continue;
            }
        };

        let event_obj = match &event_value {
            serde_json::Value::Object(obj) => Some(obj),
            serde_json::Value::Array(items) if items.len() >= 3 => match &items[2] {
                serde_json::Value::Object(obj) => Some(obj),
                _ => None,
            },
            _ => None,
        };
        let Some(event_obj) = event_obj else {
            eprintln!("Skipping JSON line without event object");
            continue;
        };

        let Some(pubkey_hex) = event_obj.get("pubkey").and_then(|value| value.as_str()) else {
            eprintln!("Skipping JSON line without pubkey");
            continue;
        };
        let Some(pk_bytes) = parse_pubkey_hex(pubkey_hex) else {
            eprintln!("Skipping invalid pubkey hex: {}", pubkey_hex);
            continue;
        };

        let distance = *distance_cache
            .entry(pk_bytes)
            .or_insert_with(|| hashtree_cli::socialgraph::get_follow_distance(&ndb, &pk_bytes));
        let Some(distance) = distance else {
            continue;
        };
        if distance > max_distance {
            continue;
        }

        if overmute_threshold > 0.0 {
            let overmuted = *overmute_cache.entry(pk_bytes).or_insert_with(|| {
                hashtree_cli::socialgraph::is_overmuted(
                    &ndb,
                    &social_graph_root_bytes,
                    &pk_bytes,
                    overmute_threshold,
                )
            });
            if overmuted {
                continue;
            }
        }

        stdout.write_all(trimmed.as_bytes())?;
        stdout.write_all(b"\n")?;
    }

    Ok(())
}

pub(crate) fn run_socialgraph_snapshot(
    data_dir: PathBuf,
    out: PathBuf,
    max_nodes: Option<usize>,
    max_edges: Option<usize>,
    max_distance: Option<u32>,
    max_edges_per_node: Option<usize>,
) -> Result<()> {
    let config = Config::load()?;

    let (ndb, social_graph_root_bytes) = init_socialgraph(&data_dir, &config)?;

    let options = hashtree_cli::socialgraph::snapshot::SnapshotOptions {
        max_nodes,
        max_edges,
        max_distance,
        max_edges_per_node,
    };

    let chunks = hashtree_cli::socialgraph::snapshot::build_snapshot_chunks(
        &ndb,
        &social_graph_root_bytes,
        &options,
    )
    .context("Failed to build social graph snapshot")?;

    let mut writer: Box<dyn Write> = if out.as_os_str() == "-" {
        Box::new(io::stdout())
    } else {
        Box::new(std::fs::File::create(&out).context("Failed to create output file")?)
    };

    for chunk in chunks {
        writer.write_all(&chunk)?;
    }
    writer.flush()?;

    Ok(())
}
