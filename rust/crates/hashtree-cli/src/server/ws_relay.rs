use axum::{
    extract::{State, ws::{WebSocketUpgrade, WebSocket, Message}},
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use hashtree_core::from_hex;
use nostr::{ClientMessage as NostrClientMessage, JsonUtil as NostrJsonUtil, RelayMessage as NostrRelayMessage};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, time::Duration};
use tokio::sync::mpsc;

use crate::webrtc::types::{DataMessage, DataRequest, DataResponse, MAX_HTL, encode_request, encode_response, parse_message};
use hex::encode as hex_encode;
use super::auth::{AppState, PendingRequest, WsProtocol};

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WsClientMessage {
    #[serde(rename = "req")]
    Request { id: u32, hash: String },
    #[serde(rename = "res")]
    Response { id: u32, hash: String, found: bool },
}

#[derive(Debug)]
enum WsTextMessage {
    Hashtree(WsClientMessage),
    Nostr(NostrClientMessage),
}

#[derive(Debug, Deserialize, Serialize)]
struct WsRequest {
    #[serde(rename = "type")]
    kind: String,
    id: u32,
    hash: String,
}

#[derive(Debug, Serialize)]
struct WsResponse {
    #[serde(rename = "type")]
    kind: &'static str,
    id: u32,
    hash: String,
    found: bool,
}

pub async fn ws_data(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let client_id = state.ws_relay.next_id();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    {
        let mut clients = state.ws_relay.clients.lock().await;
        clients.insert(client_id, tx);
    }

    // Register Nostr relay client if enabled
    if let Some(relay) = state.nostr_relay.clone() {
        let (nostr_tx, mut nostr_rx) = mpsc::unbounded_channel::<String>();
        relay.register_client(client_id, nostr_tx, None).await;
        let ws_sender = {
            let clients = state.ws_relay.clients.lock().await;
            clients.get(&client_id).cloned()
        };
        if let Some(ws_sender) = ws_sender {
            tokio::spawn(async move {
                while let Some(text) = nostr_rx.recv().await {
                    if ws_sender.send(Message::Text(text)).is_err() {
                        break;
                    }
                }
            });
        }
    }

    let (mut sender, mut receiver) = socket.split();
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    let recv_state = state.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            handle_message(client_id, msg, &recv_state).await;
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }

    {
        let mut clients = state.ws_relay.clients.lock().await;
        clients.remove(&client_id);
    }
    {
        let mut protocols = state.ws_relay.client_protocols.lock().await;
        protocols.remove(&client_id);
    }
    {
        let mut pending = state.ws_relay.pending.lock().await;
        pending.retain(|(peer_id, _), _| *peer_id != client_id);
    }

    if let Some(relay) = &state.nostr_relay {
        relay.unregister_client(client_id).await;
    }
}

fn parse_ws_text_message(text: &str) -> Option<WsTextMessage> {
    let trimmed = text.trim_start();
    if trimmed.starts_with('[') {
        if let Ok(msg) = NostrClientMessage::from_json(trimmed) {
            return Some(WsTextMessage::Nostr(msg));
        }
    }

    if let Ok(msg) = serde_json::from_str::<WsClientMessage>(text) {
        return Some(WsTextMessage::Hashtree(msg));
    }

    None
}

async fn handle_message(client_id: u64, msg: Message, state: &AppState) {
    match msg {
        Message::Text(text) => {
            if let Some(msg) = parse_ws_text_message(&text) {
                match msg {
                    WsTextMessage::Hashtree(msg) => {
                        set_client_protocol(state, client_id, WsProtocol::HashtreeJson).await;
                        match msg {
                            WsClientMessage::Request { id, hash } => {
                                handle_request(client_id, id, hash, WsProtocol::HashtreeJson, state).await;
                            }
                            WsClientMessage::Response { id, hash, found } => {
                                handle_response(client_id, id, hash, found, state).await;
                            }
                        }
                    }
                    WsTextMessage::Nostr(msg) => {
                        if let Some(relay) = &state.nostr_relay {
                            relay.handle_client_message(client_id, msg).await;
                        } else {
                            handle_nostr_message(client_id, msg, state).await;
                        }
                    }
                }
            }
        }
        Message::Binary(data) => {
            handle_binary(client_id, data, state).await;
        }
        Message::Close(_) => {}
        _ => {}
    }
}

