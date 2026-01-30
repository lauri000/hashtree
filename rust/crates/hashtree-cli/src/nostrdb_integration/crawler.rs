//! Social graph crawler - BFS crawl of follow lists via Nostr relays.

use nostrdb::Ndb;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

/// Crawls the social graph by fetching kind 3 (contact list) events from relays
/// and ingesting them into nostrdb.
pub struct SocialGraphCrawler {
    ndb: Arc<Ndb>,
    keys: nostr::Keys,
    relays: Vec<String>,
    max_depth: u32,
}

impl SocialGraphCrawler {
    pub fn new(
        ndb: Arc<Ndb>,
        keys: nostr::Keys,
        relays: Vec<String>,
        max_depth: u32,
    ) -> Self {
        Self {
            ndb,
            keys,
            relays,
            max_depth,
        }
    }

    /// Run the BFS crawl until shutdown is signaled.
    /// Fetches contact lists from relays and feeds them into nostrdb.
    #[allow(deprecated)] // nostr 0.35 deprecates kind()/tags() but we use this version
    pub async fn crawl(&self, shutdown_rx: watch::Receiver<bool>) {
        use nostr::nips::nip19::ToBech32;

        if self.relays.is_empty() {
            tracing::warn!("Social graph crawler: no relays configured, skipping");
            return;
        }

        tracing::info!(
            "Starting social graph crawl (max_depth={}, relays={})",
            self.max_depth,
            self.relays.len()
        );

        let sdk_keys = match nostr_sdk::Keys::parse(
            &self.keys.secret_key().to_bech32().unwrap_or_default(),
        ) {
            Ok(k) => k,
            Err(e) => {
                tracing::error!("Failed to parse keys for crawler: {}", e);
                return;
            }
        };

        let client = nostr_sdk::Client::new(&sdk_keys);

        for relay in &self.relays {
            if let Err(e) = client.add_relay(relay).await {
                tracing::warn!("Failed to add relay {}: {}", relay, e);
            }
        }
        client.connect().await;

        // BFS: start from root, fetch contact lists at each depth
        let root_pk = self.keys.public_key().to_bytes();
        let mut visited: HashSet<[u8; 32]> = HashSet::new();
        let mut current_level = vec![root_pk];
        visited.insert(root_pk);

        for depth in 0..self.max_depth {
            if current_level.is_empty() || *shutdown_rx.borrow() {
                break;
            }

            tracing::info!(
                "Crawling depth {} with {} pubkeys",
                depth,
                current_level.len()
            );

            let mut next_level = Vec::new();

            for pk_bytes in &current_level {
                if *shutdown_rx.borrow() {
                    break;
                }

                let pk_hex = hex::encode(pk_bytes);

                let pk = match nostr::PublicKey::from_slice(pk_bytes) {
                    Ok(pk) => pk,
                    Err(_) => continue,
                };

                let filter = nostr::Filter::new()
                    .author(pk)
                    .kinds(vec![nostr::Kind::ContactList, nostr::Kind::Custom(10000)]);

                let source = nostr_sdk::EventSource::relays(Some(Duration::from_secs(5)));

                match tokio::time::timeout(
                    Duration::from_secs(10),
                    client.get_events_of(vec![filter], source),
                )
                .await
                {
                    Ok(Ok(events)) => {
                        for event in &events {
                            // Ingest into nostrdb
                            if let Ok(json) = serde_json::to_string(event) {
                                super::ingest_event(&self.ndb, "crawl", &json);
                            }

                            // Extract follows for next level
                            if event.kind() == nostr::Kind::ContactList {
                                for tag in event.tags().iter() {
                                    if let Some(nostr::TagStandard::PublicKey {
                                        public_key,
                                        ..
                                    }) = tag.as_standardized()
                                    {
                                        let follow_bytes = public_key.to_bytes();
                                        if !visited.contains(&follow_bytes) {
                                            visited.insert(follow_bytes);
                                            next_level.push(follow_bytes);
                                        }
                                    }
                                }
                            }
                        }
                        tracing::debug!(
                            "Depth {}: fetched {} events for {}...",
                            depth,
                            events.len(),
                            &pk_hex[..8.min(pk_hex.len())]
                        );
                    }
                    Ok(Err(e)) => {
                        tracing::debug!("Failed to fetch events for {}...: {}", &pk_hex[..8], e);
                    }
                    Err(_) => {
                        tracing::debug!("Timeout fetching events for {}...", &pk_hex[..8]);
                    }
                }
            }

            current_level = next_level;
        }

        if let Err(e) = client.disconnect().await {
            tracing::debug!("Error disconnecting crawler client: {}", e);
        }

        tracing::info!(
            "Social graph crawl complete: visited {} pubkeys",
            visited.len()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_crawler_no_relays() {
        let tmp = TempDir::new().unwrap();
        let ndb = super::super::init_ndb(tmp.path()).unwrap();
        let keys = nostr::Keys::generate();
        let crawler = SocialGraphCrawler::new(ndb, keys, vec![], 2);
        let (_tx, rx) = watch::channel(false);
        // Should return immediately with no relays
        crawler.crawl(rx).await;
    }

    #[tokio::test]
    async fn test_crawler_shutdown_signal() {
        let tmp = TempDir::new().unwrap();
        let ndb = super::super::init_ndb(tmp.path()).unwrap();
        let keys = nostr::Keys::generate();
        let crawler =
            SocialGraphCrawler::new(ndb, keys, vec!["wss://localhost:1".to_string()], 2);
        let (_tx, rx) = watch::channel(true); // Already shutdown
        crawler.crawl(rx).await;
    }
}
