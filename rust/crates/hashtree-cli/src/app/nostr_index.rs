use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use hashtree_core::Cid;
use hashtree_nostr::{ListEventsOptions, NostrEventStore, StoredNostrEvent};
use hashtree_nostr_bridge::{CrawlConfig, CrawlReport, NostrBridge, RelayFetchMode};
use nostr::Keys;
use nostr_social_graph::{BinaryBudget, SocialGraph};
use tokio::sync::watch;

use hashtree_cli::config::{ensure_keys, parse_npub};
use hashtree_cli::socialgraph::{self, SocialGraphBackend, SocialGraphCrawler};
use hashtree_cli::{Config, HashtreeStore};

const INDEX_DIR: &str = "nostr-index";
const LATEST_ROOT_FILE: &str = "latest-root.txt";
const LATEST_REPORT_FILE: &str = "latest-report.json";
const TOP_ITEMS_LIMIT: usize = 20;

#[derive(Debug, Clone)]
pub(crate) struct SocialGraphIndexOptions {
    pub(crate) warm_graph_for: Duration,
    pub(crate) graph_crawl_depth: u32,
    pub(crate) full_graph_recrawl: bool,
    pub(crate) relays: Option<Vec<String>>,
    pub(crate) max_authors: usize,
    pub(crate) max_follow_distance: Option<u32>,
    pub(crate) max_live_bytes: u64,
    pub(crate) author_batch_size: usize,
    pub(crate) per_author_event_limit: usize,
    pub(crate) per_author_live_bytes: Option<u64>,
    pub(crate) fetch_timeout: Duration,
    pub(crate) global_relay_scan: bool,
    pub(crate) relay_page_size: usize,
    pub(crate) max_relay_pages: usize,
    pub(crate) kinds: Option<Vec<u16>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct RankedCount {
    pub(crate) key: String,
    pub(crate) count: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct RecentIndexedEvent {
    pub(crate) id: String,
    pub(crate) pubkey: String,
    pub(crate) created_at: u64,
    pub(crate) kind: u32,
    pub(crate) hashtags: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct IndexedNostrReport {
    pub(crate) root: Option<String>,
    pub(crate) authors_considered: usize,
    pub(crate) events_seen: usize,
    pub(crate) events_selected: usize,
    pub(crate) live_bytes_selected: u64,
    pub(crate) warm_graph_seconds: u64,
    pub(crate) graph_crawl_depth: u32,
    pub(crate) full_graph_recrawl: bool,
    pub(crate) max_follow_distance: Option<u32>,
    pub(crate) max_authors: usize,
    pub(crate) max_live_bytes: u64,
    pub(crate) per_author_live_bytes: Option<u64>,
    pub(crate) global_relay_scan: bool,
    pub(crate) relay_page_size: usize,
    pub(crate) max_relay_pages: usize,
    pub(crate) relays: Vec<String>,
    pub(crate) top_authors: Vec<RankedCount>,
    pub(crate) top_kinds: Vec<RankedCount>,
    pub(crate) top_hashtags: Vec<RankedCount>,
    pub(crate) recent_events: Vec<RecentIndexedEvent>,
}

pub(crate) async fn run_socialgraph_index_from_cli(
    data_dir: PathBuf,
    options: SocialGraphIndexOptions,
) -> Result<IndexedNostrReport> {
    let config = Config::load()?;
    let (keys, _) = ensure_keys()?;
    run_socialgraph_index(data_dir, &config, keys, options).await
}

pub(crate) async fn run_socialgraph_index(
    data_dir: PathBuf,
    config: &Config,
    keys: Keys,
    options: SocialGraphIndexOptions,
) -> Result<IndexedNostrReport> {
    let max_size_bytes = config.storage.max_size_gb * 1024 * 1024 * 1024;
    let store = Arc::new(HashtreeStore::with_options(
        &data_dir,
        config.storage.s3.as_ref(),
        max_size_bytes,
    )?);

    let ndb = socialgraph::init_ndb_with_store(
        &data_dir,
        store.store_arc(),
        Some(
            config
                .nostr
                .db_max_size_gb
                .saturating_mul(1024 * 1024 * 1024),
        ),
    )
    .context("Failed to initialize social graph store")?;

    let root_pk = if let Some(root_npub) = config.nostr.socialgraph_root.as_deref() {
        parse_npub(root_npub).unwrap_or_else(|_| keys.public_key().to_bytes())
    } else {
        keys.public_key().to_bytes()
    };
    socialgraph::set_social_graph_root(&ndb, &root_pk);
    let relays = options
        .relays
        .clone()
        .filter(|relays| !relays.is_empty())
        .unwrap_or_else(|| config.nostr.relays.clone());

    if !options.warm_graph_for.is_zero() {
        warm_social_graph(
            ndb.clone(),
            keys.clone(),
            relays.clone(),
            options.graph_crawl_depth,
            options.full_graph_recrawl,
            options.warm_graph_for,
        )
        .await?;
    }

    let graph = load_bridge_graph(ndb.as_ref(), &root_pk)?;
    let existing_root = load_existing_root(&data_dir)?;

    let bridge = NostrBridge::new(
        store.store_arc(),
        CrawlConfig {
            relays: relays.clone(),
            max_live_bytes: Some(options.max_live_bytes),
            max_authors: Some(options.max_authors),
            max_follow_distance: options.max_follow_distance,
            author_batch_size: options.author_batch_size,
            per_author_event_limit: options.per_author_event_limit,
            per_author_live_bytes: options.per_author_live_bytes,
            fetch_timeout: options.fetch_timeout,
            relay_fetch_mode: if options.global_relay_scan {
                RelayFetchMode::GlobalRecent
            } else {
                RelayFetchMode::AuthorBatches
            },
            relay_page_size: options.relay_page_size,
            max_relay_pages: options.max_relay_pages,
            kinds: options.kinds.clone(),
        },
    );

    let report = bridge.crawl(&graph, existing_root.as_ref()).await?;
    let index_report = build_report(
        &NostrEventStore::new(store.store_arc()),
        &relays,
        &options,
        report,
    )
    .await?;
    persist_report(&data_dir, &index_report)?;
    print_report(&index_report, &data_dir);
    Ok(index_report)
}

fn load_bridge_graph(backend: &dyn SocialGraphBackend, root_pk: &[u8; 32]) -> Result<SocialGraph> {
    let chunks = backend
        .snapshot_chunks(root_pk, &BinaryBudget::default())
        .context("build social graph snapshot for bridge")?;
    let mut data = Vec::with_capacity(chunks.iter().map(|chunk| chunk.len()).sum());
    for chunk in chunks {
        data.extend_from_slice(&chunk);
    }
    SocialGraph::from_binary(&hex::encode(root_pk), &data)
        .context("load social graph snapshot into bridge graph")
}

async fn warm_social_graph(
    ndb: Arc<dyn SocialGraphBackend>,
    keys: Keys,
    relays: Vec<String>,
    crawl_depth: u32,
    full_graph_recrawl: bool,
    duration: Duration,
) -> Result<()> {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let crawler = SocialGraphCrawler::new(ndb, keys, relays, crawl_depth)
        .with_full_recrawl(full_graph_recrawl);
    let mut handle = tokio::spawn(async move {
        crawler.crawl(shutdown_rx).await;
    });

    tokio::time::sleep(duration).await;
    let _ = shutdown_tx.send(true);

    match tokio::time::timeout(Duration::from_secs(5), &mut handle).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(anyhow::anyhow!("social graph warmup task failed: {err}")),
        Err(_) => {
            handle.abort();
            match handle.await {
                Err(err) if err.is_cancelled() => Ok(()),
                Ok(()) => Ok(()),
                Err(err) => Err(anyhow::anyhow!(
                    "social graph warmup task failed after abort: {err}"
                )),
            }
        }
    }
}

async fn build_report(
    event_store: &NostrEventStore<hashtree_cli::storage::StorageRouter>,
    relays: &[String],
    options: &SocialGraphIndexOptions,
    crawl_report: CrawlReport,
) -> Result<IndexedNostrReport> {
    let root = crawl_report.root.as_ref().map(ToString::to_string);
    let mut events = if let Some(root_cid) = crawl_report.root.as_ref() {
        event_store
            .list_recent(Some(root_cid), ListEventsOptions::default())
            .await?
    } else {
        Vec::new()
    };

    let mut by_author: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_kind: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_hashtag: BTreeMap<String, usize> = BTreeMap::new();

    for event in &events {
        *by_author.entry(event.pubkey.clone()).or_default() += 1;
        *by_kind.entry(event.kind.to_string()).or_default() += 1;
        for hashtag in hashtags(event) {
            *by_hashtag.entry(hashtag).or_default() += 1;
        }
    }

    events.truncate(TOP_ITEMS_LIMIT);

    Ok(IndexedNostrReport {
        root,
        authors_considered: crawl_report.authors_considered,
        events_seen: crawl_report.events_seen,
        events_selected: crawl_report.events_selected,
        live_bytes_selected: crawl_report.live_bytes_selected,
        warm_graph_seconds: options.warm_graph_for.as_secs(),
        graph_crawl_depth: options.graph_crawl_depth,
        full_graph_recrawl: options.full_graph_recrawl,
        max_follow_distance: options.max_follow_distance,
        max_authors: options.max_authors,
        max_live_bytes: options.max_live_bytes,
        per_author_live_bytes: options.per_author_live_bytes,
        global_relay_scan: options.global_relay_scan,
        relay_page_size: options.relay_page_size,
        max_relay_pages: options.max_relay_pages,
        relays: relays.to_vec(),
        top_authors: ranked_counts(by_author),
        top_kinds: ranked_counts(by_kind),
        top_hashtags: ranked_counts(by_hashtag),
        recent_events: events
            .into_iter()
            .map(|event| RecentIndexedEvent {
                hashtags: hashtags(&event),
                id: event.id,
                pubkey: event.pubkey,
                created_at: event.created_at,
                kind: event.kind,
            })
            .collect(),
    })
}

fn ranked_counts(counts: BTreeMap<String, usize>) -> Vec<RankedCount> {
    let mut out: Vec<RankedCount> = counts
        .into_iter()
        .map(|(key, count)| RankedCount { key, count })
        .collect();
    out.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.key.cmp(&right.key))
    });
    out.truncate(TOP_ITEMS_LIMIT);
    out
}

