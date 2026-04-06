use super::{ContentStore, PendingChunkPayment, PendingRequest};
use crate::cashu::{CashuQuoteState, ExpectedSettlement};
use crate::{
    encode_chunk, encode_payment, hash_to_key, DataChunk, DataPayment, DataPaymentAck,
    DataQuoteRequest, DataQuoteResponse, PeerId,
};
use bytes::Bytes;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, warn};
use webrtc::data_channel::RTCDataChannel;

pub(super) async fn handle_quote_request_message(
    peer_short: &str,
    peer_id: &PeerId,
    store: &Option<Arc<dyn ContentStore>>,
    cashu_quotes: Option<&Arc<CashuQuoteState>>,
    req: &DataQuoteRequest,
) -> Option<DataQuoteResponse> {
    let Some(cashu_quotes) = cashu_quotes else {
        debug!(
            "[Peer {}] Ignoring quote request without Cashu policy",
            peer_short
        );
        return None;
    };

    if cashu_quotes
        .should_refuse_requests_from_peer(&peer_id.to_string())
        .await
    {
        return Some(
            cashu_quotes
                .build_quote_response(&peer_id.to_string(), req, false)
                .await,
        );
    }

    let hash_hex = hash_to_key(&req.h);
    let can_serve = if let Some(store) = store {
        match store.get(&hash_hex) {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(e) => {
                warn!("[Peer {}] Store error during quote: {}", peer_short, e);
                false
            }
        }
    } else {
        false
    };

    Some(
        cashu_quotes
            .build_quote_response(&peer_id.to_string(), req, can_serve)
            .await,
    )
}

#[derive(Debug)]
pub(super) struct PaymentHandlingOutcome {
    pub ack: DataPaymentAck,
    pub next_chunk: Option<(DataChunk, ExpectedSettlement)>,
}

pub(super) async fn send_quoted_chunk(
    dc: &Arc<RTCDataChannel>,
    peer_id: &PeerId,
    peer_short: &str,
    cashu_quotes: &Arc<CashuQuoteState>,
    chunk: DataChunk,
    expected: ExpectedSettlement,
) -> bool {
    let hash_hex = hash_to_key(&chunk.h);
    let wire = encode_chunk(&chunk);

    if let Err(err) = dc.send(&Bytes::from(wire)).await {
        warn!(
            "[Peer {}] Failed to send quoted chunk {} for quote {}: {}",
            peer_short, chunk.c, chunk.q, err
        );
        return false;
    }

    cashu_quotes
        .register_expected_payment(peer_id.to_string(), hash_hex, chunk.q, expected)
        .await;
    true
}

pub(super) async fn fail_pending_request(
    pending_requests: &Arc<Mutex<HashMap<String, PendingRequest>>>,
    cashu_quotes: Option<&Arc<CashuQuoteState>>,
    hash_hex: &str,
) {
    let pending = pending_requests.lock().await.remove(hash_hex);
    let Some(pending) = pending else {
        return;
    };

    if let (Some(cashu_quotes), Some(quoted)) = (cashu_quotes, pending.quoted) {
        if let Some(in_flight) = quoted.in_flight_payment {
            let _ = cashu_quotes
                .revoke_payment_token(&in_flight.mint_url, &in_flight.operation_id)
                .await;
        }
    }
    let _ = pending.response_tx.send(None);
}

