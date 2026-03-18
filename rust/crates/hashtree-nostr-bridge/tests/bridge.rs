use std::io;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use hashtree_core::MemoryStore;
use hashtree_nostr::{ListEventsOptions, NostrEventStore, StoredNostrEvent};
use hashtree_nostr_bridge::{CrawlConfig, NostrBridge};
use nostr::prelude::{Event, EventBuilder, Kind, Tag, Timestamp};
use nostr_sdk::{Client, Keys};
use nostr_social_graph::{NostrEvent as GraphEvent, SocialGraph};
use serde_json::Value;
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
                let Some(id) = event.get("id").and_then(Value::as_str).map(str::to_owned) else {
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

fn graph_event_from_nostr(event: &Event) -> GraphEvent {
    GraphEvent {
        created_at: event.created_at.as_u64(),
        content: event.content.clone(),
        tags: event
            .tags
            .iter()
            .map(|tag: &Tag| tag.as_slice().to_vec())
            .collect(),
        kind: event.kind.as_u16() as u32,
        pubkey: event.pubkey.to_hex(),
        id: event.id.to_hex(),
        sig: event.sig.to_string(),
    }
}

fn stored_event_from_nostr(event: &Event) -> StoredNostrEvent {
    StoredNostrEvent {
        id: event.id.to_hex(),
        pubkey: event.pubkey.to_hex(),
        created_at: event.created_at.as_u64(),
        kind: event.kind.as_u16() as u32,
        tags: event.tags.iter().map(|tag: &Tag| tag.as_slice().to_vec()).collect(),
        content: event.content.clone(),
        sig: event.sig.to_string(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crawls_followed_authors_and_applies_per_author_priority_limit() -> io::Result<()> {
    let relay = TestRelay::new();
    let relay_url = relay.url();

    let root_keys = Keys::generate();
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();

    let mut graph = SocialGraph::new(&root_keys.public_key().to_hex());
    let contact_list = EventBuilder::new(
        Kind::ContactList,
        "",
        [Tag::parse(&["p", &alice_keys.public_key().to_hex()]).expect("p tag")],
    )
    .custom_created_at(Timestamp::from_secs(10))
    .to_event(&root_keys)
    .expect("contact list");
    graph.handle_event(&graph_event_from_nostr(&contact_list), true, 1.0);

    let publisher = Client::new(Keys::generate());
    publisher.add_relay(&relay_url).await.expect("add relay");
    publisher.connect().await;
    tokio::time::sleep(Duration::from_millis(250)).await;

    let alice_old = EventBuilder::new(
        Kind::TextNote,
        "older nostr note",
        [Tag::parse(&["t", "nostr"]).expect("t tag")],
    )
    .custom_created_at(Timestamp::from_secs(20))
    .to_event(&alice_keys)
    .expect("alice old");
    let alice_new = EventBuilder::new(
        Kind::TextNote,
        "newer nostr note",
        [Tag::parse(&["t", "nostr"]).expect("t tag")],
    )
    .custom_created_at(Timestamp::from_secs(30))
    .to_event(&alice_keys)
    .expect("alice new");
    let alice_low_priority = EventBuilder::new(
        Kind::Custom(7),
        "reaction-ish",
        [Tag::parse(&["t", "nostr"]).expect("t tag")],
    )
    .custom_created_at(Timestamp::from_secs(40))
    .to_event(&alice_keys)
    .expect("alice low priority");
    let bob_note = EventBuilder::new(
        Kind::TextNote,
        "bob note",
        [Tag::parse(&["t", "nostr"]).expect("t tag")],
    )
    .custom_created_at(Timestamp::from_secs(50))
    .to_event(&bob_keys)
    .expect("bob note");

    for event in [&alice_old, &alice_new, &alice_low_priority, &bob_note] {
        publisher
            .send_event(event.clone())
            .await
            .expect("publish test event");
    }

    let store = Arc::new(MemoryStore::new());
    let bridge = NostrBridge::new(
        store.clone(),
        CrawlConfig {
            relays: vec![relay_url],
            per_author_event_limit: 2,
            kinds: Some(vec![1, 7]),
            ..CrawlConfig::default()
        },
    );

    let report = bridge.crawl(&graph, None).await.expect("crawl report");
    let root = report.root.expect("index root");
    let event_store = hashtree_nostr::NostrEventStore::new(store);

    let nostr_events = event_store
        .list_by_tag(
            Some(&root),
            "t",
            "nostr",
            ListEventsOptions { limit: Some(10) },
        )
        .await
        .expect("query hashtag");

    assert_eq!(nostr_events.len(), 2);
    assert!(nostr_events
        .iter()
        .all(|event| event.pubkey == alice_keys.public_key().to_hex()));
    assert!(nostr_events.iter().all(|event| event.kind == 1));

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enforces_global_live_byte_cap_after_priority_selection() -> io::Result<()> {
    let relay = TestRelay::new();
    let relay_url = relay.url();

    let root_keys = Keys::generate();
    let alice_keys = Keys::generate();

    let mut graph = SocialGraph::new(&root_keys.public_key().to_hex());
    let contact_list = EventBuilder::new(
        Kind::ContactList,
        "",
        [Tag::parse(&["p", &alice_keys.public_key().to_hex()]).expect("p tag")],
    )
    .custom_created_at(Timestamp::from_secs(10))
    .to_event(&root_keys)
    .expect("contact list");
    graph.handle_event(&graph_event_from_nostr(&contact_list), true, 1.0);

    let publisher = Client::new(Keys::generate());
    publisher
        .add_relay(&relay_url)
        .await
        .expect("add relay");
    publisher.connect().await;
    tokio::time::sleep(Duration::from_millis(250)).await;

    let note_one = EventBuilder::new(
        Kind::TextNote,
        "note one",
        [Tag::parse(&["t", "nostr"]).expect("t tag")],
    )
    .custom_created_at(Timestamp::from_secs(20))
    .to_event(&alice_keys)
    .expect("note one");
    let note_two = EventBuilder::new(
        Kind::TextNote,
        "note two",
        [Tag::parse(&["t", "nostr"]).expect("t tag")],
    )
    .custom_created_at(Timestamp::from_secs(30))
    .to_event(&alice_keys)
    .expect("note two");
    let note_three = EventBuilder::new(
        Kind::TextNote,
        "note three",
        [Tag::parse(&["t", "nostr"]).expect("t tag")],
    )
    .custom_created_at(Timestamp::from_secs(40))
    .to_event(&alice_keys)
    .expect("note three");

    for event in [&note_one, &note_two, &note_three] {
        publisher
            .send_event(event.clone())
            .await
            .expect("publish test event");
    }

    let sizing_store = NostrEventStore::new(Arc::new(MemoryStore::new()));
    let retained_size = sizing_store
        .encode_event(&stored_event_from_nostr(&note_three))
        .expect("encode newest")
        .len() as u64
        + sizing_store
            .encode_event(&stored_event_from_nostr(&note_two))
            .expect("encode middle")
            .len() as u64;

    let store = Arc::new(MemoryStore::new());
    let bridge = NostrBridge::new(
        store.clone(),
        CrawlConfig {
            relays: vec![relay_url],
            per_author_event_limit: 8,
            max_live_bytes: Some(retained_size),
            kinds: Some(vec![1]),
            ..CrawlConfig::default()
        },
    );

    let report = bridge.crawl(&graph, None).await.expect("crawl report");
    let root = report.root.expect("index root");
    let event_store = NostrEventStore::new(store);

    let nostr_events = event_store
        .list_by_tag(
            Some(&root),
            "t",
            "nostr",
            ListEventsOptions { limit: Some(10) },
        )
        .await
        .expect("query hashtag");

    assert_eq!(report.events_selected, 2);
    assert_eq!(nostr_events.len(), 2);
    assert_eq!(nostr_events[0].id, note_three.id.to_hex());
    assert_eq!(nostr_events[1].id, note_two.id.to_hex());

    Ok(())
}