fn hashtags(event: &StoredNostrEvent) -> Vec<String> {
    let mut out = Vec::new();
    for tag in &event.tags {
        if tag.first().is_some_and(|name| name == "t") {
            if let Some(value) = tag.get(1) {
                if !value.is_empty() {
                    out.push(value.to_lowercase());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn persist_report(data_dir: &Path, report: &IndexedNostrReport) -> Result<()> {
    let output_dir = data_dir.join(INDEX_DIR);
    std::fs::create_dir_all(&output_dir)?;

    let report_path = output_dir.join(LATEST_REPORT_FILE);
    std::fs::write(&report_path, serde_json::to_vec_pretty(report)?)?;

    let root_path = output_dir.join(LATEST_ROOT_FILE);
    if let Some(root) = &report.root {
        std::fs::write(root_path, format!("{root}\n"))?;
    } else if root_path.exists() {
        std::fs::remove_file(root_path)?;
    }

    Ok(())
}

fn load_existing_root(data_dir: &Path) -> Result<Option<Cid>> {
    let root_path = data_dir.join(INDEX_DIR).join(LATEST_ROOT_FILE);
    if !root_path.exists() {
        return Ok(None);
    }

    let root = std::fs::read_to_string(&root_path)
        .with_context(|| format!("read {}", root_path.display()))?;
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    Cid::parse(trimmed).map(Some).with_context(|| {
        format!(
            "parse existing nostr index root from {}",
            root_path.display()
        )
    })
}

fn print_report(report: &IndexedNostrReport, data_dir: &Path) {
    println!(
        "Indexed {} events from {} authors (saw {} relay events, kept {} bytes)",
        report.events_selected,
        report.authors_considered,
        report.events_seen,
        report.live_bytes_selected
    );
    println!(
        "Graph warm: {}s depth {} ({})",
        report.warm_graph_seconds,
        report.graph_crawl_depth,
        if report.full_graph_recrawl {
            "full recrawl"
        } else {
            "incremental"
        }
    );
    println!(
        "Relay mode: {}",
        if report.global_relay_scan {
            format!(
                "global recent scan (page size {}, max pages {})",
                report.relay_page_size, report.max_relay_pages
            )
        } else {
            "author batches with negentropy".to_string()
        }
    );

    if let Some(root) = &report.root {
        println!("Root: {}", root);
    } else {
        println!("Root: <empty>");
    }

    println!(
        "Saved: {}",
        data_dir.join(INDEX_DIR).join(LATEST_REPORT_FILE).display()
    );

    if !report.top_hashtags.is_empty() {
        let preview = report
            .top_hashtags
            .iter()
            .take(5)
            .map(|entry| format!("{} ({})", entry.key, entry.count))
            .collect::<Vec<_>>()
            .join(", ");
        println!("Top hashtags: {}", preview);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::net::TcpListener;
    use std::sync::Mutex;

    use futures::{SinkExt, StreamExt};
    use hashtree_nostr::NostrEventStore;
    use nostr::prelude::{EventBuilder, Kind, Tag, Timestamp};
    use nostr_sdk::Client;
    use serde_json::Value;
    use tempfile::TempDir;
    use tokio::net::TcpStream;
    use tokio::sync::broadcast;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    struct TestRelay {
        port: u16,
        shutdown: broadcast::Sender<()>,
    }

    impl TestRelay {
        fn new() -> Self {
            let events = Arc::new(Mutex::new(Vec::new()));
            let (shutdown, _) = broadcast::channel(1);

            let std_listener = TcpListener::bind("127.0.0.1:0").expect("bind relay listener");
            let port = std_listener.local_addr().expect("relay local addr").port();
            std_listener.set_nonblocking(true).expect("set nonblocking");

            let events_for_thread = Arc::clone(&events);
            let shutdown_for_thread = shutdown.clone();

            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .expect("build tokio runtime");

                rt.block_on(async move {
                    let listener =
                        tokio::net::TcpListener::from_std(std_listener).expect("tokio listener");
                    let mut shutdown_rx = shutdown_for_thread.subscribe();

                    loop {
                        tokio::select! {
                            _ = shutdown_rx.recv() => break,
                            accept = listener.accept() => {
                                if let Ok((stream, _)) = accept {
                                    let events = Arc::clone(&events_for_thread);
                                    tokio::spawn(async move {
                                        handle_connection(stream, events).await;
                                    });
                                }
                            }
                        }
                    }
                });
            });

            std::thread::sleep(Duration::from_millis(100));

            Self { port, shutdown }
        }

        fn url(&self) -> String {
            format!("ws://127.0.0.1:{}", self.port)
        }
    }

    impl Drop for TestRelay {
        fn drop(&mut self) {
            let _ = self.shutdown.send(());
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn event_matches_filter(event: &Value, filter: &Value) -> bool {
        let Some(filter_obj) = filter.as_object() else {
            return true;
        };

        if let Some(authors) = filter_obj.get("authors").and_then(Value::as_array) {
            let accepted: Vec<&str> = authors.iter().filter_map(Value::as_str).collect();
            let author = event
                .get("pubkey")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !accepted.is_empty() && !accepted.contains(&author) {
                return false;
            }
        }

        if let Some(kinds) = filter_obj.get("kinds").and_then(Value::as_array) {
            let event_kind = event
                .get("kind")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            if !kinds
                .iter()
                .any(|kind| kind.as_i64().is_some_and(|value| value == event_kind))
            {
                return false;
            }
        }

        true
    }

    async fn handle_connection(stream: TcpStream, events: Arc<Mutex<Vec<Value>>>) {
        let ws_stream = match accept_async(stream).await {
            Ok(ws) => ws,
            Err(_) => return,
        };

        let (mut write, mut read) = ws_stream.split();

        while let Some(msg) = read.next().await {
            let msg = match msg {
                Ok(Message::Text(text)) => text,
                Ok(Message::Ping(data)) => {
                    let _ = write.send(Message::Pong(data)).await;
                    continue;
                }
                Ok(Message::Close(_)) => break,
                _ => continue,
            };

            let parsed: Vec<Value> = match serde_json::from_str(&msg) {
                Ok(value) => value,
                Err(_) => continue,
            };

            match parsed.first().and_then(Value::as_str) {
                Some("EVENT") => {
                    let Some(event) = parsed.get(1).cloned() else {
                        continue;
                    };
                    let Some(id) = event.get("id").and_then(Value::as_str).map(str::to_owned)
                    else {
                        continue;
                    };
                    events.lock().expect("relay events lock").push(event);
                    let ok = serde_json::json!(["OK", id, true, ""]);
                    let _ = write.send(Message::Text(ok.to_string())).await;
                }
                Some("REQ") => {
                    let Some(sub_id) = parsed.get(1).and_then(Value::as_str) else {
                        continue;
                    };
                    let filters: Vec<Value> = parsed.iter().skip(2).cloned().collect();
                    let snapshot = events.lock().expect("relay events lock").clone();
                    for event in snapshot {
                        let matched = if filters.is_empty() {
                            true
                        } else {
                            filters
                                .iter()
                                .any(|filter| event_matches_filter(&event, filter))
                        };
                        if matched {
                            let msg = serde_json::json!(["EVENT", sub_id, event]);
                            let _ = write.send(Message::Text(msg.to_string())).await;
                        }
                    }
                    let eose = serde_json::json!(["EOSE", sub_id]);
                    let _ = write.send(Message::Text(eose.to_string())).await;
                }
                _ => {}
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn warms_social_graph_and_persists_index_report() -> io::Result<()> {
        let relay = TestRelay::new();
        let relay_url = relay.url();

        let tmp = TempDir::new().expect("tempdir");
        let root_keys = Keys::generate();
        let alice_keys = Keys::generate();

        let contact_list = EventBuilder::new(
            Kind::ContactList,
            "",
            [Tag::parse(&["p", &alice_keys.public_key().to_hex()]).expect("p tag")],
        )
        .custom_created_at(Timestamp::from_secs(10))
        .to_event(&root_keys)
        .expect("contact list");

        let alice_note = EventBuilder::new(
            Kind::TextNote,
            "alice nostr note",
            [Tag::parse(&["t", "nostr"]).expect("t tag")],
        )
        .custom_created_at(Timestamp::from_secs(20))
        .to_event(&alice_keys)
        .expect("alice note");

        let publisher = Client::new(Keys::generate());
        publisher.add_relay(&relay_url).await.expect("add relay");
        publisher.connect().await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        for event in [&contact_list, &alice_note] {
            publisher
                .send_event(event.clone())
                .await
                .expect("publish test event");
        }

        let mut config = Config::default();
        config.nostr.relays = vec![relay_url];
        config.nostr.crawl_depth = 1;
        config.storage.max_size_gb = 1;

        let report = run_socialgraph_index(
            tmp.path().to_path_buf(),
            &config,
            root_keys.clone(),
            SocialGraphIndexOptions {
                warm_graph_for: Duration::from_secs(1),
                graph_crawl_depth: 1,
                full_graph_recrawl: false,
                relays: None,
                max_authors: 8,
                max_follow_distance: Some(1),
                max_live_bytes: 8 * 1024 * 1024,
                author_batch_size: 32,
                per_author_event_limit: 8,
                per_author_live_bytes: None,
                fetch_timeout: Duration::from_secs(5),
                global_relay_scan: false,
                relay_page_size: 1_000,
                max_relay_pages: 10,
                kinds: None,
            },
        )
        .await
        .expect("run index");

        assert_eq!(report.authors_considered, 2);
        assert!(report.events_selected >= 2);
        assert_eq!(
            report.top_hashtags.first(),
            Some(&RankedCount {
                key: "nostr".to_string(),
                count: 1
            })
        );

        let report_path = tmp.path().join(INDEX_DIR).join(LATEST_REPORT_FILE);
        let root_path = tmp.path().join(INDEX_DIR).join(LATEST_ROOT_FILE);
        assert!(report_path.exists());
        assert!(root_path.exists());

        let saved_report: IndexedNostrReport =
            serde_json::from_slice(&std::fs::read(&report_path).expect("read report"))
                .expect("parse report");
        assert_eq!(saved_report.root, report.root);

        let store = HashtreeStore::with_options(tmp.path(), None, 1024 * 1024 * 1024)
            .expect("reopen store");
        let event_store = NostrEventStore::new(store.store_arc());
        let root = hashtree_core::Cid::parse(report.root.as_deref().expect("root string"))
            .expect("parse cid");
        let hashtagged = event_store
            .list_by_tag(
                Some(&root),
                "t",
                "nostr",
                ListEventsOptions { limit: Some(10) },
            )
            .await
            .expect("query hashtag");

        assert_eq!(hashtagged.len(), 1);
        assert_eq!(hashtagged[0].id, alice_note.id.to_hex());

        Ok(())
    }

    #[test]
    fn loads_existing_root_from_latest_root_file() {
        let tmp = TempDir::new().expect("tempdir");
        let index_dir = tmp.path().join(INDEX_DIR);
        std::fs::create_dir_all(&index_dir).expect("create index dir");
        let cid =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
        std::fs::write(index_dir.join(LATEST_ROOT_FILE), format!("{cid}\n"))
            .expect("write latest root");

        let loaded = load_existing_root(tmp.path()).expect("load root");
        assert_eq!(loaded.expect("existing root").to_string(), cid);
    }
}
