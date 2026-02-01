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
    spambox: Option<Arc<Ndb>>,
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
            spambox: None,
            keys,
            relays,
            max_depth,
        }
    }

    pub fn with_spambox(mut self, spambox: Arc<Ndb>) -> Self {
        self.spambox = Some(spambox);
        self
    }

    fn is_within_social_graph(&self, pk_bytes: &[u8; 32]) -> bool {
        if pk_bytes == &self.keys.public_key().to_bytes() {
            return true;
        }
        super::get_follow_distance(&self.ndb, pk_bytes)
            .map(|distance| distance <= self.max_depth)
            .unwrap_or(false)
    }

    fn ingest_event_into(&self, ndb: &Ndb, sub_id: &str, event: &nostr::Event) {
        if let Ok(json) = serde_json::to_string(event) {
            super::ingest_event(ndb, sub_id, &json);
        }
    }

    pub(crate) fn handle_incoming_event(&self, event: &nostr::Event) {
        let is_contact_list = event.kind == nostr::Kind::ContactList;
        let is_mute_list = event.kind == nostr::Kind::Custom(10000);
        if !is_contact_list && !is_mute_list {
            return;
        }

        let pk_bytes = event.pubkey.to_bytes();
        if self.is_within_social_graph(&pk_bytes) {
            self.ingest_event_into(&self.ndb, "live", event);
            return;
        }

        if let Some(spambox) = &self.spambox {
            self.ingest_event_into(spambox, "spambox", event);
        } else {
            tracing::debug!(
                "Social graph crawler: dropping untrusted {} from {}...",
                if is_contact_list { "contact list" } else { "mute list" },
                &event.pubkey.to_hex()[..8.min(event.pubkey.to_hex().len())]
            );
        }
    }

    /// Run the BFS crawl until shutdown is signaled.
    /// Fetches contact lists from relays and feeds them into nostrdb.
    #[allow(deprecated)] // nostr 0.35 deprecates kind()/tags() but we use this version
    pub async fn crawl(&self, shutdown_rx: watch::Receiver<bool>) {
        use nostr::nips::nip19::ToBech32;
        use nostr_sdk::prelude::RelayPoolNotification;

        if self.relays.is_empty() {
            tracing::warn!("Social graph crawler: no relays configured, skipping");
            return;
        }

        let mut shutdown_rx = shutdown_rx;
        if *shutdown_rx.borrow() {
            tracing::info!("Social graph crawler: shutdown requested before start");
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
                            self.ingest_event_into(&self.ndb, "crawl", event);

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

        let filter = nostr::Filter::new()
            .kinds(vec![nostr::Kind::ContactList, nostr::Kind::Custom(10000)])
            .since(nostr::Timestamp::now());

        match client.subscribe(vec![filter], None).await {
            Ok(_) => tracing::info!("Social graph crawler: subscribed to contact and mute lists"),
            Err(e) => tracing::warn!("Social graph crawler: failed to subscribe: {}", e),
        }

        let mut notifications = client.notifications();
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
                notification = notifications.recv() => {
                    match notification {
                        Ok(RelayPoolNotification::Event { event, .. }) => {
                            self.handle_incoming_event(&event);
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::warn!("Social graph crawler notification error: {}", e);
                            break;
                        }
                    }
                }
            }
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
    use nostr::{EventBuilder, Kind, Tag, PublicKey};
    use std::sync::Arc;
    use tempfile::TempDir;

    async fn wait_for_follow(ndb: &Ndb, owner: &[u8; 32], target: &[u8; 32]) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
        loop {
            let follows = super::super::get_follows(ndb, owner);
            if follows.iter().any(|pk| pk == target) {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn test_crawler_routes_untrusted_to_spambox() {
        let _guard = super::super::test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = super::super::init_ndb(tmp.path()).unwrap();
        let spambox = super::super::init_ndb_at_path(&tmp.path().join("nostrdb_spambox"), None).unwrap();

        let root_keys = nostr::Keys::generate();
        let root_pk = root_keys.public_key().to_bytes();
        super::super::set_social_graph_root(&ndb, &root_pk);
        tokio::time::sleep(Duration::from_millis(100)).await;

        let crawler = SocialGraphCrawler::new(
            Arc::clone(&ndb),
            root_keys.clone(),
            vec![],
            2,
        ).with_spambox(Arc::clone(&spambox));

        let unknown_keys = nostr::Keys::generate();
        let follow_tag = Tag::public_key(PublicKey::from_slice(&root_pk).unwrap());
        let event = EventBuilder::new(Kind::ContactList, "", vec![follow_tag])
            .to_event(&unknown_keys)
            .unwrap();

        crawler.handle_incoming_event(&event);

        let unknown_pk = unknown_keys.public_key().to_bytes();
        assert!(!wait_for_follow(&ndb, &unknown_pk, &root_pk).await);
        assert!(wait_for_follow(&spambox, &unknown_pk, &root_pk).await);
    }

    #[tokio::test]
    async fn test_crawler_routes_trusted_to_main_db() {
        let _guard = super::super::test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = super::super::init_ndb(tmp.path()).unwrap();
        let spambox = super::super::init_ndb_at_path(&tmp.path().join("nostrdb_spambox"), None).unwrap();

        let root_keys = nostr::Keys::generate();
        let root_pk = root_keys.public_key().to_bytes();
        super::super::set_social_graph_root(&ndb, &root_pk);
        tokio::time::sleep(Duration::from_millis(100)).await;

        let crawler = SocialGraphCrawler::new(
            Arc::clone(&ndb),
            root_keys.clone(),
            vec![],
            2,
        ).with_spambox(Arc::clone(&spambox));

        let target_keys = nostr::Keys::generate();
        let target_pk = target_keys.public_key().to_bytes();
        let follow_tag = Tag::public_key(PublicKey::from_slice(&target_pk).unwrap());
        let event = EventBuilder::new(Kind::ContactList, "", vec![follow_tag])
            .to_event(&root_keys)
            .unwrap();

        crawler.handle_incoming_event(&event);

        assert!(wait_for_follow(&ndb, &root_pk, &target_pk).await);
        assert!(!wait_for_follow(&spambox, &root_pk, &target_pk).await);
    }

    #[tokio::test]
    async fn test_crawler_no_relays() {
        let tmp = TempDir::new().unwrap();
        let ndb = {
            let _guard = super::super::test_lock();
            super::super::init_ndb(tmp.path()).unwrap()
        };
        let keys = nostr::Keys::generate();
        let crawler = SocialGraphCrawler::new(ndb, keys, vec![], 2);
        let (_tx, rx) = watch::channel(false);
        // Should return immediately with no relays
        crawler.crawl(rx).await;
    }

    #[tokio::test]
    async fn test_crawler_shutdown_signal() {
        let tmp = TempDir::new().unwrap();
        let ndb = {
            let _guard = super::super::test_lock();
            super::super::init_ndb(tmp.path()).unwrap()
        };
        let keys = nostr::Keys::generate();
        let crawler =
            SocialGraphCrawler::new(ndb, keys, vec!["wss://localhost:1".to_string()], 2);
        let (_tx, rx) = watch::channel(true); // Already shutdown
        crawler.crawl(rx).await;
    }
}
