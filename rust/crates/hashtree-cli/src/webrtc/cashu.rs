use hashtree_webrtc::PeerSelector;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex, RwLock};

use super::types::{DataQuoteRequest, DataQuoteResponse};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CashuRoutingConfig {
    pub accepted_mints: Vec<String>,
    pub default_mint: Option<String>,
    pub quote_payment_offer_sat: u64,
    pub quote_ttl_ms: u32,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NegotiatedQuote {
    pub peer_id: String,
    pub quote_id: u64,
    pub mint_url: Option<String>,
}

pub(crate) struct CashuQuoteState {
    routing: CashuRoutingConfig,
    peer_selector: Arc<RwLock<PeerSelector>>,
    pending_quotes: Mutex<HashMap<String, PendingQuoteRequest>>,
    next_quote_id: AtomicU64,
}

impl CashuQuoteState {
    pub fn new(routing: CashuRoutingConfig, peer_selector: Arc<RwLock<PeerSelector>>) -> Self {
        Self {
            routing,
            peer_selector,
            pending_quotes: Mutex::new(HashMap::new()),
            next_quote_id: AtomicU64::new(1),
        }
    }

    pub fn requester_quote_terms(&self) -> Option<(u64, u32)> {
        if self.routing.quote_payment_offer_sat == 0 || self.routing.quote_ttl_ms == 0 {
            return None;
        }
        let has_trusted_mint =
            self.routing.default_mint.is_some() || !self.routing.accepted_mints.is_empty();
        has_trusted_mint.then_some((
            self.routing.quote_payment_offer_sat,
            self.routing.quote_ttl_ms,
        ))
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
        if !res.a {
            return false;
        }

        let Some(quote_id) = res.q else {
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
            mint_url: res.m,
        }));
        true
    }

    pub async fn build_quote_response(
        &self,
        _from_peer: &str,
        req: &DataQuoteRequest,
        can_serve: bool,
    ) -> DataQuoteResponse {
        DataQuoteResponse {
            h: req.h.clone(),
            a: can_serve,
            q: can_serve.then(|| self.next_quote_id.fetch_add(1, Ordering::Relaxed)),
            p: can_serve.then_some(req.p),
            t: can_serve.then_some(req.t),
            m: can_serve
                .then(|| self.choose_quote_mint(req.m.as_deref()))
                .flatten(),
        }
    }

    pub async fn should_refuse_requests_from_peer(&self, _peer_id: &str) -> bool {
        let threshold = self.routing.payment_default_block_threshold;
        if threshold == 0 {
            return false;
        }
        self.peer_selector
            .read()
            .await
            .is_peer_blocked_for_payment_defaults(_peer_id, threshold)
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
    use hashtree_webrtc::SelectionStrategy;

    fn make_state(routing: CashuRoutingConfig) -> CashuQuoteState {
        CashuQuoteState::new(
            routing,
            Arc::new(RwLock::new(PeerSelector::with_strategy(
                SelectionStrategy::TitForTat,
            ))),
        )
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
    fn test_requester_quote_terms_require_explicit_mint_policy() {
        let disabled = make_state(CashuRoutingConfig::default());
        assert_eq!(disabled.requester_quote_terms(), None);

        let enabled = make_state(CashuRoutingConfig {
            default_mint: Some("https://mint-a.example".to_string()),
            ..Default::default()
        });
        assert_eq!(enabled.requester_quote_terms(), Some((3, 1_500)));
    }

    #[tokio::test]
    async fn test_should_accept_quote_response_allows_bounded_peer_suggested_mint() {
        let state = make_state(CashuRoutingConfig {
            accepted_mints: vec!["https://mint-a.example".to_string()],
            default_mint: Some("https://mint-a.example".to_string()),
            peer_suggested_mint_base_cap_sat: 3,
            peer_suggested_mint_max_cap_sat: 3,
            ..Default::default()
        });

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
        let state = make_state(CashuRoutingConfig {
            accepted_mints: vec!["https://mint-a.example".to_string()],
            default_mint: Some("https://mint-a.example".to_string()),
            peer_suggested_mint_base_cap_sat: 3,
            peer_suggested_mint_max_cap_sat: 3,
            ..Default::default()
        });
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
        let state = make_state(CashuRoutingConfig {
            accepted_mints: vec!["https://mint-a.example".to_string()],
            default_mint: Some("https://mint-a.example".to_string()),
            peer_suggested_mint_base_cap_sat: 3,
            peer_suggested_mint_max_cap_sat: 3,
            ..Default::default()
        });

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
        assert_eq!(quote.mint_url.as_deref(), Some("https://mint-b.example"));
    }
}