async fn handle_request(
    client_id: u64,
    request_id: u32,
    hash: String,
    origin_protocol: WsProtocol,
    state: &AppState,
) {
    let hash_hex = hash.to_lowercase();
    let hash_bytes = match from_hex(&hash_hex) {
        Ok(bytes) => bytes,
        Err(_) => {
            if origin_protocol == WsProtocol::HashtreeJson {
                send_json(
                    state,
                    client_id,
                    WsResponse { kind: "res", id: request_id, hash, found: false },
                ).await;
            }
            return;
        }
    };

    if let Ok(Some(data)) = state.store.get_blob(&hash_bytes) {
        match origin_protocol {
            WsProtocol::HashtreeJson => {
                send_json(
                    state,
                    client_id,
                    WsResponse { kind: "res", id: request_id, hash: hash.clone(), found: true },
                ).await;
                send_binary(state, client_id, request_id, data).await;
            }
            WsProtocol::HashtreeMsgpack => {
                send_msgpack_response(state, client_id, &hash_bytes, &data).await;
            }
            WsProtocol::Unknown => {}
        }
        return;
    }

    let peers: Vec<(u64, mpsc::UnboundedSender<Message>, WsProtocol)> = {
        let clients = state.ws_relay.clients.lock().await;
        let protocols = state.ws_relay.client_protocols.lock().await;
        clients
            .iter()
            .filter(|(id, _)| **id != client_id)
            .filter_map(|(id, tx)| {
                let protocol = protocols.get(id).copied().unwrap_or(WsProtocol::Unknown);
                match protocol {
                    WsProtocol::HashtreeJson | WsProtocol::HashtreeMsgpack => {
                        Some((*id, tx.clone(), protocol))
                    }
                    WsProtocol::Unknown => None,
                }
            })
            .collect()
    };

    if peers.is_empty() {
        if origin_protocol == WsProtocol::HashtreeJson {
            send_json(
                state,
                client_id,
                WsResponse { kind: "res", id: request_id, hash, found: false },
            ).await;
        }
        return;
    }

    {
        let mut pending = state.ws_relay.pending.lock().await;
        for (peer_id, _, _) in &peers {
            pending.insert(
                (*peer_id, request_id),
                PendingRequest {
                    origin_id: client_id,
                    hash: hash.clone(),
                    found: false,
                    origin_protocol,
                },
            );
        }
    }

    let request_text = serde_json::to_string(&WsRequest {
        kind: "req".to_string(),
        id: request_id,
        hash: hash.clone(),
    }).unwrap_or_else(|_| String::new());
    for (peer_id, tx, protocol) in peers {
        match protocol {
            WsProtocol::HashtreeMsgpack => {
                let _ = send_msgpack_request(state, peer_id, &hash_bytes).await;
            }
            WsProtocol::HashtreeJson => {
                let _ = tx.send(Message::Text(request_text.clone()));
            }
            WsProtocol::Unknown => {}
        }
    }

    let timeout_state = state.clone();
    let timeout_hash = hash.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let mut pending = timeout_state.ws_relay.pending.lock().await;
        let still_pending = pending.iter().any(|((_, id), p)| *id == request_id && p.origin_id == client_id);
        let already_found = pending.iter().any(|((_, id), p)| *id == request_id && p.origin_id == client_id && p.found);
        if !still_pending || already_found {
            return;
        }
        let origin_protocol = pending
            .iter()
            .find(|((_, id), p)| *id == request_id && p.origin_id == client_id)
            .map(|(_, p)| p.origin_protocol)
            .unwrap_or(WsProtocol::HashtreeJson);
        pending.retain(|(_, id), p| !(*id == request_id && p.origin_id == client_id));
        drop(pending);
        if origin_protocol == WsProtocol::HashtreeJson {
            send_json(
                &timeout_state,
                client_id,
                WsResponse { kind: "res", id: request_id, hash: timeout_hash, found: false },
            ).await;
        }
    });
}

