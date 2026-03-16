use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use super::Ndb;

pub struct SocialGraphCrawler {
    ndb: Arc<Ndb>,
    spambox: Option<Arc<Ndb>>,
    keys: nostr::Keys,
    relays: Vec<String>,
    max_depth: u32,
}

impl SocialGraphCrawler {
    pub fn new(ndb: Arc<Ndb>, keys: nostr::Keys, relays: Vec<String>, max_depth: u32) -> Self {
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

    fn ingest_event_into(&self, ndb: &Ndb, event: &nostr::Event) {
        if let Err(err) = super::ingest_parsed_event(ndb, event) {
            tracing::debug!("Failed to ingest crawler event: {}", err);
        }
    }

    #[allow(deprecated)]
    fn collect_missing_root_follows(
        &self,
        event: &nostr::Event,
        fetched_contact_lists: &mut HashSet<[u8; 32]>,
    ) -> Vec<[u8; 32]> {
        if self.max_depth < 2 || event.kind != nostr::Kind::ContactList {
            return Vec::new();
        }

        let root_pk = self.keys.public_key().to_bytes();
        if event.pubkey.to_bytes() != root_pk {
            return Vec::new();
        }

        let mut missing = Vec::new();
        for tag in event.tags.iter() {
            if let Some(nostr::TagStandard::PublicKey { public_key, .. }) = tag.as_standardized() {
                let pk_bytes = public_key.to_bytes();
                if fetched_contact_lists.contains(&pk_bytes) {
                    continue;
                }

                let existing_follows = super::get_follows(&self.ndb, &pk_bytes);
                if !existing_follows.is_empty() {
                    fetched_contact_lists.insert(pk_bytes);
                    continue;
                }

                fetched_contact_lists.insert(pk_bytes);
                missing.push(pk_bytes);
            }
        }

        missing
    }

    async fn fetch_contact_lists_for_pubkeys(
        &self,
        client: &nostr_sdk::Client,
        pubkeys: &[[u8; 32]],
        shutdown_rx: &watch::Receiver<bool>,
    ) {
        for pk_bytes in pubkeys {
            if *shutdown_rx.borrow() {
                break;
            }

            let Ok(pk) = nostr::PublicKey::from_slice(pk_bytes) else {
                continue;
            };

            let filter = nostr::Filter::new()
                .author(pk)
                .kinds(vec![nostr::Kind::ContactList, nostr::Kind::MuteList]);

            let source = nostr_sdk::EventSource::relays(Some(Duration::from_secs(5)));
            match tokio::time::timeout(
                Duration::from_secs(10),
                client.get_events_of(vec![filter], source),
            )
            .await
            {
                Ok(Ok(events)) => {
                    for event in &events {
                        self.ingest_event_into(&self.ndb, event);
                    }
                }
                Ok(Err(err)) => {
                    tracing::debug!("Failed to fetch events for {}: {}", pk.to_hex(), err);
                }
                Err(_) => {
                    tracing::debug!("Timeout fetching events for {}", pk.to_hex());
                }
            }
        }
    }

    pub(crate) fn handle_incoming_event(&self, event: &nostr::Event) {
        let is_contact_list = event.kind == nostr::Kind::ContactList;
        let is_mute_list = event.kind == nostr::Kind::MuteList;
        if !is_contact_list && !is_mute_list {
            return;
        }

        let pk_bytes = event.pubkey.to_bytes();
        if self.is_within_social_graph(&pk_bytes) {
            self.ingest_event_into(&self.ndb, event);
            return;
        }

        if let Some(spambox) = &self.spambox {
            self.ingest_event_into(spambox, event);
        }
    }

    #[allow(deprecated)]
    pub async fn crawl(&self, shutdown_rx: watch::Receiver<bool>) {
        use nostr::nips::nip19::ToBech32;
        use nostr_sdk::prelude::RelayPoolNotification;

        if self.relays.is_empty() {
            tracing::warn!("Social graph crawler: no relays configured, skipping");
            return;
        }

        let mut shutdown_rx = shutdown_rx;
        if *shutdown_rx.borrow() {
            return;
        }

        let Ok(sdk_keys) =
            nostr_sdk::Keys::parse(&self.keys.secret_key().to_bech32().unwrap_or_default())
        else {
            return;
        };

        let client = nostr_sdk::Client::new(&sdk_keys);
        for relay in &self.relays {
            if let Err(err) = client.add_relay(relay).await {
                tracing::warn!("Failed to add relay {}: {}", relay, err);
            }
        }
        client.connect().await;

        let root_pk = self.keys.public_key().to_bytes();
        let mut visited: HashSet<[u8; 32]> = HashSet::new();
        let mut fetched_contact_lists: HashSet<[u8; 32]> = HashSet::new();
        let mut current_level = vec![root_pk];
        visited.insert(root_pk);

        for _depth in 0..self.max_depth {
            if current_level.is_empty() || *shutdown_rx.borrow() {
                break;
            }

            let mut next_level = Vec::new();
            for pk_bytes in &current_level {
                if *shutdown_rx.borrow() {
                    break;
                }

                fetched_contact_lists.insert(*pk_bytes);

                let Ok(pk) = nostr::PublicKey::from_slice(pk_bytes) else {
                    continue;
                };

                let filter = nostr::Filter::new()
                    .author(pk)
                    .kinds(vec![nostr::Kind::ContactList, nostr::Kind::MuteList]);
                let source = nostr_sdk::EventSource::relays(Some(Duration::from_secs(5)));

                match tokio::time::timeout(
                    Duration::from_secs(10),
                    client.get_events_of(vec![filter], source),
                )
                .await
                {
                    Ok(Ok(events)) => {
                        for event in &events {
                            self.ingest_event_into(&self.ndb, event);
                            if event.kind == nostr::Kind::ContactList {
                                for tag in event.tags.iter() {
                                    if let Some(nostr::TagStandard::PublicKey {
                                        public_key, ..
                                    }) = tag.as_standardized()
                                    {
                                        let follow_bytes = public_key.to_bytes();
                                        if visited.insert(follow_bytes) {
                                            next_level.push(follow_bytes);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Ok(Err(err)) => {
                        tracing::debug!("Failed to fetch events for {}: {}", pk.to_hex(), err);
                    }
                    Err(_) => {
                        tracing::debug!("Timeout fetching events for {}", pk.to_hex());
                    }
                }
            }

            current_level = next_level;
        }

        let filter = nostr::Filter::new()
            .kinds(vec![nostr::Kind::ContactList, nostr::Kind::MuteList])
            .since(nostr::Timestamp::now());

        let _ = client.subscribe(vec![filter], None).await;

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
                            let missing = self.collect_missing_root_follows(&event, &mut fetched_contact_lists);
                            if !missing.is_empty() {
                                self.fetch_contact_lists_for_pubkeys(&client, &missing, &shutdown_rx).await;
                            }
                        }
                        Ok(_) => {}
                        Err(err) => {
                            tracing::warn!("Social graph crawler notification error: {}", err);
                            break;
                        }
                    }
                }
            }
        }

        let _ = client.disconnect().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Kind, PublicKey, Tag};
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_crawler_routes_untrusted_to_spambox() {
        let _guard = crate::socialgraph::test_lock();
        let tmp = TempDir::new().unwrap();
        let ndb = crate::socialgraph::init_ndb(tmp.path()).unwrap();
        let spambox =
            crate::socialgraph::init_ndb_at_path(&tmp.path().join("spambox"), None).unwrap();

        let root_keys = nostr::Keys::generate();
        let root_pk = root_keys.public_key().to_bytes();
        crate::socialgraph::set_social_graph_root(&ndb, &root_pk);

        let crawler = SocialGraphCrawler::new(Arc::clone(&ndb), root_keys.clone(), vec![], 2)
            .with_spambox(Arc::clone(&spambox));

        let unknown_keys = nostr::Keys::generate();
        let follow_tag = Tag::public_key(PublicKey::from_slice(&root_pk).unwrap());
        let event = EventBuilder::new(Kind::ContactList, "", vec![follow_tag])
            .to_event(&unknown_keys)
            .unwrap();

        crawler.handle_incoming_event(&event);

        let unknown_pk = unknown_keys.public_key().to_bytes();
        assert!(crate::socialgraph::get_follows(&ndb, &unknown_pk).is_empty());
        assert_eq!(
            crate::socialgraph::get_follows(&spambox, &unknown_pk),
            vec![root_pk]
        );
    }
}
