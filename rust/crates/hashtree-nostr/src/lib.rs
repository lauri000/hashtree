//! Hashtree-native Nostr event indexes.

use std::sync::Arc;

use hashtree_core::{
    sha256, Cid, DirEntry, HashTree, HashTreeConfig, HashTreeError, LinkType, Store,
};
use hashtree_index::{BTree, BTreeError, BTreeOptions};
use serde::{Deserialize, Serialize};

const EVENT_ENVELOPE_VERSION: u8 = 1;
const MANIFEST_BY_ID: &str = "by-id";
const MANIFEST_BY_AUTHOR_TIME: &str = "by-author-time";
const MANIFEST_BY_AUTHOR_KIND_TIME: &str = "by-author-kind-time";
const MANIFEST_BY_KIND_TIME: &str = "by-kind-time";
const MANIFEST_BY_TIME: &str = "by-time";
const MANIFEST_BY_TAG: &str = "by-tag";
const MANIFEST_REPLACEABLE: &str = "replaceable";
const MANIFEST_PARAMETERIZED_REPLACEABLE: &str = "parameterized-replaceable";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredNostrEvent {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u32,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NostrEventManifest {
    pub by_id: Option<Cid>,
    pub by_author_time: Option<Cid>,
    pub by_author_kind_time: Option<Cid>,
    pub by_kind_time: Option<Cid>,
    pub by_time: Option<Cid>,
    pub by_tag: Option<Cid>,
    pub replaceable: Option<Cid>,
    pub parameterized_replaceable: Option<Cid>,
}

#[derive(Debug, Clone, Default)]
pub struct ListEventsOptions {
    pub limit: Option<usize>,
    pub since: Option<u64>,
    pub until: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum NostrEventStoreError {
    #[error("hash tree error: {0}")]
    HashTree(#[from] HashTreeError),
    #[error("index error: {0}")]
    Index(#[from] BTreeError),
    #[error("encode error: {0}")]
    Encode(#[from] rmp_serde::encode::Error),
    #[error("decode error: {0}")]
    Decode(#[from] rmp_serde::decode::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Validation(String),
}

pub struct NostrEventStore<S: Store> {
    tree: HashTree<S>,
    index: BTree<S>,
}

impl<S: Store> NostrEventStore<S> {
    pub fn new(store: Arc<S>) -> Self {
        Self {
            tree: HashTree::new(HashTreeConfig::new(Arc::clone(&store))),
            index: BTree::new(store, BTreeOptions::default()),
        }
    }

    pub fn encode_event(&self, event: &StoredNostrEvent) -> Result<Vec<u8>, NostrEventStoreError> {
        let normalized = self.validate_event_shape(event.clone())?;
        Ok(rmp_serde::to_vec(&(
            EVENT_ENVELOPE_VERSION,
            normalized.id,
            normalized.pubkey,
            normalized.created_at,
            normalized.kind,
            normalized.tags,
            normalized.content,
            normalized.sig,
        ))?)
    }

    pub fn decode_event(&self, data: &[u8]) -> Result<StoredNostrEvent, NostrEventStoreError> {
        let (version, id, pubkey, created_at, kind, tags, content, sig): (
            u8,
            String,
            String,
            u64,
            u32,
            Vec<Vec<String>>,
            String,
            String,
        ) = rmp_serde::from_slice(data)?;

        if version != EVENT_ENVELOPE_VERSION {
            return Err(NostrEventStoreError::Validation(format!(
                "unsupported event envelope version: {version}"
            )));
        }

        self.validate_event_shape(StoredNostrEvent {
            id,
            pubkey,
            created_at,
            kind,
            tags,
            content,
            sig,
        })
    }

    pub async fn add(
        &self,
        root: Option<&Cid>,
        event: StoredNostrEvent,
    ) -> Result<Cid, NostrEventStoreError> {
        let normalized = self.validate_event(event).await?;
        let manifest = self.get_manifest(root).await?;
        let event_bytes = self.encode_event(&normalized)?;
        let (event_cid, _size) = self.tree.put_file(&event_bytes).await?;

        let mut next_manifest = NostrEventManifest {
            by_id: Some(
                self.index
                    .insert_link(manifest.by_id.as_ref(), &normalized.id, &event_cid)
                    .await?,
            ),
            by_author_time: Some(
                self.index
                    .insert_link(
                        manifest.by_author_time.as_ref(),
                        &author_time_key(&normalized),
                        &event_cid,
                    )
                    .await?,
            ),
            by_author_kind_time: Some(
                self.index
                    .insert_link(
                        manifest.by_author_kind_time.as_ref(),
                        &author_kind_time_key(&normalized),
                        &event_cid,
                    )
                    .await?,
            ),
            by_kind_time: Some(
                self.index
                    .insert_link(
                        manifest.by_kind_time.as_ref(),
                        &kind_time_key(&normalized),
                        &event_cid,
                    )
                    .await?,
            ),
            by_time: Some(
                self.index
                    .insert_link(
                        manifest.by_time.as_ref(),
                        &time_key(&normalized),
                        &event_cid,
                    )
                    .await?,
            ),
            by_tag: manifest.by_tag.clone(),
            replaceable: manifest.replaceable.clone(),
            parameterized_replaceable: manifest.parameterized_replaceable.clone(),
        };

        for tag_key in tag_keys(&normalized) {
            next_manifest.by_tag = Some(
                self.index
                    .insert_link(next_manifest.by_tag.as_ref(), &tag_key, &event_cid)
                    .await?,
            );
        }

        if is_replaceable_kind(normalized.kind) {
            next_manifest.replaceable = Some(
                self.upsert_winner(
                    manifest.replaceable.as_ref(),
                    &replaceable_key(&normalized.pubkey, normalized.kind),
                    &normalized,
                    &event_cid,
                )
                .await?,
            );
        }

        if is_parameterized_replaceable_kind(normalized.kind) {
            if let Some(d_tag) = get_d_tag(&normalized) {
                next_manifest.parameterized_replaceable = Some(
                    self.upsert_winner(
                        manifest.parameterized_replaceable.as_ref(),
                        &parameterized_replaceable_key(&normalized.pubkey, normalized.kind, &d_tag),
                        &normalized,
                        &event_cid,
                    )
                    .await?,
                );
            }
        }

        let Some(root) = self.write_manifest(&next_manifest).await? else {
            return Err(NostrEventStoreError::Validation(
                "failed to write event manifest".to_string(),
            ));
        };
        Ok(root)
    }

    pub async fn build<I>(
        &self,
        root: Option<&Cid>,
        events: I,
    ) -> Result<Option<Cid>, NostrEventStoreError>
    where
        I: IntoIterator<Item = StoredNostrEvent>,
    {
        let mut events: Vec<StoredNostrEvent> = events.into_iter().collect();
        events.sort_by(|left, right| match compare_events(left, right) {
            x if x < 0 => std::cmp::Ordering::Less,
            x if x > 0 => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        });

        let mut current = root.cloned();
        for event in events {
            current = Some(self.add(current.as_ref(), event).await?);
        }
        Ok(current)
    }

    pub async fn get_by_id(
        &self,
        root: Option<&Cid>,
        event_id: &str,
    ) -> Result<Option<StoredNostrEvent>, NostrEventStoreError> {
        validate_lower_hex(event_id, 64, "event id")?;
        let manifest = self.get_manifest(root).await?;
        let Some(by_id) = manifest.by_id.as_ref() else {
            return Ok(None);
        };
        let Some(event_cid) = self.index.get_link(Some(by_id), event_id).await? else {
            return Ok(None);
        };
        Ok(Some(self.read_stored_event(&event_cid).await?))
    }

    pub async fn list_by_author(
        &self,
        root: Option<&Cid>,
        pubkey: &str,
        options: ListEventsOptions,
    ) -> Result<Vec<StoredNostrEvent>, NostrEventStoreError> {
        let manifest = self.get_manifest(root).await?;
        let Some(by_author_time) = manifest.by_author_time.as_ref() else {
            return Ok(Vec::new());
        };
        self.collect_events(
            by_author_time,
            &format!("{}:", validate_lower_hex(pubkey, 64, "pubkey")?),
            &options,
        )
        .await
    }

    pub async fn list_by_author_and_kind(
        &self,
        root: Option<&Cid>,
        pubkey: &str,
        kind: u32,
        options: ListEventsOptions,
    ) -> Result<Vec<StoredNostrEvent>, NostrEventStoreError> {
        let manifest = self.get_manifest(root).await?;
        let Some(by_author_kind_time) = manifest.by_author_kind_time.as_ref() else {
            return Ok(Vec::new());
        };

        self.collect_events(
            by_author_kind_time,
            &format!(
                "{}:{}:",
                validate_lower_hex(pubkey, 64, "pubkey")?,
                pad_kind(kind)
            ),
            &options,
        )
        .await
    }

    pub async fn list_by_kind(
        &self,
        root: Option<&Cid>,
        kind: u32,
        options: ListEventsOptions,
    ) -> Result<Vec<StoredNostrEvent>, NostrEventStoreError> {
        let manifest = self.get_manifest(root).await?;
        let Some(by_kind_time) = manifest.by_kind_time.as_ref() else {
            return Ok(Vec::new());
        };

        self.collect_events(by_kind_time, &format!("{}:", pad_kind(kind)), &options)
            .await
    }

    pub async fn get_replaceable(
        &self,
        root: Option<&Cid>,
        pubkey: &str,
        kind: u32,
    ) -> Result<Option<StoredNostrEvent>, NostrEventStoreError> {
        let manifest = self.get_manifest(root).await?;
        let Some(replaceable) = manifest.replaceable.as_ref() else {
            return Ok(None);
        };

        let key = replaceable_key(&validate_lower_hex(pubkey, 64, "pubkey")?, kind);
        let Some(cid) = self.index.get_link(Some(replaceable), &key).await? else {
            return Ok(None);
        };
        Ok(Some(self.read_stored_event(&cid).await?))
    }

    pub async fn list_recent(
        &self,
        root: Option<&Cid>,
        options: ListEventsOptions,
    ) -> Result<Vec<StoredNostrEvent>, NostrEventStoreError> {
        let manifest = self.get_manifest(root).await?;
        let Some(by_time) = manifest.by_time.as_ref() else {
            return Ok(Vec::new());
        };
        self.collect_events(by_time, "", &options).await
    }

    pub async fn list_by_tag(
        &self,
        root: Option<&Cid>,
        tag_name: &str,
        tag_value: &str,
        options: ListEventsOptions,
    ) -> Result<Vec<StoredNostrEvent>, NostrEventStoreError> {
        let manifest = self.get_manifest(root).await?;
        let Some(by_tag) = manifest.by_tag.as_ref() else {
            return Ok(Vec::new());
        };
        let prefix = tag_prefix(tag_name, tag_value)?;
        self.collect_events(by_tag, &prefix, &options).await
    }

    pub async fn get_parameterized_replaceable(
        &self,
        root: Option<&Cid>,
        pubkey: &str,
        kind: u32,
        d_tag: &str,
    ) -> Result<Option<StoredNostrEvent>, NostrEventStoreError> {
        if d_tag.is_empty() {
            return Err(NostrEventStoreError::Validation(
                "parameterized replaceable events require a non-empty d tag".to_string(),
            ));
        }

        let manifest = self.get_manifest(root).await?;
        let Some(parameterized) = manifest.parameterized_replaceable.as_ref() else {
            return Ok(None);
        };

        let key =
            parameterized_replaceable_key(&validate_lower_hex(pubkey, 64, "pubkey")?, kind, d_tag);
        let Some(cid) = self.index.get_link(Some(parameterized), &key).await? else {
            return Ok(None);
        };
        Ok(Some(self.read_stored_event(&cid).await?))
    }

    pub async fn get_manifest(
        &self,
        root: Option<&Cid>,
    ) -> Result<NostrEventManifest, NostrEventStoreError> {
        let Some(root) = root else {
            return Ok(NostrEventManifest::default());
        };

        let entries = self.tree.list_directory(root).await?;
        Ok(NostrEventManifest {
            by_id: find_manifest_cid(&entries, MANIFEST_BY_ID),
            by_author_time: find_manifest_cid(&entries, MANIFEST_BY_AUTHOR_TIME),
            by_author_kind_time: find_manifest_cid(&entries, MANIFEST_BY_AUTHOR_KIND_TIME),
            by_kind_time: find_manifest_cid(&entries, MANIFEST_BY_KIND_TIME),
            by_time: find_manifest_cid(&entries, MANIFEST_BY_TIME),
            by_tag: find_manifest_cid(&entries, MANIFEST_BY_TAG),
            replaceable: find_manifest_cid(&entries, MANIFEST_REPLACEABLE),
            parameterized_replaceable: find_manifest_cid(
                &entries,
                MANIFEST_PARAMETERIZED_REPLACEABLE,
            ),
        })
    }

    async fn collect_events(
        &self,
        root: &Cid,
        prefix: &str,
        options: &ListEventsOptions,
    ) -> Result<Vec<StoredNostrEvent>, NostrEventStoreError> {
        let mut events = Vec::new();
        let entries = if prefix.is_empty() {
            self.index.links_entries(Some(root)).await?
        } else {
            self.index.prefix_links(root, prefix).await?
        };
        for (key, cid) in entries {
            let created_at = created_at_from_index_key(&key)?;
            if options.until.is_some_and(|until| created_at > until) {
                continue;
            }
            if options.since.is_some_and(|since| created_at < since) {
                break;
            }
            events.push(self.read_stored_event(&cid).await?);
            if options.limit.is_some_and(|limit| events.len() >= limit) {
                break;
            }
        }
        Ok(events)
    }

    async fn read_stored_event(&self, cid: &Cid) -> Result<StoredNostrEvent, NostrEventStoreError> {
        let Some(data) = self.tree.get(cid, None).await? else {
            return Err(NostrEventStoreError::Validation(
                "stored nostr event blob is missing".to_string(),
            ));
        };
        self.decode_event(&data)
    }

    async fn upsert_winner(
        &self,
        root: Option<&Cid>,
        key: &str,
        event: &StoredNostrEvent,
        event_cid: &Cid,
    ) -> Result<Cid, NostrEventStoreError> {
        let existing_cid = match root {
            Some(root) => self.index.get_link(Some(root), key).await?,
            None => None,
        };

        let Some(existing_cid) = existing_cid else {
            return Ok(self.index.insert_link(root, key, event_cid).await?);
        };

        let existing = self.read_stored_event(&existing_cid).await?;
        if compare_events(event, &existing) > 0 {
            return Ok(self.index.insert_link(root, key, event_cid).await?);
        }

        Ok(root.expect("winner root exists").clone())
    }

    async fn write_manifest(
        &self,
        manifest: &NostrEventManifest,
    ) -> Result<Option<Cid>, NostrEventStoreError> {
        let mut entries = Vec::new();
        if let Some(cid) = manifest.by_id.as_ref() {
            entries.push(DirEntry::from_cid(MANIFEST_BY_ID, cid).with_link_type(LinkType::Dir));
        }
        if let Some(cid) = manifest.by_author_time.as_ref() {
            entries.push(
                DirEntry::from_cid(MANIFEST_BY_AUTHOR_TIME, cid).with_link_type(LinkType::Dir),
            );
        }
        if let Some(cid) = manifest.by_author_kind_time.as_ref() {
            entries.push(
                DirEntry::from_cid(MANIFEST_BY_AUTHOR_KIND_TIME, cid).with_link_type(LinkType::Dir),
            );
        }
        if let Some(cid) = manifest.by_kind_time.as_ref() {
            entries
                .push(DirEntry::from_cid(MANIFEST_BY_KIND_TIME, cid).with_link_type(LinkType::Dir));
        }
        if let Some(cid) = manifest.by_time.as_ref() {
            entries.push(DirEntry::from_cid(MANIFEST_BY_TIME, cid).with_link_type(LinkType::Dir));
        }
        if let Some(cid) = manifest.by_tag.as_ref() {
            entries.push(DirEntry::from_cid(MANIFEST_BY_TAG, cid).with_link_type(LinkType::Dir));
        }
        if let Some(cid) = manifest.replaceable.as_ref() {
            entries
                .push(DirEntry::from_cid(MANIFEST_REPLACEABLE, cid).with_link_type(LinkType::Dir));
        }
        if let Some(cid) = manifest.parameterized_replaceable.as_ref() {
            entries.push(
                DirEntry::from_cid(MANIFEST_PARAMETERIZED_REPLACEABLE, cid)
                    .with_link_type(LinkType::Dir),
            );
        }

        if entries.is_empty() {
            return Ok(None);
        }

        Ok(Some(self.tree.put_directory(entries).await?))
    }

    async fn validate_event(
        &self,
        event: StoredNostrEvent,
    ) -> Result<StoredNostrEvent, NostrEventStoreError> {
        let normalized = self.validate_event_shape(event)?;
        let payload = serde_json::to_string(&(
            0u8,
            normalized.pubkey.clone(),
            normalized.created_at,
            normalized.kind,
            normalized.tags.clone(),
            normalized.content.clone(),
        ))?;
        let computed = hex::encode(sha256(payload.as_bytes()));
        if computed != normalized.id {
            return Err(NostrEventStoreError::Validation(
                "event id does not match canonical nostr payload".to_string(),
            ));
        }
        Ok(normalized)
    }

    fn validate_event_shape(
        &self,
        event: StoredNostrEvent,
    ) -> Result<StoredNostrEvent, NostrEventStoreError> {
        Ok(StoredNostrEvent {
            id: validate_lower_hex(&event.id, 64, "event id")?,
            pubkey: validate_lower_hex(&event.pubkey, 64, "pubkey")?,
            created_at: event.created_at,
            kind: event.kind,
            tags: event.tags,
            content: event.content,
            sig: validate_lower_hex(&event.sig, 128, "signature")?,
        })
    }
}

fn validate_lower_hex(
    value: &str,
    expected_len: usize,
    label: &str,
) -> Result<String, NostrEventStoreError> {
    let valid = value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if valid {
        Ok(value.to_string())
    } else {
        Err(NostrEventStoreError::Validation(format!(
            "{label} must be a lowercase {expected_len}-character hex string"
        )))
    }
}

fn pad_kind(kind: u32) -> String {
    format!("{kind:08x}")
}

fn reverse_timestamp(created_at: u64) -> String {
    format!("{:016x}", u64::MAX - created_at)
}

fn author_time_key(event: &StoredNostrEvent) -> String {
    format!(
        "{}:{}:{}",
        event.pubkey,
        reverse_timestamp(event.created_at),
        event.id
    )
}

fn author_kind_time_key(event: &StoredNostrEvent) -> String {
    format!(
        "{}:{}:{}:{}",
        event.pubkey,
        pad_kind(event.kind),
        reverse_timestamp(event.created_at),
        event.id
    )
}

fn kind_time_key(event: &StoredNostrEvent) -> String {
    format!(
        "{}:{}:{}",
        pad_kind(event.kind),
        reverse_timestamp(event.created_at),
        event.id
    )
}

fn time_key(event: &StoredNostrEvent) -> String {
    format!("{}:{}", reverse_timestamp(event.created_at), event.id)
}

fn created_at_from_index_key(key: &str) -> Result<u64, NostrEventStoreError> {
    let mut parts = key.rsplitn(3, ':');
    let _event_id = parts.next();
    let Some(reversed) = parts.next() else {
        return Err(NostrEventStoreError::Validation(format!(
            "invalid nostr index key: {key}"
        )));
    };
    let reversed = u64::from_str_radix(reversed, 16).map_err(|err| {
        NostrEventStoreError::Validation(format!(
            "invalid reversed timestamp in nostr index key {key}: {err}"
        ))
    })?;
    Ok(u64::MAX - reversed)
}

fn tag_keys(event: &StoredNostrEvent) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| match tag.as_slice() {
            [name, value, ..] if !name.is_empty() && !value.is_empty() => {
                let normalized_name = name.to_lowercase();
                let normalized_value = normalize_tag_value(&normalized_name, value);
                Some(format!(
                    "{}:{}:{}:{}",
                    normalized_name,
                    normalized_value,
                    reverse_timestamp(event.created_at),
                    event.id
                ))
            }
            _ => None,
        })
        .collect()
}

fn tag_prefix(tag_name: &str, tag_value: &str) -> Result<String, NostrEventStoreError> {
    let normalized_name = normalize_tag_name(tag_name)?;
    let normalized_value = normalize_tag_value(&normalized_name, tag_value);
    Ok(format!("{normalized_name}:{normalized_value}:"))
}

fn normalize_tag_name(tag_name: &str) -> Result<String, NostrEventStoreError> {
    if tag_name.is_empty() {
        return Err(NostrEventStoreError::Validation(
            "tag name must be non-empty".to_string(),
        ));
    }
    Ok(tag_name.to_lowercase())
}

fn normalize_tag_value(tag_name: &str, tag_value: &str) -> String {
    if tag_name == "t" {
        tag_value.to_lowercase()
    } else {
        tag_value.to_string()
    }
}

fn replaceable_key(pubkey: &str, kind: u32) -> String {
    format!("{}:{}", pubkey, pad_kind(kind))
}

fn parameterized_replaceable_key(pubkey: &str, kind: u32, d_tag: &str) -> String {
    format!("{}:{}:{}", pubkey, pad_kind(kind), d_tag)
}

fn is_replaceable_kind(kind: u32) -> bool {
    kind == 0 || kind == 3 || (10_000..20_000).contains(&kind)
}

fn is_parameterized_replaceable_kind(kind: u32) -> bool {
    (30_000..40_000).contains(&kind)
}

fn get_d_tag(event: &StoredNostrEvent) -> Option<String> {
    event.tags.iter().find_map(|tag| match tag.as_slice() {
        [name, value, ..] if name == "d" && !value.is_empty() => Some(value.clone()),
        _ => None,
    })
}

fn compare_events(left: &StoredNostrEvent, right: &StoredNostrEvent) -> i8 {
    match left.created_at.cmp(&right.created_at) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Greater => 1,
        std::cmp::Ordering::Equal => match left.id.cmp(&right.id) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Greater => 1,
            std::cmp::Ordering::Equal => 0,
        },
    }
}

fn find_manifest_cid(entries: &[hashtree_core::TreeEntry], name: &str) -> Option<Cid> {
    entries
        .iter()
        .find(|entry| entry.name == name)
        .map(|entry| Cid {
            hash: entry.hash,
            key: entry.key,
        })
}