async fn handle_response(
    client_id: u64,
    request_id: u32,
    _hash: String,
    found: bool,
    state: &AppState,
) {
    let pending_entry = {
        let pending = state.ws_relay.pending.lock().await;
        pending
            .get(&(client_id, request_id))
            .map(|p| (p.origin_id, p.hash.clone(), p.found, p.origin_protocol))
    };

    let Some((origin_id, pending_hash, already_found, origin_protocol)) = pending_entry else {
        return;
    };

    if already_found && !found {
        let mut pending = state.ws_relay.pending.lock().await;
        pending.remove(&(client_id, request_id));
        return;
    }

    if found {
        let mut pending = state.ws_relay.pending.lock().await;
        for ((_, id), p) in pending.iter_mut() {
            if *id == request_id && p.origin_id == origin_id {
                p.found = true;
            }
        }
        drop(pending);
        if origin_protocol == WsProtocol::HashtreeJson {
            send_json(
                state,
                origin_id,
                WsResponse { kind: "res", id: request_id, hash: pending_hash, found: true },
            ).await;
        }
        return;
    }

    let mut pending = state.ws_relay.pending.lock().await;
    pending.remove(&(client_id, request_id));
    let has_remaining = pending
        .iter()
        .any(|((_, id), p)| *id == request_id && p.origin_id == origin_id);
    drop(pending);

    if !has_remaining && origin_protocol == WsProtocol::HashtreeJson {
        send_json(
            state,
            origin_id,
            WsResponse { kind: "res", id: request_id, hash: pending_hash, found: false },
        ).await;
    }
}

async fn handle_binary(client_id: u64, data: Vec<u8>, state: &AppState) {
    if let Some(msg) = parse_msgpack_message(&data) {
        set_client_protocol(state, client_id, WsProtocol::HashtreeMsgpack).await;
        match msg {
            DataMessage::Request(req) => {
                let hash_hex = hex_encode(&req.h);
                let request_id = state.ws_relay.next_request_id();
                handle_request(client_id, request_id, hash_hex, WsProtocol::HashtreeMsgpack, state).await;
            }
            DataMessage::Response(res) => {
                handle_msgpack_response(client_id, res, state).await;
            }
        }
        return;
    }

    // Legacy binary: [4-byte LE request_id][data]
    if data.len() < 4 {
        return;
    }
    let request_id = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    let pending_entry = {
        let pending = state.ws_relay.pending.lock().await;
        pending
            .get(&(client_id, request_id))
            .map(|p| (p.origin_id, p.hash.clone(), p.origin_protocol))
    };
    let Some((origin_id, hash_hex, origin_protocol)) = pending_entry else {
        return;
    };

    match origin_protocol {
        WsProtocol::HashtreeJson => {
            send_binary(state, origin_id, request_id, data[4..].to_vec()).await;
        }
        WsProtocol::HashtreeMsgpack => {
            let Ok(hash_bytes) = from_hex(&hash_hex) else {
                return;
            };
            send_msgpack_response(state, origin_id, &hash_bytes, &data[4..]).await;
        }
        WsProtocol::Unknown => {}
    }

    let mut pending = state.ws_relay.pending.lock().await;
    pending.retain(|(_, id), p| !(*id == request_id && p.origin_id == origin_id));
}

