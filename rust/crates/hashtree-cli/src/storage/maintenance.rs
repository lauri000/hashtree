use anyhow::Result;
use std::collections::HashSet;

use super::{GcStats, HashtreeStore};

#[cfg(feature = "s3")]
use hashtree_core::from_hex;
use hashtree_core::{sha256, to_hex};

/// Result of blob integrity verification
#[derive(Debug, Clone)]
pub struct VerifyResult {
    pub total: usize,
    pub valid: usize,
    pub corrupted: usize,
    pub deleted: usize,
}

impl HashtreeStore {
    /// Garbage collect unpinned content
    pub fn gc(&self) -> Result<GcStats> {
        let rtxn = self.env.read_txn()?;

        // Get all pinned hashes as raw bytes
        let pinned: HashSet<[u8; 32]> = self
            .pins
            .iter(&rtxn)?
            .filter_map(|item| item.ok())
            .filter_map(|(hash_bytes, _)| {
                if hash_bytes.len() == 32 {
                    let mut hash = [0u8; 32];
                    hash.copy_from_slice(hash_bytes);
                    Some(hash)
                } else {
                    None
                }
            })
            .collect();

        drop(rtxn);

        // Get all stored hashes
        let all_hashes = self
            .router
            .list()
            .map_err(|e| anyhow::anyhow!("Failed to list hashes: {}", e))?;

        // Delete unpinned hashes
        let mut deleted = 0;
        let mut freed_bytes = 0u64;

        for hash in all_hashes {
            if !pinned.contains(&hash) {
                if let Ok(Some(data)) = self.router.get_sync(&hash) {
                    freed_bytes += data.len() as u64;
                    // Delete locally only - keep S3 as archive
                    let _ = self.router.delete_local_only(&hash);
                    deleted += 1;
                }
            }
        }

        Ok(GcStats {
            deleted_dags: deleted,
            freed_bytes,
        })
    }

    /// Verify LMDB blob integrity - checks that stored data matches its key hash
    /// Returns verification statistics and optionally deletes corrupted entries
    pub fn verify_lmdb_integrity(&self, delete: bool) -> Result<VerifyResult> {
        let all_hashes = self
            .router
            .list()
            .map_err(|e| anyhow::anyhow!("Failed to list hashes: {}", e))?;

        let total = all_hashes.len();
        let mut valid = 0;
        let mut corrupted = 0;
        let mut deleted = 0;
        let mut corrupted_hashes = Vec::new();

        for hash in &all_hashes {
            let hash_hex = to_hex(hash);

            match self.router.get_sync(hash) {
                Ok(Some(data)) => {
                    let actual_hash = sha256(&data);

                    if actual_hash == *hash {
                        valid += 1;
                    } else {
                        corrupted += 1;
                        let actual_hex = to_hex(&actual_hash);
                        println!(
                            "  CORRUPTED: key={} actual={} size={}",
                            &hash_hex[..16],
                            &actual_hex[..16],
                            data.len()
                        );
                        corrupted_hashes.push(*hash);
                    }
                }
                Ok(None) => {
                    corrupted += 1;
                    println!("  MISSING: key={}", &hash_hex[..16]);
                    corrupted_hashes.push(*hash);
                }
                Err(e) => {
                    corrupted += 1;
                    println!("  ERROR: key={} err={}", &hash_hex[..16], e);
                    corrupted_hashes.push(*hash);
                }
            }
        }

        if delete {
            for hash in &corrupted_hashes {
                match self.router.delete_sync(hash) {
                    Ok(true) => deleted += 1,
                    Ok(false) => {}
                    Err(e) => {
                        let hash_hex = to_hex(hash);
                        println!("  Failed to delete {}: {}", &hash_hex[..16], e);
                    }
                }
            }
        }

        Ok(VerifyResult {
            total,
            valid,
            corrupted,
            deleted,
        })
    }

