use anyhow::{bail, Context, Result};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::args::{CashuCommands, CashuMintCommands};

const CASHU_HELPER_ENV: &str = "HTREE_CASHU_HELPER";
const CARGO_HELPER_ENV: &str = "CARGO_BIN_EXE_htree-cashu";

pub(crate) fn run_cashu_helper(data_dir: &Path, command: &CashuCommands) -> Result<()> {
    let current_exe =
        std::env::current_exe().context("Failed to determine htree executable path")?;
    let helper = helper_binary_path(&current_exe)?;
    let args = build_cashu_helper_args(data_dir, command);
    let status = Command::new(&helper)
        .args(&args)
        .status()
        .with_context(|| format!("Failed to launch Cashu helper at {}", helper.display()))?;
    if status.success() {
        return Ok(());
    }

    match status.code() {
        Some(code) => bail!("Cashu helper exited with status code {code}"),
        None => bail!("Cashu helper terminated by signal"),
    }
}

fn helper_binary_path(current_exe: &Path) -> Result<PathBuf> {
    if let Some(path) = std::env::var_os(CASHU_HELPER_ENV) {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = std::env::var_os(CARGO_HELPER_ENV) {
        return Ok(PathBuf::from(path));
    }

    let helper_name = helper_binary_name();
    let mut candidates = Vec::new();
    if let Some(parent) = current_exe.parent() {
        candidates.push(parent.join(helper_name));
        if let Some(grandparent) = parent.parent() {
            candidates.push(grandparent.join(helper_name));
        }
    }

    if let Some(path) = candidates.into_iter().find(|path| path.exists()) {
        return Ok(path);
    }

    bail!(
        "Cashu helper executable not found. Install `htree-cashu` next to `htree`, or set {CASHU_HELPER_ENV}."
    )
}

fn build_cashu_helper_args(data_dir: &Path, command: &CashuCommands) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("--data-dir"),
        data_dir.as_os_str().to_os_string(),
    ];

    match command {
        CashuCommands::Balance { mint } => {
            args.push(OsString::from("balance"));
            if let Some(mint) = mint {
                args.push(OsString::from("--mint"));
                args.push(OsString::from(mint));
            }
        }
        CashuCommands::Topup { amount_sat, mint } => {
            args.push(OsString::from("topup"));
            args.push(OsString::from(amount_sat.to_string()));
            if let Some(mint) = mint {
                args.push(OsString::from("--mint"));
                args.push(OsString::from(mint));
            }
        }
        CashuCommands::Mint { command } => {
            args.push(OsString::from("mint"));
            match command {
                CashuMintCommands::List => {
                    args.push(OsString::from("list"));
                }
                CashuMintCommands::Add { url, make_default } => {
                    args.push(OsString::from("add"));
                    args.push(OsString::from(url));
                    if *make_default {
                        args.push(OsString::from("--default"));
                    }
                }
                CashuMintCommands::Remove { url } => {
                    args.push(OsString::from("remove"));
                    args.push(OsString::from(url));
                }
                CashuMintCommands::Default { url } => {
                    args.push(OsString::from("default"));
                    args.push(OsString::from(url));
                }
            }
        }
    }

    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn test_build_cashu_helper_args_for_balance_and_mint_commands() {
        let data_dir = Path::new("/tmp/htree-data");

        let args = build_cashu_helper_args(
            data_dir,
            &CashuCommands::Balance {
                mint: Some("https://mint.example".to_string()),
            },
        );
        assert_eq!(
            args,
            vec![
                OsString::from("--data-dir"),
                OsString::from("/tmp/htree-data"),
                OsString::from("balance"),
                OsString::from("--mint"),
                OsString::from("https://mint.example"),
            ]
        );

        let args = build_cashu_helper_args(
            data_dir,
            &CashuCommands::Mint {
                command: CashuMintCommands::Add {
                    url: "https://mint.example".to_string(),
                    make_default: true,
                },
            },
        );
        assert_eq!(
            args,
            vec![
                OsString::from("--data-dir"),
                OsString::from("/tmp/htree-data"),
                OsString::from("mint"),
                OsString::from("add"),
                OsString::from("https://mint.example"),
                OsString::from("--default"),
            ]
        );
    }

    #[test]
    fn test_helper_binary_path_prefers_env_override() {
        let _guard = env_lock().lock().unwrap_or_else(|err| err.into_inner());
        let temp_dir = tempfile::tempdir().unwrap();
        let override_path = temp_dir.path().join("custom-helper");
        std::fs::write(&override_path, b"").unwrap();

        env::set_var(CASHU_HELPER_ENV, &override_path);
        env::remove_var(CARGO_HELPER_ENV);

        let resolved = helper_binary_path(Path::new("/tmp/htree")).unwrap();
        assert_eq!(resolved, override_path);

        env::remove_var(CASHU_HELPER_ENV);
    }

    #[test]
    fn test_helper_binary_path_falls_back_to_sibling_binary() {
        let _guard = env_lock().lock().unwrap_or_else(|err| err.into_inner());
        env::remove_var(CASHU_HELPER_ENV);
        env::remove_var(CARGO_HELPER_ENV);

        let temp_dir = tempfile::tempdir().unwrap();
        let current_exe = temp_dir.path().join("htree");
        std::fs::write(&current_exe, b"").unwrap();
        let sibling = temp_dir.path().join(helper_binary_name());
        std::fs::write(&sibling, b"").unwrap();

        let resolved = helper_binary_path(&current_exe).unwrap();
        assert_eq!(resolved, sibling);
    }
}

fn helper_binary_name() -> &'static str {
    if cfg!(windows) {
        "htree-cashu.exe"
    } else {
        "htree-cashu"
    }
}
