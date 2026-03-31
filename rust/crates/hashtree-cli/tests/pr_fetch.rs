//! Integration tests for `htree pr show`, `htree pr fetch`, and `htree pr merge`

mod common;
#[path = "../../git-remote-htree/tests/common/mod.rs"]
mod remote_common;

use common::htree_bin;
use nostr::{Event, EventBuilder, Kind, Keys, Tag, TagKind};
use remote_common::{create_test_repo, test_relay::TestRelay, TestEnv, TestServer};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Duration;
use tempfile::TempDir;

fn cargo_target_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("workspace root")
        .to_path_buf();

    match std::env::var_os("CARGO_TARGET_DIR") {
        Some(path) => {
            let path = PathBuf::from(path);
            if path.is_absolute() {
                path
            } else {
                workspace_root.join(path)
            }
        }
        None => workspace_root.join("target"),
    }
}

fn ensure_git_remote_htree_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("workspace root")
        .to_path_buf();
    let debug_dir = cargo_target_dir().join("debug");
    let helper = debug_dir.join("git-remote-htree");
    if helper.exists() {
        return debug_dir;
    }

    let output = Command::new("cargo")
        .args(["build", "-p", "git-remote-htree", "--bin", "git-remote-htree"])
        .current_dir(&workspace_root)
        .output()
        .expect("build git-remote-htree helper");
    assert!(
        output.status.success(),
        "failed to build git-remote-htree.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(helper.exists(), "git-remote-htree binary missing after build");
    debug_dir
}

fn env_with_helper_path(mut env_vars: Vec<(String, String)>) -> Vec<(String, String)> {
    let helper_dir = ensure_git_remote_htree_dir();
    let helper_dir = helper_dir.to_string_lossy().to_string();

    if let Some((_, path)) = env_vars.iter_mut().find(|(key, _)| key == "PATH") {
        *path = format!("{}:{}", helper_dir, path);
    } else {
        env_vars.push(("PATH".to_string(), helper_dir));
    }

    env_vars
}