    /// Verify R2/S3 blob integrity - lists all objects and verifies hash matches filename
    /// Returns verification statistics and optionally deletes corrupted entries
    #[cfg(feature = "s3")]
    pub async fn verify_r2_integrity(&self, delete: bool) -> Result<VerifyResult> {
        use aws_sdk_s3::Client as S3Client;

        let config = crate::config::Config::load()?;
        let s3_config = config
            .storage
            .s3
            .ok_or_else(|| anyhow::anyhow!("S3 not configured"))?;

        let aws_config = aws_config::from_env()
            .region(aws_sdk_s3::config::Region::new(s3_config.region.clone()))
            .load()
            .await;

        let s3_client = S3Client::from_conf(
            aws_sdk_s3::config::Builder::from(&aws_config)
                .endpoint_url(&s3_config.endpoint)
                .force_path_style(true)
                .build(),
        );

        let bucket = &s3_config.bucket;
        let prefix = s3_config.prefix.as_deref().unwrap_or("");

        let mut total = 0;
        let mut valid = 0;
        let mut corrupted = 0;
        let mut deleted = 0;
        let mut corrupted_keys = Vec::new();

        let mut continuation_token: Option<String> = None;

        loop {
            let mut list_req = s3_client.list_objects_v2().bucket(bucket).prefix(prefix);

            if let Some(ref token) = continuation_token {
                list_req = list_req.continuation_token(token);
            }

            let list_resp = list_req
                .send()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to list S3 objects: {}", e))?;

            for object in list_resp.contents() {
                let key = object.key().unwrap_or("");

                if !key.ends_with(".bin") {
                    continue;
                }

                total += 1;

                let filename = key.strip_prefix(prefix).unwrap_or(key);
                let expected_hash_hex = filename.strip_suffix(".bin").unwrap_or(filename);

                if expected_hash_hex.len() != 64 {
                    corrupted += 1;
                    println!("  INVALID KEY: {}", key);
                    corrupted_keys.push(key.to_string());
                    continue;
                }

                let expected_hash = match from_hex(expected_hash_hex) {
                    Ok(h) => h,
                    Err(_) => {
                        corrupted += 1;
                        println!("  INVALID HEX: {}", key);
                        corrupted_keys.push(key.to_string());
                        continue;
                    }
                };

                match s3_client.get_object().bucket(bucket).key(key).send().await {
                    Ok(resp) => match resp.body.collect().await {
                        Ok(bytes) => {
                            let data = bytes.into_bytes();
                            let actual_hash = sha256(&data);

                            if actual_hash == expected_hash {
                                valid += 1;
                            } else {
                                corrupted += 1;
                                let actual_hex = to_hex(&actual_hash);
                                println!(
                                    "  CORRUPTED: key={} actual={} size={}",
                                    &expected_hash_hex[..16],
                                    &actual_hex[..16],
                                    data.len()
                                );
                                corrupted_keys.push(key.to_string());
                            }
                        }
                        Err(e) => {
                            corrupted += 1;
                            println!("  READ ERROR: {} - {}", key, e);
                            corrupted_keys.push(key.to_string());
                        }
                    },
                    Err(e) => {
                        corrupted += 1;
                        println!("  FETCH ERROR: {} - {}", key, e);
                        corrupted_keys.push(key.to_string());
                    }
                }

                if total % 100 == 0 {
                    println!(
                        "  Progress: {} objects checked, {} corrupted so far",
                        total, corrupted
                    );
                }
            }

            if list_resp.is_truncated() == Some(true) {
                continuation_token = list_resp.next_continuation_token().map(|s| s.to_string());
            } else {
                break;
            }
        }

        if delete {
            for key in &corrupted_keys {
                match s3_client
                    .delete_object()
                    .bucket(bucket)
                    .key(key)
                    .send()
                    .await
                {
                    Ok(_) => deleted += 1,
                    Err(e) => {
                        println!("  Failed to delete {}: {}", key, e);
                    }
                }
            }
        }

        Ok(VerifyResult {
            total,
            valid,
            corrupted,
            deleted,
        })
    }

    /// Fallback for non-S3 builds
    #[cfg(not(feature = "s3"))]
    pub async fn verify_r2_integrity(&self, _delete: bool) -> Result<VerifyResult> {
        Err(anyhow::anyhow!("S3 feature not enabled"))
    }
}
