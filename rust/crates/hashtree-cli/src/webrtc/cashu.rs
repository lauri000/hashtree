use anyhow::{anyhow, Result};
use hashtree_webrtc::PeerSelector;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Mutex, RwLock};

use crate::cashu_helper::{CashuPaymentClient, CashuReceivedPayment, CashuSentPayment};

use super::types::{DataPaymentAck, DataQuoteRequest, DataQuoteResponse};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CashuRoutingConfig {
    pub accepted_mints: Vec<String>,
    pub default_mint: Option<String>,
    pub quote_payment_offer_sat: u64,
    pub quote_ttl_ms: u32,
    pub settlement_timeout_ms: u64,
    pub peer_suggested_mint_base_cap_sat: u64,
    pub peer_suggested_mint_success_step_sat: u64,
    pub peer_suggested_mint_receipt_step_sat: u64,
    pub peer_suggested_mint_max_cap_sat: u64,
    pub payment_default_block_threshold: u64,
}

impl Default for CashuRoutingConfig {
    fn default() -> Self {
        Self {
            accepted_mints: Vec::new(),
            default_mint: None,
            quote_payment_offer_sat: 3,
            quote_ttl_ms: 1_500,
            settlement_timeout_ms: 5_000,
            peer_suggested_mint_base_cap_sat: 3,
            peer_suggested_mint_success_step_sat: 1,
            peer_suggested_mint_receipt_step_sat: 2,
            peer_suggested_mint_max_cap_sat: 21,
            payment_default_block_threshold: 0,
        }
    }
}

impl From<&crate::config::CashuConfig> for CashuRoutingConfig {
    fn from(config: &crate::config::CashuConfig) -> Self {
        Self {
            accepted_mints: config.accepted_mints.clone(),
            default_mint: config.default_mint.clone(),
            quote_payment_offer_sat: config.quote_payment_offer_sat,
            quote_ttl_ms: config.quote_ttl_ms,
            settlement_timeout_ms: config.settlement_timeout_ms,
            peer_suggested_mint_base_cap_sat: config.peer_suggested_mint_base_cap_sat,
            peer_suggested_mint_success_step_sat: config.peer_suggested_mint_success_step_sat,
            peer_suggested_mint_receipt_step_sat: config.peer_suggested_mint_receipt_step_sat,
            peer_suggested_mint_max_cap_sat: config.peer_suggested_mint_max_cap_sat,
            payment_default_block_threshold: config.payment_default_block_threshold,
        }
    }
}

struct PendingQuoteRequest {
    response_tx: oneshot::Sender<Option<NegotiatedQuote>>,
    preferred_mint_url: Option<String>,
    offered_payment_sat: u64,
}

