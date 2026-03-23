use anyhow::{Context, Result};
use git_remote_htree::nostr_client::{resolve_identity, NostrClient};
use nostr::{PublicKey, ToBech32};

pub(crate) async fn list_repos(owner: Option<&str>) -> Result<()> {
    let owner = owner
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("self");

    let (pubkey, secret_key) = resolve_identity(owner)?;
    let config = hashtree_config::Config::load_or_default();
    let client = NostrClient::new(&pubkey, secret_key, None, false, &config)
        .context("Failed to initialize Nostr client")?;

    let owner_display = PublicKey::from_hex(&pubkey)
        .ok()
        .and_then(|pk| pk.to_bech32().ok())
        .unwrap_or(pubkey);

    let repos = client.list_repos_async().await?;
    if repos.is_empty() {
        println!("No git repos found for {}.", owner_display);
        return Ok(());
    }

    println!("Git repos for {}:", owner_display);
    for repo_name in repos {
        println!("  htree://{}/{}", owner_display, repo_name);
    }

    Ok(())
}
