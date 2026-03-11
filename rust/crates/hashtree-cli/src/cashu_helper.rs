use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::io::AsyncWriteExt;
use tokio::process::Command as TokioCommand;

pub const CASHU_HELPER_ENV: &str = "HTREE_CASHU_HELPER";
pub const CARGO_HELPER_ENV: &str = "CARGO_BIN_EXE_htree-cashu";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CashuSentPayment {
    pub mint_url: String,
    pub unit: String,
    pub amount_sat: u64,
    pub send_fee_sat: u64,
    pub operation_id: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CashuReceivedPayment {
    pub mint_url: String,
    pub unit: String,
    pub amount_sat: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CashuMintBalance {
    pub mint_url: String,
    pub unit: String,
    pub balance_sat: u64,
}

#[async_trait]
pub trait CashuPaymentClient: Send + Sync {
    async fn send_payment(&self, mint_url: &str, amount_sat: u64) -> Result<CashuSentPayment>;
    async fn receive_payment(&self, encoded_token: &str) -> Result<CashuReceivedPayment>;
    async fn revoke_payment(&self, mint_url: &str, operation_id: &str) -> Result<()>;
    async fn mint_balance(&self, mint_url: &str) -> Result<CashuMintBalance>;
}

#[derive(Debug, Clone)]
pub struct CashuHelperClient {
    helper_path: PathBuf,
    data_dir: PathBuf,
}

impl CashuHelperClient {
    pub fn discover(data_dir: impl Into<PathBuf>) -> Result<Self> {
        let current_exe =
            std::env::current_exe().context("Failed to determine htree executable path")?;
        let helper_path = helper_binary_path(&current_exe)?;
        Ok(Self {
            helper_path,
            data_dir: data_dir.into(),
        })
    }

    pub fn helper_path(&self) -> &Path {
        &self.helper_path
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    async fn run_json<T: DeserializeOwned>(
        &self,
        extra_args: &[OsString],
        stdin: Option<&str>,
    ) -> Result<T> {
        let mut cmd = TokioCommand::new(&self.helper_path);
        cmd.args(base_helper_args(&self.data_dir));
        cmd.args(extra_args);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        if stdin.is_some() {
            cmd.stdin(std::process::Stdio::piped());
        }

        let mut child = cmd.spawn().with_context(|| {
            format!(
                "Failed to launch Cashu helper at {}",
                self.helper_path.display()
            )
        })?;

        if let Some(input) = stdin {
            let mut child_stdin = child
                .stdin
                .take()
                .context("Cashu helper stdin unavailable")?;
            child_stdin
                .write_all(input.as_bytes())
                .await
                .context("Failed writing Cashu helper stdin")?;
            child_stdin
                .shutdown()
                .await
                .context("Failed to close Cashu helper stdin")?;
        }

        let output = child
            .wait_with_output()
            .await
            .context("Failed waiting for Cashu helper output")?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            if detail.is_empty() {
                bail!(
                    "Cashu helper exited with status {}",
                    output.status.code().unwrap_or_default()
                );
            }
            bail!("Cashu helper failed: {detail}");
        }

        serde_json::from_slice(&output.stdout)
            .context("Failed to decode JSON from Cashu helper output")
    }
}

#[async_trait]
impl CashuPaymentClient for CashuHelperClient {
    async fn send_payment(&self, mint_url: &str, amount_sat: u64) -> Result<CashuSentPayment> {
        self.run_json(
            &[
                OsString::from("internal"),
                OsString::from("send"),
                OsString::from(amount_sat.to_string()),
                OsString::from("--mint"),
                OsString::from(mint_url),
            ],
            None,
        )
        .await
    }

    async fn receive_payment(&self, encoded_token: &str) -> Result<CashuReceivedPayment> {
        self.run_json(
            &[
                OsString::from("internal"),
                OsString::from("receive"),
                OsString::from("--token-stdin"),
            ],
            Some(encoded_token),
        )
        .await
    }

    async fn revoke_payment(&self, mint_url: &str, operation_id: &str) -> Result<()> {
        let _: serde_json::Value = self
            .run_json(
                &[
                    OsString::from("internal"),
                    OsString::from("revoke"),
                    OsString::from("--mint"),
                    OsString::from(mint_url),
                    OsString::from("--operation-id"),
                    OsString::from(operation_id),
                ],
                None,
            )
            .await?;
        Ok(())
    }

    async fn mint_balance(&self, mint_url: &str) -> Result<CashuMintBalance> {
        self.run_json(
            &[
                OsString::from("internal"),
                OsString::from("balance"),
                OsString::from("--mint"),
                OsString::from(mint_url),
            ],
            None,
        )
        .await
    }
}

pub fn run_helper_status(helper_path: &Path, args: &[OsString]) -> Result<()> {
    let status = Command::new(helper_path)
        .args(args)
        .status()
        .with_context(|| format!("Failed to launch Cashu helper at {}", helper_path.display()))?;
    if status.success() {
        return Ok(());
    }

    match status.code() {
        Some(code) => bail!("Cashu helper exited with status code {code}"),
        None => bail!("Cashu helper terminated by signal"),
    }
}

pub fn base_helper_args(data_dir: &Path) -> [OsString; 2] {
    [
        OsString::from("--data-dir"),
        data_dir.as_os_str().to_os_string(),
    ]
}

pub fn helper_binary_path(current_exe: &Path) -> Result<PathBuf> {
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
        "Cashu helper executable not found. Install `hashtree-cashu-cli` so `htree-cashu` is in PATH next to `htree`, or set {CASHU_HELPER_ENV}."
    )
}

pub fn helper_binary_name() -> &'static str {
    if cfg!(windows) {
        "htree-cashu.exe"
    } else {
        "htree-cashu"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::env;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
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

    #[cfg(unix)]
    #[tokio::test]
    async fn test_cashu_helper_client_send_and_receive_json() {
        let _guard = env_lock().lock().unwrap_or_else(|err| err.into_inner());
        env::remove_var(CARGO_HELPER_ENV);

        let temp_dir = tempfile::tempdir().unwrap();
        let helper_path = temp_dir.path().join("htree-cashu-stub");
        let script = format!(
            "#!/bin/sh\nif [ \"$3\" = \"internal\" ] && [ \"$4\" = \"send\" ]; then\n  printf '%s' '{}'\nelif [ \"$3\" = \"internal\" ] && [ \"$4\" = \"receive\" ]; then\n  cat >/dev/null\n  printf '%s' '{}'\nelse\n  printf '%s' '{}'\nfi\n",
            json!({
                "mint_url": "https://mint.example",
                "unit": "sat",
                "amount_sat": 3,
                "send_fee_sat": 1,
                "operation_id": "op-123",
                "token": "cashuBtoken"
            }),
            json!({
                "mint_url": "https://mint.example",
                "unit": "sat",
                "amount_sat": 3
            }),
            json!({"ok": true}),
        );
        std::fs::write(&helper_path, script).unwrap();
        let mut perms = std::fs::metadata(&helper_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&helper_path, perms).unwrap();

        env::set_var(CASHU_HELPER_ENV, &helper_path);
        let client = CashuHelperClient::discover(temp_dir.path()).unwrap();

        let sent = client
            .send_payment("https://mint.example", 3)
            .await
            .unwrap();
        assert_eq!(sent.amount_sat, 3);
        assert_eq!(sent.send_fee_sat, 1);
        assert_eq!(sent.operation_id, "op-123");

        let received = client.receive_payment("cashuBtoken").await.unwrap();
        assert_eq!(received.amount_sat, 3);
        assert_eq!(received.mint_url, "https://mint.example");

        client
            .revoke_payment("https://mint.example", "op-123")
            .await
            .unwrap();

        env::remove_var(CASHU_HELPER_ENV);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_cashu_helper_client_queries_mint_balance_json() {
        let _guard = env_lock().lock().unwrap_or_else(|err| err.into_inner());
        env::remove_var(CARGO_HELPER_ENV);

        let temp_dir = tempfile::tempdir().unwrap();
        let helper_path = temp_dir.path().join("htree-cashu-stub");
        let script = format!(
            "#!/bin/sh\nif [ \"$3\" = \"internal\" ] && [ \"$4\" = \"balance\" ]; then\n  printf '%s' '{}'\nelse\n  printf '%s' '{}'\nfi\n",
            json!({
                "mint_url": "https://mint.example",
                "unit": "sat",
                "balance_sat": 21
            }),
            json!({"ok": true}),
        );
        std::fs::write(&helper_path, script).unwrap();
        let mut perms = std::fs::metadata(&helper_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&helper_path, perms).unwrap();

        env::set_var(CASHU_HELPER_ENV, &helper_path);
        let client = CashuHelperClient::discover(temp_dir.path()).unwrap();
        let balance = client.mint_balance("https://mint.example").await.unwrap();
        assert_eq!(balance.mint_url, "https://mint.example");
        assert_eq!(balance.unit, "sat");
        assert_eq!(balance.balance_sat, 21);

        env::remove_var(CASHU_HELPER_ENV);
    }
}
