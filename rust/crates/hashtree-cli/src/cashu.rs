use anyhow::{bail, Context, Result};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const CASHU_WALLET_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MintBalance {
    pub mint_url: String,
    pub balance_sat: u64,
    pub total_topped_up_sat: u64,
    pub total_spent_sat: u64,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CashuWalletState {
    pub version: u32,
    #[serde(default)]
    pub mints: Vec<MintBalance>,
}

impl Default for CashuWalletState {
    fn default() -> Self {
        Self {
            version: CASHU_WALLET_STATE_VERSION,
            mints: Vec::new(),
        }
    }
}

impl CashuWalletState {
    pub fn load_or_default(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = fs::read_to_string(path).context("Failed to read Cashu wallet state")?;
        let mut state: Self =
            serde_json::from_str(&content).context("Failed to parse Cashu wallet state")?;
        state.sort_mints();
        Ok(state)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).context("Failed to create Cashu wallet directory")?;
        }
        let content =
            serde_json::to_string_pretty(self).context("Failed to encode Cashu wallet state")?;
        fs::write(path, content).context("Failed to write Cashu wallet state")?;
        Ok(())
    }

    pub fn total_balance_sat(&self) -> u64 {
        self.mints.iter().map(|mint| mint.balance_sat).sum()
    }

    pub fn balance_for_mint(&self, mint_url: &str) -> Option<&MintBalance> {
        self.mints.iter().find(|mint| mint.mint_url == mint_url)
    }

    pub fn credit_mint(&mut self, mint_url: &str, amount_sat: u64) -> Result<u64> {
        if amount_sat == 0 {
            bail!("Cashu topup amount must be greater than zero");
        }

        let now = unix_ms_now();
        let entry = self.mints.iter_mut().find(|mint| mint.mint_url == mint_url);
        match entry {
            Some(entry) => {
                entry.balance_sat = entry.balance_sat.saturating_add(amount_sat);
                entry.total_topped_up_sat = entry.total_topped_up_sat.saturating_add(amount_sat);
                entry.updated_at_unix_ms = now;
            }
            None => self.mints.push(MintBalance {
                mint_url: mint_url.to_string(),
                balance_sat: amount_sat,
                total_topped_up_sat: amount_sat,
                total_spent_sat: 0,
                updated_at_unix_ms: now,
            }),
        }
        self.sort_mints();
        Ok(self
            .balance_for_mint(mint_url)
            .map(|mint| mint.balance_sat)
            .unwrap_or(0))
    }

    fn sort_mints(&mut self) {
        self.mints.sort_by(|a, b| a.mint_url.cmp(&b.mint_url));
    }
}

pub fn cashu_wallet_state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cashu-wallet.json")
}

pub fn normalize_mint_url(raw: &str) -> Result<String> {
    let mut url = Url::parse(raw).with_context(|| format!("Invalid mint URL: {raw}"))?;
    match url.scheme() {
        "http" | "https" => {}
        scheme => bail!("Unsupported mint URL scheme: {scheme}"),
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("Mint URL must not include query or fragment");
    }

    let trimmed_path = url.path().trim_end_matches('/').to_string();
    if trimmed_path.is_empty() {
        url.set_path("");
    } else {
        url.set_path(&trimmed_path);
    }

    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_mint_url_trims_trailing_slash_and_rejects_query() {
        assert_eq!(
            normalize_mint_url("https://mint.example/").unwrap(),
            "https://mint.example"
        );
        assert_eq!(
            normalize_mint_url("http://127.0.0.1:3338/api/v1/").unwrap(),
            "http://127.0.0.1:3338/api/v1"
        );
        assert!(normalize_mint_url("wss://mint.example").is_err());
        assert!(normalize_mint_url("https://mint.example/?x=1").is_err());
    }

    #[test]
    fn test_cashu_wallet_state_roundtrip_and_credit() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = cashu_wallet_state_path(temp_dir.path());

        let mut state = CashuWalletState::load_or_default(&path).unwrap();
        assert_eq!(state.total_balance_sat(), 0);

        assert_eq!(state.credit_mint("https://mint-b.example", 7).unwrap(), 7);
        assert_eq!(state.credit_mint("https://mint-a.example", 5).unwrap(), 5);
        assert_eq!(state.credit_mint("https://mint-a.example", 3).unwrap(), 8);
        state.save(&path).unwrap();

        let restored = CashuWalletState::load_or_default(&path).unwrap();
        assert_eq!(restored.total_balance_sat(), 15);
        assert_eq!(
            restored
                .mints
                .iter()
                .map(|mint| mint.mint_url.as_str())
                .collect::<Vec<_>>(),
            vec!["https://mint-a.example", "https://mint-b.example"]
        );
        let mint_a = restored.balance_for_mint("https://mint-a.example").unwrap();
        assert_eq!(mint_a.balance_sat, 8);
        assert_eq!(mint_a.total_topped_up_sat, 8);
    }
}
