pub use hashtree_network::{cashu_mint_metadata_path, CashuMintMetadataStore, CashuRoutingConfig};

impl From<&crate::config::CashuConfig> for CashuRoutingConfig {
    fn from(config: &crate::config::CashuConfig) -> Self {
        Self {
            accepted_mints: config.accepted_mints.clone(),
            default_mint: config.default_mint.clone(),
            quote_payment_offer_sat: config.quote_payment_offer_sat,
            quote_ttl_ms: config.quote_ttl_ms,
            settlement_timeout_ms: config.settlement_timeout_ms,
            mint_failure_block_threshold: config.mint_failure_block_threshold,
            peer_suggested_mint_base_cap_sat: config.peer_suggested_mint_base_cap_sat,
            peer_suggested_mint_success_step_sat: config.peer_suggested_mint_success_step_sat,
            peer_suggested_mint_receipt_step_sat: config.peer_suggested_mint_receipt_step_sat,
            peer_suggested_mint_max_cap_sat: config.peer_suggested_mint_max_cap_sat,
            payment_default_block_threshold: config.payment_default_block_threshold,
            chunk_target_bytes: config.chunk_target_bytes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cashu_routing_config_maps_cli_config() {
        let mut config = crate::config::CashuConfig::default();
        config.accepted_mints = vec!["https://mint.example".to_string()];
        config.default_mint = Some("https://mint.example".to_string());
        config.quote_payment_offer_sat = 7;
        config.quote_ttl_ms = 900;
        config.settlement_timeout_ms = 3_000;
        config.mint_failure_block_threshold = 4;
        config.peer_suggested_mint_base_cap_sat = 5;
        config.peer_suggested_mint_success_step_sat = 6;
        config.peer_suggested_mint_receipt_step_sat = 7;
        config.peer_suggested_mint_max_cap_sat = 8;
        config.payment_default_block_threshold = 9;
        config.chunk_target_bytes = 10_000;

        let routing = CashuRoutingConfig::from(&config);
        assert_eq!(routing.accepted_mints, config.accepted_mints);
        assert_eq!(routing.default_mint, config.default_mint);
        assert_eq!(routing.quote_payment_offer_sat, 7);
        assert_eq!(routing.quote_ttl_ms, 900);
        assert_eq!(routing.settlement_timeout_ms, 3_000);
        assert_eq!(routing.mint_failure_block_threshold, 4);
        assert_eq!(routing.peer_suggested_mint_base_cap_sat, 5);
        assert_eq!(routing.peer_suggested_mint_success_step_sat, 6);
        assert_eq!(routing.peer_suggested_mint_receipt_step_sat, 7);
        assert_eq!(routing.peer_suggested_mint_max_cap_sat, 8);
        assert_eq!(routing.payment_default_block_threshold, 9);
        assert_eq!(routing.chunk_target_bytes, 10_000);
    }
}