pub(super) async fn process_chunk_message(
    peer_short: &str,
    _peer_id: &PeerId,
    dc: &Arc<RTCDataChannel>,
    pending_requests: &Arc<Mutex<HashMap<String, PendingRequest>>>,
    cashu_quotes: Option<&Arc<CashuQuoteState>>,
    chunk: DataChunk,
) {
    let hash_hex = hash_to_key(&chunk.h);
    let Some(cashu_quotes) = cashu_quotes else {
        fail_pending_request(pending_requests, None, &hash_hex).await;
        return;
    };

    enum ChunkAction {
        BufferOnly,
        Fail,
        Pay {
            mint_url: String,
            amount_sat: u64,
            final_chunk: bool,
        },
    }

    let action = {
        let mut pending = pending_requests.lock().await;
        let Some(request) = pending.get_mut(&hash_hex) else {
            return;
        };
        match request.quoted.as_mut() {
            None => ChunkAction::Fail,
            Some(quoted) if quoted.quote_id != chunk.q || chunk.n == 0 => ChunkAction::Fail,
            Some(quoted) => {
                if let Some(in_flight) = quoted.in_flight_payment.as_ref() {
                    let expected_buffer_index = in_flight.chunk_index + 1;
                    if chunk.c == expected_buffer_index && quoted.buffered_chunk.is_none() {
                        quoted.buffered_chunk = Some(chunk.clone());
                        ChunkAction::BufferOnly
                    } else {
                        ChunkAction::Fail
                    }
                } else if chunk.c != quoted.next_chunk_index {
                    ChunkAction::Fail
                } else if let Some(total_chunks) = quoted.total_chunks {
                    if total_chunks != chunk.n {
                        ChunkAction::Fail
                    } else {
                        let next_total = quoted.confirmed_payment_sat.saturating_add(chunk.p);
                        if next_total > quoted.total_payment_sat
                            || (chunk.c + 1 == chunk.n && next_total != quoted.total_payment_sat)
                        {
                            ChunkAction::Fail
                        } else {
                            quoted.total_chunks = Some(chunk.n);
                            quoted.assembled_data.extend_from_slice(&chunk.d);
                            quoted.next_chunk_index += 1;
                            ChunkAction::Pay {
                                mint_url: quoted.mint_url.clone(),
                                amount_sat: chunk.p,
                                final_chunk: chunk.c + 1 == chunk.n,
                            }
                        }
                    }
                } else {
                    let next_total = quoted.confirmed_payment_sat.saturating_add(chunk.p);
                    if next_total > quoted.total_payment_sat
                        || (chunk.c + 1 == chunk.n && next_total != quoted.total_payment_sat)
                    {
                        ChunkAction::Fail
                    } else {
                        quoted.total_chunks = Some(chunk.n);
                        quoted.assembled_data.extend_from_slice(&chunk.d);
                        quoted.next_chunk_index += 1;
                        ChunkAction::Pay {
                            mint_url: quoted.mint_url.clone(),
                            amount_sat: chunk.p,
                            final_chunk: chunk.c + 1 == chunk.n,
                        }
                    }
                }
            }
        }
    };

    match action {
        ChunkAction::BufferOnly => (),
        ChunkAction::Fail => {
            warn!(
                "[Peer {}] Invalid quoted chunk {} for hash {}",
                peer_short, chunk.c, hash_hex
            );
            fail_pending_request(pending_requests, Some(cashu_quotes), &hash_hex).await;
        }
        ChunkAction::Pay {
            mint_url,
            amount_sat,
            final_chunk,
        } => {
            let payment = match cashu_quotes
                .create_payment_token(&mint_url, amount_sat)
                .await
            {
                Ok(payment) => payment,
                Err(err) => {
                    warn!(
                        "[Peer {}] Failed to create payment token for chunk {} of {}: {}",
                        peer_short, chunk.c, hash_hex, err
                    );
                    fail_pending_request(pending_requests, Some(cashu_quotes), &hash_hex).await;
                    return;
                }
            };

            {
                let mut pending = pending_requests.lock().await;
                let Some(request) = pending.get_mut(&hash_hex) else {
                    let _ = cashu_quotes
                        .revoke_payment_token(&payment.mint_url, &payment.operation_id)
                        .await;
                    return;
                };
                let Some(quoted) = request.quoted.as_mut() else {
                    let _ = cashu_quotes
                        .revoke_payment_token(&payment.mint_url, &payment.operation_id)
                        .await;
                    return;
                };
                quoted.in_flight_payment = Some(PendingChunkPayment {
                    chunk_index: chunk.c,
                    amount_sat,
                    mint_url: payment.mint_url.clone(),
                    operation_id: payment.operation_id.clone(),
                    final_chunk,
                });
            }

            let payment_msg = DataPayment {
                h: chunk.h,
                q: chunk.q,
                c: chunk.c,
                p: amount_sat,
                m: Some(payment.mint_url.clone()),
                tok: payment.token,
            };
            let wire = encode_payment(&payment_msg);
            if let Err(err) = dc.send(&Bytes::from(wire)).await {
                warn!(
                    "[Peer {}] Failed to send payment for chunk {} of {}: {}",
                    peer_short, chunk.c, hash_hex, err
                );
                fail_pending_request(pending_requests, Some(cashu_quotes), &hash_hex).await;
            }
        }
    }
}

