//! WebRTC module tests

use super::types::*;

#[test]
fn test_peer_id_display() {
    let peer_id = PeerId::new("abc123def456".to_string(), Some("uuid-12345".to_string()));
    assert_eq!(peer_id.to_string(), "abc123def456:uuid-12345");
}

#[test]
fn test_peer_id_short() {
    let peer_id = PeerId::new(
        "abc123def456ghijklmnop".to_string(),
        Some("uuid-12345678".to_string()),
    );
    assert_eq!(peer_id.short(), "abc123de:uuid-1");
}

#[test]
fn test_peer_id_from_string() {
    let peer_id = PeerId::from_string("abc123:uuid456").unwrap();
    assert_eq!(peer_id.pubkey, "abc123");
    assert_eq!(peer_id.uuid, "uuid456");
}

#[test]
fn test_peer_id_from_string_invalid() {
    assert!(PeerId::from_string("no-colon").is_none());
    assert!(PeerId::from_string("a:b:c").is_none());
}

#[test]
fn test_signaling_message_hello() {
    let msg = SignalingMessage::hello("my-uuid");
    assert_eq!(msg.msg_type(), "hello");
    assert_eq!(msg.peer_id(), "my-uuid");
    assert!(msg.recipient().is_none());
}

#[test]
fn test_signaling_message_offer() {
    let offer = serde_json::json!({"sdp": "test"});
    let msg = SignalingMessage::offer(offer.clone(), "recipient", "peer-id");
    assert_eq!(msg.msg_type(), "offer");
    assert_eq!(msg.recipient(), Some("recipient"));
    assert_eq!(msg.peer_id(), "peer-id");
}

#[test]
fn test_webrtc_config_default() {
    let config = WebRTCConfig::default();
    assert!(!config.relays.is_empty());
    assert!(config.max_outbound > 0);
    assert!(config.max_inbound > 0);
    assert!(!config.stun_servers.is_empty());
}

#[test]
fn test_generate_uuid() {
    let uuid1 = generate_uuid();
    let uuid2 = generate_uuid();

    // Should be 30 characters (15 + 15)
    assert_eq!(uuid1.len(), 30);
    assert_eq!(uuid2.len(), 30);

    // Should be different
    assert_ne!(uuid1, uuid2);
}

#[test]
fn test_peer_direction_display() {
    assert_eq!(PeerDirection::Inbound.to_string(), "inbound");
    assert_eq!(PeerDirection::Outbound.to_string(), "outbound");
}

// Wire format tests for hashtree-ts interop
#[test]
fn test_wire_format_request_encode_decode() {
    let req = DataRequest {
        h: vec![0xab; 32],
        htl: 10,
    };
    let encoded = encode_request(&req).unwrap();

    // First byte should be request type
    assert_eq!(encoded[0], MSG_TYPE_REQUEST);

    // Should round-trip
    let parsed = parse_message(&encoded).unwrap();
    match parsed {
        DataMessage::Request(r) => {
            assert_eq!(r.h, vec![0xab; 32]);
            assert_eq!(r.htl, 10);
        }
        _ => panic!("Expected request"),
    }
}

#[test]
fn test_wire_format_response_encode_decode() {
    let res = DataResponse {
        h: vec![0xcd; 32],
        d: vec![1, 2, 3, 4, 5],
    };
    let encoded = encode_response(&res).unwrap();

    // First byte should be response type
    assert_eq!(encoded[0], MSG_TYPE_RESPONSE);

    // Should round-trip
    let parsed = parse_message(&encoded).unwrap();
    match parsed {
        DataMessage::Response(r) => {
            assert_eq!(r.h, vec![0xcd; 32]);
            assert_eq!(r.d, vec![1, 2, 3, 4, 5]);
        }
        _ => panic!("Expected response"),
    }
}

#[test]
fn test_wire_format_constants() {
    // These must match hashtree-ts constants
    assert_eq!(MSG_TYPE_REQUEST, 0x00);
    assert_eq!(MSG_TYPE_RESPONSE, 0x01);
}

#[test]
fn test_blob_policy_matches_legacy_defaults() {
    assert_eq!(BLOB_REQUEST_POLICY.max_htl, MAX_HTL);
    assert!((BLOB_REQUEST_POLICY.p_at_max - 0.5).abs() < f64::EPSILON);
    assert!((BLOB_REQUEST_POLICY.p_at_min - 0.25).abs() < f64::EPSILON);
}

#[test]
fn test_mesh_policy_is_probabilistic_and_tighter() {
    assert_eq!(MESH_EVENT_POLICY.mode, HtlMode::Probabilistic);
    assert_eq!(MESH_EVENT_POLICY.max_htl, 4);
    assert!(MESH_EVENT_POLICY.max_htl < BLOB_REQUEST_POLICY.max_htl);
    assert!(MESH_EVENT_POLICY.p_at_max > BLOB_REQUEST_POLICY.p_at_max);
    assert!(MESH_EVENT_POLICY.p_at_min > BLOB_REQUEST_POLICY.p_at_min);
}

#[test]
fn test_mesh_frame_validation_accepts_kind_25050_event() {
    let keys = nostr::Keys::generate();
    let event = nostr::EventBuilder::new(
        nostr::Kind::Ephemeral(WEBRTC_KIND as u16),
        "",
        [nostr::Tag::parse(&["l", HELLO_TAG]).unwrap()],
    )
    .to_event(&keys)
    .unwrap();

    let frame = MeshNostrFrame::new_event(event, "peer-a:uuid-a", MESH_EVENT_POLICY.max_htl);
    assert!(validate_mesh_frame(&frame).is_ok());
}

#[test]
fn test_mesh_frame_validation_rejects_non_webrtc_kind() {
    let keys = nostr::Keys::generate();
    let event = nostr::EventBuilder::new(nostr::Kind::TextNote, "nope", [])
        .to_event(&keys)
        .unwrap();
    let frame = MeshNostrFrame::new_event(event, "peer-a:uuid-a", MESH_EVENT_POLICY.max_htl);
    assert!(validate_mesh_frame(&frame).is_err());
}
