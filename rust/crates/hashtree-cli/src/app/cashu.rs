use anyhow::{bail, Result};
use hashtree_cli::cashu::{cashu_wallet_state_path, normalize_mint_url, CashuWalletState};
use hashtree_cli::Config;
use std::collections::BTreeSet;
use std::path::Path;

pub(crate) fn print_balance(
    config: &Config,
    data_dir: &Path,
    mint_filter: Option<&str>,
) -> Result<()> {
    let wallet_path = cashu_wallet_state_path(data_dir);
    let wallet = CashuWalletState::load_or_default(&wallet_path)?;

    let normalized_filter = mint_filter.map(normalize_mint_url).transpose()?;
    if let Some(ref mint_url) = normalized_filter {
        let balance_sat = wallet
            .balance_for_mint(mint_url)
            .map(|mint| mint.balance_sat)
            .unwrap_or(0);
        let accepted = config
            .cashu
            .accepted_mints
            .iter()
            .any(|mint| mint == mint_url);
        let default = config.cashu.default_mint.as_deref() == Some(mint_url.as_str());
        println!("Mint: {mint_url}");
        println!("Accepted: {}", if accepted { "yes" } else { "no" });
        println!("Default: {}", if default { "yes" } else { "no" });
        println!("Balance: {balance_sat} sat");
        return Ok(());
    }

    println!("Cashu balance");
    println!("Total: {} sat", wallet.total_balance_sat());
    if let Some(default_mint) = &config.cashu.default_mint {
        println!("Default mint: {default_mint}");
    } else {
        println!("Default mint: none");
    }

    let mut mint_urls: BTreeSet<String> = config.cashu.accepted_mints.iter().cloned().collect();
    mint_urls.extend(wallet.mints.iter().map(|mint| mint.mint_url.clone()));

    if mint_urls.is_empty() {
        println!("Accepted mints: none configured");
        println!("Use `htree cashu mint add <url>` to accept a mint.");
        return Ok(());
    }

    println!("Mints:");
    for mint_url in mint_urls {
        let balance_sat = wallet
            .balance_for_mint(&mint_url)
            .map(|mint| mint.balance_sat)
            .unwrap_or(0);
        let mut flags = Vec::new();
        if config
            .cashu
            .accepted_mints
            .iter()
            .any(|mint| mint == &mint_url)
        {
            flags.push("accepted");
        } else {
            flags.push("stored-only");
        }
        if config.cashu.default_mint.as_deref() == Some(mint_url.as_str()) {
            flags.push("default");
        }
        println!("  - {mint_url} :: {balance_sat} sat [{}]", flags.join(", "));
    }

    Ok(())
}

pub(crate) fn topup_balance(
    config: &Config,
    data_dir: &Path,
    amount_sat: u64,
    mint: Option<&str>,
) -> Result<()> {
    let mint_url = resolve_selected_mint(config, mint)?;
    let wallet_path = cashu_wallet_state_path(data_dir);
    let mut wallet = CashuWalletState::load_or_default(&wallet_path)?;
    let new_balance = wallet.credit_mint(&mint_url, amount_sat)?;
    wallet.save(&wallet_path)?;

    println!("Credited {amount_sat} sat to {mint_url}");
    println!("New balance: {new_balance} sat");
    println!("Note: this is local wallet state for development until real mint top-up is wired.");
    Ok(())
}

pub(crate) fn list_mints(config: &Config) {
    if config.cashu.accepted_mints.is_empty() {
        println!("No accepted Cashu mints configured.");
        return;
    }

    println!("Accepted Cashu mints:");
    for mint_url in &config.cashu.accepted_mints {
        let suffix = if config.cashu.default_mint.as_deref() == Some(mint_url.as_str()) {
            " (default)"
        } else {
            ""
        };
        println!("  - {mint_url}{suffix}");
    }
}

pub(crate) fn add_mint(config: &mut Config, raw_url: &str, make_default: bool) -> Result<()> {
    let mint_url = normalize_mint_url(raw_url)?;
    if !config
        .cashu
        .accepted_mints
        .iter()
        .any(|mint| mint == &mint_url)
    {
        config.cashu.accepted_mints.push(mint_url.clone());
        config.cashu.accepted_mints.sort();
    }

    if make_default || config.cashu.default_mint.is_none() {
        config.cashu.default_mint = Some(mint_url.clone());
    }

    config.save()?;

    println!("Accepted mint: {mint_url}");
    if config.cashu.default_mint.as_deref() == Some(mint_url.as_str()) {
        println!("Default mint: {mint_url}");
    }
    Ok(())
}