struct IssuedQuote {
    payment_sat: u64,
    mint_url: Option<String>,
    expires_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExpectedSettlement {
    pub payment_sat: u64,
    pub mint_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NegotiatedQuote {
    pub peer_id: String,
    pub quote_id: u64,
    pub payment_sat: u64,
    pub mint_url: Option<String>,
}

pub(crate) struct CashuQuoteState {
    routing: CashuRoutingConfig,
    peer_selector: Arc<RwLock<PeerSelector>>,
    payment_client: Option<Arc<dyn CashuPaymentClient>>,
    pending_quotes: Mutex<HashMap<String, PendingQuoteRequest>>,
    issued_quotes: Mutex<HashMap<(String, String, u64), IssuedQuote>>,
    pending_settlements: Mutex<HashMap<(String, String, u64), ExpectedSettlement>>,
    pending_payment_acks: Mutex<HashMap<(String, String, u64), oneshot::Sender<bool>>>,
    next_quote_id: AtomicU64,
}

impl CashuQuoteState {
    pub fn new(
        routing: CashuRoutingConfig,
        peer_selector: Arc<RwLock<PeerSelector>>,
        payment_client: Option<Arc<dyn CashuPaymentClient>>,
    ) -> Self {
        Self {
            routing,
            peer_selector,
            payment_client,
            pending_quotes: Mutex::new(HashMap::new()),
            issued_quotes: Mutex::new(HashMap::new()),
            pending_settlements: Mutex::new(HashMap::new()),
            pending_payment_acks: Mutex::new(HashMap::new()),
            next_quote_id: AtomicU64::new(1),
        }
    }

    pub fn payment_client_available(&self) -> bool {
        self.payment_client.is_some()
    }

    pub fn requester_quote_terms(&self) -> Option<(u64, u32)> {
        if !self.payment_client_available()
            || self.routing.quote_payment_offer_sat == 0
            || self.routing.quote_ttl_ms == 0
        {
            return None;
        }
        let has_trusted_mint =
            self.routing.default_mint.is_some() || !self.routing.accepted_mints.is_empty();
        has_trusted_mint.then_some((
            self.routing.quote_payment_offer_sat,
            self.routing.quote_ttl_ms,
        ))
    }

    pub fn settlement_timeout(&self) -> Duration {
        Duration::from_millis(self.routing.settlement_timeout_ms.max(1))
    }

    pub fn requested_quote_mint(&self) -> Option<&str> {
        if let Some(default_mint) = self.routing.default_mint.as_deref() {
            if self.routing.accepted_mints.is_empty()
                || self
                    .routing
                    .accepted_mints
                    .iter()
                    .any(|mint| mint == default_mint)
            {
                return Some(default_mint);
            }
        }

        self.routing.accepted_mints.first().map(String::as_str)
    }

    pub fn choose_quote_mint(&self, requested_mint: Option<&str>) -> Option<String> {
        if let Some(requested_mint) = requested_mint {
            if self.accepts_quote_mint(Some(requested_mint)) {
                return Some(requested_mint.to_string());
            }
        }
        if let Some(default_mint) = self.routing.default_mint.as_ref() {
            return Some(default_mint.clone());
        }
        if let Some(first_mint) = self.routing.accepted_mints.first() {
            return Some(first_mint.clone());
        }
        requested_mint.map(str::to_string)
    }

    pub async fn register_pending_quote(
        &self,
        hash_hex: String,
        preferred_mint_url: Option<String>,
        offered_payment_sat: u64,
    ) -> oneshot::Receiver<Option<NegotiatedQuote>> {
        let (tx, rx) = oneshot::channel();
        self.pending_quotes.lock().await.insert(
            hash_hex,
            PendingQuoteRequest {
                response_tx: tx,
                preferred_mint_url,
                offered_payment_sat,
            },
        );
        rx
    }

    pub async fn clear_pending_quote(&self, hash_hex: &str) {
        let _ = self.pending_quotes.lock().await.remove(hash_hex);
    }

    pub async fn register_pending_payment_ack(
        &self,
        peer_id: &str,
        hash_hex: &str,
        quote_id: u64,
    ) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        self.pending_payment_acks
            .lock()
            .await
            .insert((peer_id.to_string(), hash_hex.to_string(), quote_id), tx);
        rx
    }

    pub async fn clear_pending_payment_ack(&self, peer_id: &str, hash_hex: &str, quote_id: u64) {
        let _ = self.pending_payment_acks.lock().await.remove(&(
            peer_id.to_string(),
            hash_hex.to_string(),
            quote_id,
        ));
    }

    pub async fn handle_payment_ack(&self, from_peer: &str, ack: DataPaymentAck) -> bool {
        let hash_hex = hex::encode(&ack.h);
        let key = (from_peer.to_string(), hash_hex, ack.q);
        let Some(tx) = self.pending_payment_acks.lock().await.remove(&key) else {
            return false;
        };
        let _ = tx.send(ack.a);
        true
    }

    pub async fn should_accept_quote_response(
        &self,
        from_peer: &str,
        preferred_mint_url: Option<&str>,
        offered_payment_sat: u64,
        res: &DataQuoteResponse,
    ) -> bool {
        let Some(payment_sat) = res.p else {
            return false;
        };
        if payment_sat > offered_payment_sat {
            return false;
        }

        let response_mint = res.m.as_deref();
        if response_mint == preferred_mint_url {
            return true;
        }
        if self.trusts_quote_mint(response_mint) {
            return true;
        }
        if response_mint.is_none() {
            return false;
        }

        payment_sat <= self.peer_suggested_mint_cap_sat(from_peer).await
    }

    pub async fn handle_quote_response(&self, from_peer: &str, res: DataQuoteResponse) -> bool {
        if !res.a || !self.payment_client_available() {
            return false;
        }

        let (Some(quote_id), Some(payment_sat)) = (res.q, res.p) else {
            return false;
        };
        let hash_hex = hex::encode(&res.h);
        let (preferred_mint_url, offered_payment_sat) = {
            let pending_quotes = self.pending_quotes.lock().await;
            let Some(pending) = pending_quotes.get(&hash_hex) else {
                return false;
            };
            (
                pending.preferred_mint_url.clone(),
                pending.offered_payment_sat,
            )
        };

        if !self
            .should_accept_quote_response(
                from_peer,
                preferred_mint_url.as_deref(),
                offered_payment_sat,
                &res,
            )
            .await
        {
            return false;
        }

        let Some(pending) = self.pending_quotes.lock().await.remove(&hash_hex) else {
            return false;
        };
        let _ = pending.response_tx.send(Some(NegotiatedQuote {
            peer_id: from_peer.to_string(),
            quote_id,
            payment_sat,
            mint_url: res.m,
        }));
        true
    }

    pub async fn build_quote_response(
        &self,
        from_peer: &str,
        req: &DataQuoteRequest,
        can_serve: bool,
    ) -> DataQuoteResponse {
        if !can_serve || !self.payment_client_available() {
            return DataQuoteResponse {
                h: req.h.clone(),
                a: false,
                q: None,
                p: None,
                t: None,
                m: None,
            };
        }

        let Some(chosen_mint) = self.choose_quote_mint(req.m.as_deref()) else {
            return DataQuoteResponse {
                h: req.h.clone(),
                a: false,
                q: None,
                p: None,
                t: None,
                m: None,
            };
        };
        let quote_id = self.next_quote_id.fetch_add(1, Ordering::Relaxed);
        let hash_hex = hex::encode(&req.h);
        self.issued_quotes.lock().await.insert(
            (from_peer.to_string(), hash_hex, quote_id),
            IssuedQuote {
                payment_sat: req.p,
                mint_url: Some(chosen_mint.clone()),
                expires_at: Instant::now() + Duration::from_millis(req.t as u64),
            },
        );

        DataQuoteResponse {
            h: req.h.clone(),
            a: true,
            q: Some(quote_id),
            p: Some(req.p),
            t: Some(req.t),
            m: Some(chosen_mint),
        }
    }

    pub async fn take_valid_quote(
        &self,
        from_peer: &str,
        hash: &[u8],
        quote_id: u64,
    ) -> Option<ExpectedSettlement> {
        let hash_hex = hex::encode(hash);
        let key = (from_peer.to_string(), hash_hex, quote_id);
        let issued = self.issued_quotes.lock().await.remove(&key)?;
        (issued.expires_at >= Instant::now()).then_some(ExpectedSettlement {
            payment_sat: issued.payment_sat,
            mint_url: issued.mint_url,
        })
    }

    pub async fn register_expected_payment(
        self: &Arc<Self>,
        from_peer: String,
        hash_hex: String,
        quote_id: u64,
        settlement: ExpectedSettlement,
    ) {
        let key = (from_peer.clone(), hash_hex.clone(), quote_id);
        self.pending_settlements
            .lock()
            .await
            .insert(key.clone(), settlement);

        let state = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(state.settlement_timeout()).await;
            let expired = state
                .pending_settlements
                .lock()
                .await
                .remove(&key)
                .is_some();
            if expired {
                state
                    .peer_selector
                    .write()
                    .await
                    .record_cashu_payment_default(&from_peer);
            }
        });
    }

    pub async fn claim_expected_payment(
        &self,
        from_peer: &str,
        hash: &[u8],
        quote_id: u64,
        announced_payment_sat: u64,
        announced_mint: Option<&str>,
    ) -> Result<ExpectedSettlement> {
        let hash_hex = hex::encode(hash);
        let key = (from_peer.to_string(), hash_hex, quote_id);
        let settlement = self
            .pending_settlements
            .lock()
            .await
            .remove(&key)
            .ok_or_else(|| anyhow!("No pending settlement"))?;

        if announced_payment_sat < settlement.payment_sat {
            return Err(anyhow!("Quoted payment amount was not met"));
        }
        if settlement.mint_url.as_deref() != announced_mint {
            return Err(anyhow!("Payment mint does not match quoted mint"));
        }

        Ok(settlement)
    }

    pub async fn create_payment_token(
        &self,
        mint_url: &str,
        amount_sat: u64,
    ) -> Result<CashuSentPayment> {
        let client = self
            .payment_client
            .as_ref()
            .ok_or_else(|| anyhow!("Cashu settlement helper unavailable"))?;
        client.send_payment(mint_url, amount_sat).await
    }

    pub async fn receive_payment_token(&self, encoded_token: &str) -> Result<CashuReceivedPayment> {
        let client = self
            .payment_client
            .as_ref()
            .ok_or_else(|| anyhow!("Cashu settlement helper unavailable"))?;
        client.receive_payment(encoded_token).await
    }

    pub async fn revoke_payment_token(&self, mint_url: &str, operation_id: &str) -> Result<()> {
        let client = self
            .payment_client
            .as_ref()
            .ok_or_else(|| anyhow!("Cashu settlement helper unavailable"))?;
        client.revoke_payment(mint_url, operation_id).await
    }

    pub async fn record_paid_peer(&self, peer_id: &str, amount_sat: u64) {
        self.peer_selector
            .write()
            .await
            .record_cashu_payment(peer_id, amount_sat);
    }

    pub async fn record_receipt_from_peer(&self, peer_id: &str, amount_sat: u64) {
        self.peer_selector
            .write()
            .await
            .record_cashu_receipt(peer_id, amount_sat);
    }

    pub async fn record_payment_default_from_peer(&self, peer_id: &str) {
        self.peer_selector
            .write()
            .await
            .record_cashu_payment_default(peer_id);
    }

    pub async fn should_refuse_requests_from_peer(&self, peer_id: &str) -> bool {
        let threshold = self.routing.payment_default_block_threshold;
        if threshold == 0 {
            return false;
        }
        self.peer_selector
            .read()
            .await
            .is_peer_blocked_for_payment_defaults(peer_id, threshold)
    }

    fn accepts_quote_mint(&self, mint_url: Option<&str>) -> bool {
        if self.routing.accepted_mints.is_empty() {
            return true;
        }

        let Some(mint_url) = mint_url else {
            return false;
        };
        self.routing
            .accepted_mints
            .iter()
            .any(|mint| mint == mint_url)
    }

    fn trusts_quote_mint(&self, mint_url: Option<&str>) -> bool {
        let Some(mint_url) = mint_url else {
            return self.routing.default_mint.is_none() && self.routing.accepted_mints.is_empty();
        };
        self.routing.default_mint.as_deref() == Some(mint_url)
            || self
                .routing
                .accepted_mints
                .iter()
                .any(|mint| mint == mint_url)
    }

    async fn peer_suggested_mint_cap_sat(&self, peer_id: &str) -> u64 {
        let base = self.routing.peer_suggested_mint_base_cap_sat;
        if base == 0 {
            return 0;
        }

        let selector = self.peer_selector.read().await;
        let Some(stats) = selector.get_stats(peer_id) else {
            let max_cap = self.routing.peer_suggested_mint_max_cap_sat;
            return if max_cap > 0 { base.min(max_cap) } else { base };
        };

        if stats.cashu_payment_defaults > 0
            && stats.cashu_payment_defaults >= stats.cashu_payment_receipts
        {
            return 0;
        }

        let success_bonus = stats
            .successes
            .saturating_mul(self.routing.peer_suggested_mint_success_step_sat);
        let receipt_bonus = stats
            .cashu_payment_receipts
            .saturating_mul(self.routing.peer_suggested_mint_receipt_step_sat);
        let mut cap = base
            .saturating_add(success_bonus)
            .saturating_add(receipt_bonus);
        let max_cap = self.routing.peer_suggested_mint_max_cap_sat;
        if max_cap > 0 {
            cap = cap.min(max_cap);
        }
        cap
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cashu_helper::{CashuPaymentClient, CashuReceivedPayment, CashuSentPayment};
    use async_trait::async_trait;
    use hashtree_webrtc::SelectionStrategy;

    #[derive(Debug)]
    struct NoopPaymentClient;

    #[async_trait]
    impl CashuPaymentClient for NoopPaymentClient {
        async fn send_payment(&self, mint_url: &str, amount_sat: u64) -> Result<CashuSentPayment> {
            Ok(CashuSentPayment {
                mint_url: mint_url.to_string(),
                unit: "sat".to_string(),
                amount_sat,
                send_fee_sat: 0,
                operation_id: "op-1".to_string(),
                token: "cashuBtoken".to_string(),
            })
        }

        async fn receive_payment(&self, _encoded_token: &str) -> Result<CashuReceivedPayment> {
            Ok(CashuReceivedPayment {
                mint_url: "https://mint.example".to_string(),
                unit: "sat".to_string(),
                amount_sat: 3,
            })
        }

        async fn revoke_payment(&self, _mint_url: &str, _operation_id: &str) -> Result<()> {
            Ok(())
        }
    }

    fn make_state(routing: CashuRoutingConfig, with_client: bool) -> Arc<CashuQuoteState> {
        Arc::new(CashuQuoteState::new(
            routing,
            Arc::new(RwLock::new(PeerSelector::with_strategy(
                SelectionStrategy::TitForTat,
            ))),
            with_client.then_some(Arc::new(NoopPaymentClient) as Arc<dyn CashuPaymentClient>),
        ))
    }

    fn quote_response(mint_url: Option<&str>, payment_sat: u64) -> DataQuoteResponse {
        DataQuoteResponse {
            h: vec![0x11; 32],
            a: true,
            q: Some(7),
            p: Some(payment_sat),
            t: Some(500),
            m: mint_url.map(str::to_string),
        }
    }

    #[test]
    fn test_requester_quote_terms_require_payment_client_and_mint_policy() {
        let disabled = make_state(CashuRoutingConfig::default(), false);
        assert_eq!(disabled.requester_quote_terms(), None);

        let no_client = make_state(
            CashuRoutingConfig {
                default_mint: Some("https://mint-a.example".to_string()),
                ..Default::default()
            },
            false,
        );
        assert_eq!(no_client.requester_quote_terms(), None);

        let enabled = make_state(
            CashuRoutingConfig {
                default_mint: Some("https://mint-a.example".to_string()),
                ..Default::default()
            },
            true,
        );
        assert_eq!(enabled.requester_quote_terms(), Some((3, 1_500)));
    }

    #[tokio::test]
    async fn test_should_accept_quote_response_allows_bounded_peer_suggested_mint() {
        let state = make_state(
            CashuRoutingConfig {
                accepted_mints: vec!["https://mint-a.example".to_string()],
                default_mint: Some("https://mint-a.example".to_string()),
                peer_suggested_mint_base_cap_sat: 3,
                peer_suggested_mint_max_cap_sat: 3,
                ..Default::default()
            },
            true,
        );

        let accepted = state
            .should_accept_quote_response(
                "peer-a:session-1",
                Some("https://mint-a.example"),
                3,
                &quote_response(Some("https://mint-b.example"), 3),
            )
            .await;
        assert!(accepted);
    }

    #[tokio::test]
    async fn test_should_accept_quote_response_rejects_peer_suggested_mint_after_defaults() {
        let state = make_state(
            CashuRoutingConfig {
                accepted_mints: vec!["https://mint-a.example".to_string()],
                default_mint: Some("https://mint-a.example".to_string()),
                peer_suggested_mint_base_cap_sat: 3,
                peer_suggested_mint_max_cap_sat: 3,
                ..Default::default()
            },
            true,
        );
        state
            .peer_selector
            .write()
            .await
            .record_cashu_payment_default("peer-a:session-1");

        let accepted = state
            .should_accept_quote_response(
                "peer-a:session-1",
                Some("https://mint-a.example"),
                3,
                &quote_response(Some("https://mint-b.example"), 3),
            )
            .await;
        assert!(!accepted);
    }

    #[tokio::test]
    async fn test_handle_quote_response_resolves_pending_quote() {
        let state = make_state(
            CashuRoutingConfig {
                accepted_mints: vec!["https://mint-a.example".to_string()],
                default_mint: Some("https://mint-a.example".to_string()),
                peer_suggested_mint_base_cap_sat: 3,
                peer_suggested_mint_max_cap_sat: 3,
                ..Default::default()
            },
            true,
        );

        let hash_hex = hex::encode([0x11; 32]);
        let mut rx = state
            .register_pending_quote(hash_hex, Some("https://mint-a.example".to_string()), 3)
            .await;

        let handled = state
            .handle_quote_response(
                "peer-a:session-1",
                quote_response(Some("https://mint-b.example"), 3),
            )
            .await;
        assert!(handled);

        let quote = rx
            .try_recv()
            .expect("expected negotiated quote")
            .expect("expected quote payload");
        assert_eq!(quote.peer_id, "peer-a:session-1");
        assert_eq!(quote.quote_id, 7);
        assert_eq!(quote.payment_sat, 3);
        assert_eq!(quote.mint_url.as_deref(), Some("https://mint-b.example"));
    }

    #[tokio::test]
    async fn test_build_quote_response_registers_quote_for_validation() {
        let state = make_state(
            CashuRoutingConfig {
                accepted_mints: vec!["https://mint-a.example".to_string()],
                default_mint: Some("https://mint-a.example".to_string()),
                ..Default::default()
            },
            true,
        );

        let res = state
            .build_quote_response(
                "peer-a:session-1",
                &DataQuoteRequest {
                    h: vec![0x22; 32],
                    p: 3,
                    t: 500,
                    m: Some("https://mint-a.example".to_string()),
                },
                true,
            )
            .await;
        assert!(res.a);

        let expected = state
            .take_valid_quote("peer-a:session-1", &[0x22; 32], res.q.unwrap())
            .await
            .expect("quote should validate");
        assert_eq!(expected.payment_sat, 3);
        assert_eq!(expected.mint_url.as_deref(), Some("https://mint-a.example"));
    }

    #[tokio::test]
    async fn test_payment_timeout_records_default() {
        let state = make_state(
            CashuRoutingConfig {
                default_mint: Some("https://mint-a.example".to_string()),
                settlement_timeout_ms: 10,
                ..Default::default()
            },
            true,
        );
        state
            .register_expected_payment(
                "peer-a:session-1".to_string(),
                hex::encode([0x33; 32]),
                7,
                ExpectedSettlement {
                    payment_sat: 3,
                    mint_url: Some("https://mint-a.example".to_string()),
                },
            )
            .await;

        tokio::time::sleep(Duration::from_millis(25)).await;
        let selector = state.peer_selector.read().await;
        let stats = selector.get_stats("peer-a:session-1").expect("peer stats");
        assert_eq!(stats.cashu_payment_defaults, 1);
    }

    #[tokio::test]
    async fn test_payment_ack_resolves_pending_waiter() {
        let state = make_state(CashuRoutingConfig::default(), true);
        let mut rx = state
            .register_pending_payment_ack("peer-a:session-1", &hex::encode([0x44; 32]), 9)
            .await;

        let handled = state
            .handle_payment_ack(
                "peer-a:session-1",
                DataPaymentAck {
                    h: vec![0x44; 32],
                    q: 9,
                    a: true,
                    e: None,
                },
            )
            .await;
        assert!(handled);
        assert_eq!(rx.try_recv().unwrap(), true);
    }
}