pub(super) async fn handle_payment_ack_message(
    peer_short: &str,
    peer_id: &PeerId,
    dc: &Arc<RTCDataChannel>,
    pending_requests: &Arc<Mutex<HashMap<String, PendingRequest>>>,
    cashu_quotes: Option<&Arc<CashuQuoteState>>,
    ack: DataPaymentAck,
) {
    let Some(cashu_quotes) = cashu_quotes else {
        return;
    };
    let hash_hex = hash_to_key(&ack.h);
    let mut buffered_next = None;
    let mut completed = None;
    let mut failed = None;
    let mut confirmed_amount = None;
    let mut completed_data = None;

    {
        let mut pending = pending_requests.lock().await;
        let Some(request) = pending.get_mut(&hash_hex) else {
            return;
        };
        let Some(quoted) = request.quoted.as_mut() else {
            return;
        };
        let Some(in_flight) = quoted.in_flight_payment.take() else {
            return;
        };
        if ack.q != quoted.quote_id || ack.c != in_flight.chunk_index {
            quoted.in_flight_payment = Some(in_flight);
            return;
        }

        if !ack.a {
            failed = Some(in_flight);
        } else {
            quoted.confirmed_payment_sat = quoted
                .confirmed_payment_sat
                .saturating_add(in_flight.amount_sat);
            confirmed_amount = Some(in_flight.amount_sat);
            if in_flight.final_chunk {
                completed_data = Some(quoted.assembled_data.clone());
            } else if let Some(next_chunk) = quoted.buffered_chunk.take() {
                buffered_next = Some(next_chunk);
            }
        }

        if let Some(data) = completed_data.take() {
            let finished = pending
                .remove(&hash_hex)
                .expect("pending request must exist");
            completed = Some((finished.response_tx, data));
        }
    }

    if let Some(amount_sat) = confirmed_amount {
        cashu_quotes
            .record_paid_peer(&peer_id.to_string(), amount_sat)
            .await;
    }

    if let Some(in_flight) = failed {
        warn!(
            "[Peer {}] Payment ack rejected chunk {} for {}: {}",
            peer_short,
            ack.c,
            hash_hex,
            ack.e.as_deref().unwrap_or("payment rejected")
        );
        let _ = cashu_quotes
            .revoke_payment_token(&in_flight.mint_url, &in_flight.operation_id)
            .await;
        let removed = pending_requests.lock().await.remove(&hash_hex);
        if let Some(removed) = removed {
            let _ = removed.response_tx.send(None);
        }
        return;
    }

    if let Some((tx, data)) = completed {
        let _ = tx.send(Some(data));
        return;
    }

    if let Some(next_chunk) = buffered_next {
        process_chunk_message(
            peer_short,
            peer_id,
            dc,
            pending_requests,
            Some(cashu_quotes),
            next_chunk,
        )
        .await;
    }
}

pub(super) async fn handle_payment_message(
    peer_id: &PeerId,
    cashu_quotes: Option<&Arc<CashuQuoteState>>,
    req: &DataPayment,
) -> PaymentHandlingOutcome {
    let nack = |err: String| PaymentHandlingOutcome {
        ack: DataPaymentAck {
            h: req.h.clone(),
            q: req.q,
            c: req.c,
            a: false,
            e: Some(err),
        },
        next_chunk: None,
    };

    let Some(cashu_quotes) = cashu_quotes else {
        return nack("Cashu settlement unavailable".to_string());
    };

    let expected = match cashu_quotes
        .claim_expected_payment(
            &peer_id.to_string(),
            &req.h,
            req.q,
            req.c,
            req.p,
            req.m.as_deref(),
        )
        .await
    {
        Ok(expected) => expected,
        Err(err) => {
            cashu_quotes
                .record_payment_default_from_peer(&peer_id.to_string())
                .await;
            return nack(err.to_string());
        }
    };

    match cashu_quotes.receive_payment_token(&req.tok).await {
        Ok(received) if received.amount_sat >= expected.payment_sat => {
            if expected.mint_url.as_deref() != Some(received.mint_url.as_str()) {
                cashu_quotes
                    .record_payment_default_from_peer(&peer_id.to_string())
                    .await;
                return nack("Received payment mint did not match quoted mint".to_string());
            }
            if let Err(err) = cashu_quotes
                .record_receipt_from_peer(
                    &peer_id.to_string(),
                    &received.mint_url,
                    received.amount_sat,
                )
                .await
            {
                warn!(
                    "[Peer {}] Failed to persist Cashu mint success for {}: {}",
                    peer_id.short(),
                    received.mint_url,
                    err
                );
            }

            let next_chunk = if expected.final_chunk {
                None
            } else {
                cashu_quotes
                    .next_outgoing_chunk(&peer_id.to_string(), &req.h, req.q)
                    .await
            };

            PaymentHandlingOutcome {
                ack: DataPaymentAck {
                    h: req.h.clone(),
                    q: req.q,
                    c: req.c,
                    a: true,
                    e: None,
                },
                next_chunk,
            }
        }
        Ok(_) => {
            cashu_quotes
                .record_payment_default_from_peer(&peer_id.to_string())
                .await;
            nack("Received payment amount was below the quoted amount".to_string())
        }
        Err(err) => {
            if let Some(mint_url) = expected.mint_url.as_deref().or(req.m.as_deref()) {
                let _ = cashu_quotes.record_mint_receive_failure(mint_url).await;
            }
            nack(err.to_string())
        }
    }
}