pub(crate) fn remove_mint(config: &mut Config, raw_url: &str) -> Result<()> {
    let mint_url = normalize_mint_url(raw_url)?;
    let original_len = config.cashu.accepted_mints.len();
    config.cashu.accepted_mints.retain(|mint| mint != &mint_url);

    if config.cashu.accepted_mints.len() == original_len {
        bail!("Mint not found in accepted list: {mint_url}");
    }

    if config.cashu.default_mint.as_deref() == Some(mint_url.as_str()) {
        config.cashu.default_mint = config.cashu.accepted_mints.first().cloned();
    }

    config.save()?;
    println!("Removed mint: {mint_url}");
    match &config.cashu.default_mint {
        Some(default_mint) => println!("Default mint: {default_mint}"),
        None => println!("Default mint: none"),
    }
    Ok(())
}

pub(crate) fn set_default_mint(config: &mut Config, raw_url: &str) -> Result<()> {
    let mint_url = normalize_mint_url(raw_url)?;
    if !config
        .cashu
        .accepted_mints
        .iter()
        .any(|mint| mint == &mint_url)
    {
        bail!("Mint is not in accepted list: {mint_url}");
    }
    config.cashu.default_mint = Some(mint_url.clone());
    config.save()?;
    println!("Default mint: {mint_url}");
    Ok(())
}

fn resolve_selected_mint(config: &Config, mint: Option<&str>) -> Result<String> {
    if let Some(raw_mint) = mint {
        let mint_url = normalize_mint_url(raw_mint)?;
        if !config
            .cashu
            .accepted_mints
            .iter()
            .any(|accepted| accepted == &mint_url)
        {
            bail!("Mint is not accepted: {mint_url}");
        }
        return Ok(mint_url);
    }

    if let Some(default_mint) = &config.cashu.default_mint {
        return Ok(default_mint.clone());
    }

    bail!("No default Cashu mint configured. Use `htree cashu mint add <url> --default`.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_remove_and_default_mint() {
        let mut config = Config::default();
        add_mint_without_save(&mut config, "https://mint-b.example/", false).unwrap();
        add_mint_without_save(&mut config, "https://mint-a.example", true).unwrap();
        assert_eq!(
            config.cashu.accepted_mints,
            vec![
                "https://mint-a.example".to_string(),
                "https://mint-b.example".to_string()
            ]
        );
        assert_eq!(
            config.cashu.default_mint,
            Some("https://mint-a.example".to_string())
        );

        remove_mint_without_save(&mut config, "https://mint-a.example").unwrap();
        assert_eq!(
            config.cashu.default_mint,
            Some("https://mint-b.example".to_string())
        );
    }

    #[test]
    fn test_resolve_selected_mint_prefers_explicit_or_default() {
        let mut config = Config::default();
        config.cashu.accepted_mints = vec![
            "https://mint-a.example".to_string(),
            "https://mint-b.example".to_string(),
        ];
        config.cashu.default_mint = Some("https://mint-a.example".to_string());

        assert_eq!(
            resolve_selected_mint(&config, Some("https://mint-b.example/")).unwrap(),
            "https://mint-b.example"
        );
        assert_eq!(
            resolve_selected_mint(&config, None).unwrap(),
            "https://mint-a.example"
        );
        assert!(resolve_selected_mint(&config, Some("https://mint-c.example")).is_err());
    }

    fn add_mint_without_save(config: &mut Config, raw_url: &str, make_default: bool) -> Result<()> {
        let mint_url = normalize_mint_url(raw_url)?;
        if !config
            .cashu
            .accepted_mints
            .iter()
            .any(|mint| mint == &mint_url)
        {
            config.cashu.accepted_mints.push(mint_url.clone());
            config.cashu.accepted_mints.sort();
        }
        if make_default || config.cashu.default_mint.is_none() {
            config.cashu.default_mint = Some(mint_url);
        }
        Ok(())
    }

    fn remove_mint_without_save(config: &mut Config, raw_url: &str) -> Result<()> {
        let mint_url = normalize_mint_url(raw_url)?;
        config.cashu.accepted_mints.retain(|mint| mint != &mint_url);
        if config.cashu.default_mint.as_deref() == Some(mint_url.as_str()) {
            config.cashu.default_mint = config.cashu.accepted_mints.first().cloned();
        }
        Ok(())
    }
}
