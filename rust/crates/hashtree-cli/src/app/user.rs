use anyhow::{Context, Result};
use git_remote_htree::nostr_client::{
    load_key_lists, resolve_identity, resolve_self_identity, StoredKey,
};
use nostr::{nips::nip19::ToBech32, PublicKey};

fn format_identity_line(key: &StoredKey) -> Result<String> {
    let npub = PublicKey::from_hex(&key.pubkey_hex)
        .context("Invalid stored pubkey")?
        .to_bech32()
        .context("Failed to encode npub")?;

    Ok(
        if let Some(alias) = key.petname.as_deref().filter(|alias| !alias.is_empty()) {
            format!("{npub} ({alias})")
        } else {
            npub
        },
    )
}

fn move_default_identity_first(keys: &mut Vec<StoredKey>) {
    let Some((default_pubkey_hex, _)) = resolve_self_identity(keys) else {
        return;
    };

    let Some(index) = keys
        .iter()
        .position(|key| key.secret_hex.is_some() && key.pubkey_hex == default_pubkey_hex)
    else {
        return;
    };

    if index > 0 {
        let default_key = keys.remove(index);
        keys.insert(0, default_key);
    }
}

pub(crate) fn show_user_identity() -> Result<()> {
    let initial = load_key_lists();
    let had_signing_key = initial
        .keys_file_entries
        .iter()
        .any(|key| key.secret_hex.is_some());

    resolve_identity("self")?;

    if !had_signing_key {
        eprintln!("Generated new identity");
    }

    let lists = load_key_lists();
    let mut keys_file_entries = lists.keys_file_entries;
    move_default_identity_first(&mut keys_file_entries);

    for key in &keys_file_entries {
        println!("{}", format_identity_line(key)?);
    }

    if !lists.alias_file_entries.is_empty() {
        if !keys_file_entries.is_empty() {
            println!();
        }
        println!("Aliases:");
        for key in &lists.alias_file_entries {
            println!("{}", format_identity_line(key)?);
        }
    }

    Ok(())
}