fn run_git(dir: &Path, args: &[&str], env_vars: &[(String, String)]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .envs(env_vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .output()
        .unwrap_or_else(|e| panic!("failed to run git {:?}: {}", args, e));
    assert!(
        output.status.success(),
        "git {:?} failed.\nstdout:\n{}\nstderr:\n{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_stdout(dir: &Path, args: &[&str], env_vars: &[(String, String)]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .envs(env_vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .output()
        .unwrap_or_else(|e| panic!("failed to run git {:?}: {}", args, e));
    assert!(
        output.status.success(),
        "git {:?} failed.\nstdout:\n{}\nstderr:\n{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn run_htree(dir: &Path, env_vars: &[(String, String)], args: &[&str]) -> Output {
    Command::new(htree_bin())
        .current_dir(dir)
        .envs(env_vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .args(args)
        .output()
        .expect("run htree")
}

fn publish_event(relay_url: &str, event: &Event) {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite::Message};

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build runtime");

    rt.block_on(async move {
        let (mut ws, _) = connect_async(relay_url).await.expect("connect relay");
        let msg = serde_json::json!(["EVENT", event]).to_string();
        ws.send(Message::Text(msg)).await.expect("send event");

        let response = ws.next().await.expect("relay ack").expect("ws frame");
        let response = match response {
            Message::Text(text) => text,
            other => panic!("unexpected relay response: {other:?}"),
        };
        let parsed: Vec<Value> = serde_json::from_str(&response).expect("parse relay response");
        assert_eq!(parsed.first().and_then(Value::as_str), Some("OK"));
        assert_eq!(parsed.get(2).and_then(Value::as_bool), Some(true));
        let _ = ws.close(None).await;
    });
}

struct PrCommandFixture {
    relay: TestRelay,
    _server: TestServer,
    _target_repo: TempDir,
    _source_repo: TempDir,
    _maintainer_env: TestEnv,
    _contributor_env: TestEnv,
    maintainer_env_vars: Vec<(String, String)>,
    target_repo_path: PathBuf,
    target_repo_url: String,
    target_repo_address: String,
    target_pubkey_hex: String,
    source_repo_url: String,
    contributor_keys: Keys,
    feature_tip: String,
}

impl PrCommandFixture {
    fn run_htree(&self, args: &[&str]) -> Output {
        run_htree(&self.target_repo_path, &self.maintainer_env_vars, args)
    }

    fn publish_pr(&self, subject: &str) -> String {
        let event = EventBuilder::new(
            Kind::Custom(1618),
            "",
            [
                Tag::custom(TagKind::custom("a"), vec![self.target_repo_address.clone()]),
                Tag::custom(
                    TagKind::custom("p"),
                    vec![self.target_pubkey_hex.clone()],
                ),
                Tag::custom(TagKind::custom("subject"), vec![subject.to_string()]),
                Tag::custom(TagKind::custom("branch"), vec!["feature".to_string()]),
                Tag::custom(TagKind::custom("branch-name"), vec!["feature".to_string()]),
                Tag::custom(
                    TagKind::custom("target-branch"),
                    vec!["master".to_string()],
                ),
                Tag::custom(TagKind::custom("c"), vec![self.feature_tip.clone()]),
                Tag::custom(TagKind::custom("clone"), vec![self.source_repo_url.clone()]),
            ],
        )
        .to_event(&self.contributor_keys)
        .expect("build PR event");
        let event_id = event.id.to_hex();
        publish_event(&self.relay.url(), &event);
        event_id
    }
}

fn setup_fixture(relay_port: u16, server_port: u16) -> Option<PrCommandFixture> {
    let relay = TestRelay::new(relay_port);
    let server = TestServer::new(server_port)?;
    let maintainer_env = TestEnv::new(Some(&server.base_url()), Some(&relay.url()));
    let contributor_env = TestEnv::new(Some(&server.base_url()), Some(&relay.url()));
    let maintainer_env_vars = env_with_helper_path(maintainer_env.env());
    let contributor_env_vars = env_with_helper_path(contributor_env.env());

    let target_repo = create_test_repo();
    let target_repo_path = target_repo.path().to_path_buf();
    let target_repo_name = "target-pr-commands";
    let target_repo_url = format!("htree://self/{}", target_repo_name);
    run_git(
        &target_repo_path,
        &["remote", "add", "htree", &target_repo_url],
        &maintainer_env_vars,
    );
    run_git(
        &target_repo_path,
        &["push", "htree", "master"],
        &maintainer_env_vars,
    );

    let target_npub = maintainer_env.npub.clone();
    let target_pubkey_hex = hex::encode(
        nostr::PublicKey::parse(&target_npub)
            .expect("parse maintainer npub")
            .to_bytes(),
    );

    let source_repo = TempDir::new().expect("source repo tempdir");
    let source_repo_path = source_repo.path().to_path_buf();
    let clone_output = Command::new("git")
        .args([
            "clone",
            target_repo_path.to_str().expect("target repo path"),
            source_repo_path.to_str().expect("source repo path"),
        ])
        .envs(
            contributor_env_vars
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str())),
        )
        .output()
        .expect("clone target repo into source repo");
    assert!(
        clone_output.status.success(),
        "git clone failed.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&clone_output.stdout),
        String::from_utf8_lossy(&clone_output.stderr)
    );

    run_git(
        &source_repo_path,
        &["checkout", "-b", "feature"],
        &contributor_env_vars,
    );
    std::fs::write(source_repo_path.join("feature.txt"), "feature from source repo\n")
        .expect("write feature file");
    run_git(
        &source_repo_path,
        &["add", "feature.txt"],
        &contributor_env_vars,
    );
    run_git(
        &source_repo_path,
        &["commit", "-m", "Add cross-repo feature"],
        &contributor_env_vars,
    );

    let source_repo_name = "source-pr-commands";
    let source_repo_url = format!("htree://self/{}", source_repo_name);
    run_git(
        &source_repo_path,
        &["remote", "add", "source", &source_repo_url],
        &contributor_env_vars,
    );
    run_git(
        &source_repo_path,
        &["push", "-u", "source", "feature"],
        &contributor_env_vars,
    );
    let source_npub = contributor_env.npub.clone();
    let source_repo_url = format!("htree://{}/{}", source_npub, source_repo_name);
    let feature_tip = git_stdout(&source_repo_path, &["rev-parse", "HEAD"], &contributor_env_vars);
    let contributor_keys = Keys::parse(
        &std::fs::read_to_string(contributor_env.home_dir.join(".hashtree/keys"))
            .expect("read contributor keys")
            .split_whitespace()
            .next()
            .expect("contributor nsec")
            .to_string(),
    )
    .expect("parse contributor keys");

    Some(PrCommandFixture {
        relay,
        _server: server,
        _target_repo: target_repo,
        _source_repo: source_repo,
        _maintainer_env: maintainer_env,
        _contributor_env: contributor_env,
        maintainer_env_vars,
        target_repo_path,
        target_repo_url: format!("htree://{}/{}", target_npub, target_repo_name),
        target_repo_address: format!("30617:{}:{}", target_pubkey_hex, target_repo_name),
        target_pubkey_hex,
        source_repo_url,
        contributor_keys,
        feature_tip,
    })
}

fn find_status_events(relay: &TestRelay, pr_event_id: &str) -> Vec<Value> {
    relay.stored_events()
        .into_iter()
        .filter(|event| event.get("kind").and_then(Value::as_u64) == Some(1631))
        .filter(|event| {
            event.get("tags")
                .and_then(Value::as_array)
                .map(|tags| {
                    tags.iter().any(|tag| {
                        tag.as_array()
                            .map(|arr| {
                                arr.len() >= 2
                                    && arr[0].as_str() == Some("e")
                                    && arr[1].as_str() == Some(pr_event_id)
                            })
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        })
        .collect()
}

#[test]
fn test_pr_show_prints_fetch_and_merge_commands() {
    let Some(fixture) = setup_fixture(19620, 19621) else {
        println!("SKIP: htree binary not found. Run `cargo build --bin htree` first.");
        return;
    };

    let pr_event_id = fixture.publish_pr("Cross-repo CLI show");
    let output = fixture.run_htree(&[
        "pr",
        "show",
        &short_id(&pr_event_id),
        "--repo",
        &fixture.target_repo_url,
    ]);

    assert!(
        output.status.success(),
        "htree pr show failed.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stable_ref = format!("refs/remotes/htree-pr/{}", pr_event_id);
    let fetch_spec = format!("refs/heads/feature:{}", stable_ref);
    assert!(stdout.contains(&fixture.source_repo_url), "stdout:\n{stdout}");
    assert!(stdout.contains(&fetch_spec), "stdout:\n{stdout}");
    assert!(
        stdout.contains(&format!("git merge --no-ff {}", stable_ref)),
        "stdout:\n{stdout}"
    );
}

#[test]
fn test_pr_fetch_imports_source_ref() {
    let Some(fixture) = setup_fixture(19622, 19623) else {
        println!("SKIP: htree binary not found. Run `cargo build --bin htree` first.");
        return;
    };

    let pr_event_id = fixture.publish_pr("Cross-repo CLI fetch");
    let output = fixture.run_htree(&[
        "pr",
        "fetch",
        &pr_event_id,
        "--repo",
        &fixture.target_repo_url,
    ]);

    assert!(
        output.status.success(),
        "htree pr fetch failed.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let fetched_tip = git_stdout(
        &fixture.target_repo_path,
        &[&"rev-parse", &format!("refs/remotes/htree-pr/{}", pr_event_id)],
        &fixture.maintainer_env_vars,
    );
    assert_eq!(fetched_tip, fixture.feature_tip);
}

#[test]
fn test_pr_merge_creates_merge_commit_and_push_publishes_status() {
    let Some(fixture) = setup_fixture(19624, 19625) else {
        println!("SKIP: htree binary not found. Run `cargo build --bin htree` first.");
        return;
    };

    let pr_event_id = fixture.publish_pr("Cross-repo CLI merge");
    let merge_output = fixture.run_htree(&[
        "pr",
        "merge",
        &pr_event_id,
        "--repo",
        &fixture.target_repo_url,
    ]);

    assert!(
        merge_output.status.success(),
        "htree pr merge failed.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&merge_output.stdout),
        String::from_utf8_lossy(&merge_output.stderr)
    );

    let head_parents = git_stdout(
        &fixture.target_repo_path,
        &["rev-list", "--parents", "-n", "1", "HEAD"],
        &fixture.maintainer_env_vars,
    );
    assert_eq!(
        head_parents.split_whitespace().count(),
        3,
        "expected merge commit, got: {}",
        head_parents
    );

    run_git(
        &fixture.target_repo_path,
        &["push", "htree", "master"],
        &fixture.maintainer_env_vars,
    );
    std::thread::sleep(Duration::from_millis(500));

    let status_events = find_status_events(&fixture.relay, &pr_event_id);
    assert!(
        !status_events.is_empty(),
        "expected merged status event for PR {}",
        pr_event_id
    );
}

fn short_id(value: &str) -> &str {
    value.get(..12).unwrap_or(value)
}