async fn handle_nostr_message(
    client_id: u64,
    msg: NostrClientMessage,
    state: &AppState,
) {
    let replies = nostr_responses_for(&msg);
    for reply in replies {
        send_nostr(state, client_id, reply).await;
    }
}

fn nostr_responses_for(msg: &NostrClientMessage) -> Vec<NostrRelayMessage> {
    match msg {
        NostrClientMessage::Event(event) => {
            let ok = event.verify().is_ok();
            let message = if ok { "" } else { "invalid: signature" };
            vec![NostrRelayMessage::ok(event.id, ok, message)]
        }
        NostrClientMessage::Req { subscription_id, .. } => {
            vec![NostrRelayMessage::eose(subscription_id.clone())]
        }
        NostrClientMessage::Count { subscription_id, .. } => {
            vec![NostrRelayMessage::count(subscription_id.clone(), 0)]
        }
        NostrClientMessage::Close(_) => Vec::new(),
        NostrClientMessage::Auth(event) => {
            let ok = event.verify().is_ok();
            let message = if ok { "" } else { "invalid auth" };
            vec![NostrRelayMessage::ok(event.id, ok, message)]
        }
        NostrClientMessage::NegOpen { .. }
        | NostrClientMessage::NegMsg { .. }
        | NostrClientMessage::NegClose { .. } => {
            vec![NostrRelayMessage::notice("negentropy not supported")]
        }
    }
}

async fn send_nostr(state: &AppState, client_id: u64, response: NostrRelayMessage) {
    let text = response.as_json();
    send_to_client(state, client_id, Message::Text(text)).await;
}

fn parse_msgpack_message(data: &[u8]) -> Option<DataMessage> {
    let msg = parse_message(data).ok()?;
    match msg {
        DataMessage::Request(req) => {
            if req.h.len() == 32 {
                Some(DataMessage::Request(req))
            } else {
                None
            }
        }
        DataMessage::Response(res) => {
            if res.h.len() == 32 {
                Some(DataMessage::Response(res))
            } else {
                None
            }
        }
    }
}

async fn handle_msgpack_response(client_id: u64, res: DataResponse, state: &AppState) {
    let hash_hex = hex_encode(&res.h);
    let data = res.d.clone();
    let hash_bytes = res.h.clone();

    let mut responses: Vec<(u64, u32, WsProtocol)> = Vec::new();
    let mut seen = HashSet::new();
    {
        let pending = state.ws_relay.pending.lock().await;
        for ((peer_id, request_id), p) in pending.iter() {
            if *peer_id != client_id {
                continue;
            }
            if p.hash != hash_hex {
                continue;
            }
            if seen.insert((p.origin_id, *request_id)) {
                responses.push((p.origin_id, *request_id, p.origin_protocol));
            }
        }
    }

    if responses.is_empty() {
        return;
    }

    for (origin_id, request_id, protocol) in &responses {
        match protocol {
            WsProtocol::HashtreeJson => {
                send_json(
                    state,
                    *origin_id,
                    WsResponse { kind: "res", id: *request_id, hash: hash_hex.clone(), found: true },
                ).await;
                send_binary(state, *origin_id, *request_id, data.clone()).await;
            }
            WsProtocol::HashtreeMsgpack => {
                send_msgpack_response(state, *origin_id, &hash_bytes, &data).await;
            }
            WsProtocol::Unknown => {}
        }
    }

    let completed: HashSet<(u64, u32)> = responses
        .into_iter()
        .map(|(origin_id, request_id, _)| (origin_id, request_id))
        .collect();
    let mut pending = state.ws_relay.pending.lock().await;
    pending.retain(|(_, id), p| !completed.contains(&(p.origin_id, *id)));
}

async fn send_json(state: &AppState, client_id: u64, response: WsResponse) {
    if let Ok(text) = serde_json::to_string(&response) {
        send_to_client(state, client_id, Message::Text(text)).await;
    }
}

async fn send_msgpack_request(
    state: &AppState,
    client_id: u64,
    hash: &[u8],
) -> Result<(), rmp_serde::encode::Error> {
    let req = DataRequest { h: hash.to_vec(), htl: MAX_HTL };
    let wire = encode_request(&req)?;
    send_to_client(state, client_id, Message::Binary(wire)).await;
    Ok(())
}

async fn send_msgpack_response(state: &AppState, client_id: u64, hash: &[u8], data: &[u8]) {
    let res = DataResponse { h: hash.to_vec(), d: data.to_vec() };
    if let Ok(wire) = encode_response(&res) {
        send_to_client(state, client_id, Message::Binary(wire)).await;
    }
}

async fn send_binary(state: &AppState, client_id: u64, request_id: u32, payload: Vec<u8>) {
    let mut packet = Vec::with_capacity(4 + payload.len());
    packet.extend_from_slice(&request_id.to_le_bytes());
    packet.extend_from_slice(&payload);
    send_to_client(state, client_id, Message::Binary(packet)).await;
}

async fn send_to_client(state: &AppState, client_id: u64, msg: Message) {
    let sender = {
        let clients = state.ws_relay.clients.lock().await;
        clients.get(&client_id).cloned()
    };
    if let Some(tx) = sender {
        let _ = tx.send(msg);
    }
}

async fn set_client_protocol(state: &AppState, client_id: u64, protocol: WsProtocol) {
    let mut protocols = state.ws_relay.client_protocols.lock().await;
    protocols.insert(client_id, protocol);
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, SubscriptionId};
    use nostr::secp256k1::schnorr::Signature;

    #[test]
    fn parse_ws_text_message_detects_nostr_req() {
        let msg = r#"["REQ","sub-1",{"kinds":[1]}]"#;
        match parse_ws_text_message(msg) {
            Some(WsTextMessage::Nostr(_)) => {}
            other => panic!("expected Nostr message, got {:?}", other),
        }
    }

    #[test]
    fn parse_ws_text_message_detects_hashtree_request() {
        let msg = r#"{"type":"req","id":1,"hash":"abcd"}"#;
        match parse_ws_text_message(msg) {
            Some(WsTextMessage::Hashtree(_)) => {}
            other => panic!("expected Hashtree message, got {:?}", other),
        }
    }

    #[test]
    fn nostr_replies_for_req_is_eose() {
        let sub = SubscriptionId::new("sub-1");
        let msg = NostrClientMessage::req(sub.clone(), vec![]);
        let replies = nostr_responses_for(&msg);
        assert_eq!(replies.len(), 1);
        match &replies[0] {
            NostrRelayMessage::EndOfStoredEvents(id) => assert_eq!(id, &sub),
            other => panic!("expected EOSE, got {:?}", other),
        }
    }

    #[test]
    fn nostr_replies_for_event_ok() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, "hello", []).to_event(&keys).unwrap();
        let msg = NostrClientMessage::event(event.clone());
        let replies = nostr_responses_for(&msg);
        assert_eq!(replies.len(), 1);
        match &replies[0] {
            NostrRelayMessage::Ok { event_id, status, .. } => {
                assert_eq!(event_id, &event.id);
                assert!(*status);
            }
            other => panic!("expected OK, got {:?}", other),
        }
    }

    #[test]
    fn nostr_replies_for_invalid_event_is_not_ok() {
        let keys = Keys::generate();
        let mut event = EventBuilder::new(Kind::TextNote, "hello", []).to_event(&keys).unwrap();
        event.sig = Signature::from_slice(&[0u8; 64]).unwrap();
        let msg = NostrClientMessage::event(event);
        let replies = nostr_responses_for(&msg);
        assert_eq!(replies.len(), 1);
        match &replies[0] {
            NostrRelayMessage::Ok { status, .. } => assert!(!*status),
            other => panic!("expected OK=false, got {:?}", other),
        }
    }
}
