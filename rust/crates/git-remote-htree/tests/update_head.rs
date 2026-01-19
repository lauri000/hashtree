//! Ensure fetch refuses to update the checked-out branch unless update-head-ok is set.

mod common;

use common::{create_test_repo, skip_if_no_binary, test_relay::TestRelay, TestEnv, TestServer};
use std::process::Command;
use tempfile::TempDir;

#[test]
fn test_fetch_refuses_update_checked_out_branch() {
    if skip_if_no_binary() {
        return;
    }

    let relay = TestRelay::new(19310);
    let server = match TestServer::new(19311) {
        Some(s) => s,
        None => {
            println!("SKIP: htree binary not found. Run `cargo build --bin htree` first.");
            return;
        }
    };

    let test_env = TestEnv::new(Some(&server.base_url()), Some(&relay.url()));
    let env_vars: Vec<_> = test_env.env();

    let repo = create_test_repo();

    let remote_url = "htree://self/update-head-test";
    let add_remote = Command::new("git")
        .args(["remote", "add", "htree", remote_url])
        .current_dir(repo.path())
        .envs(env_vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .output()
        .expect("Failed to add remote");
    assert!(
        add_remote.status.success(),
        "git remote add failed: {}",
        String::from_utf8_lossy(&add_remote.stderr)
    );

    let push = Command::new("git")
        .args(["push", "htree", "master"])
        .current_dir(repo.path())
        .envs(env_vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .output()
        .expect("Failed to run git push");
    assert!(
        push.status.success() || String::from_utf8_lossy(&push.stderr).contains("-> master"),
        "git push failed: {}",
        String::from_utf8_lossy(&push.stderr)
    );

    let clone_url = format!("htree://{}/update-head-test", test_env.npub);
    let clone_dir = TempDir::new().expect("Failed to create clone dir");
    let clone_path = clone_dir.path().join("cloned-repo");

    let clone = Command::new("git")
        .args(["clone", &clone_url, clone_path.to_str().unwrap()])
        .envs(env_vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .output()
        .expect("Failed to run git clone");
    assert!(
        clone.status.success(),
        "git clone failed: {}",
        String::from_utf8_lossy(&clone.stderr)
    );

    Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(&clone_path)
        .status()
        .expect("Failed to configure git");
    Command::new("git")
        .args(["config", "user.name", "Test User"])
        .current_dir(&clone_path)
        .status()
        .expect("Failed to configure git");

    std::fs::write(clone_path.join("new.txt"), "second commit\n").unwrap();
    Command::new("git")
        .args(["add", "-A"])
        .current_dir(&clone_path)
        .status()
        .expect("Failed to git add");
    Command::new("git")
        .args(["commit", "-m", "Second commit"])
        .current_dir(&clone_path)
        .status()
        .expect("Failed to git commit");

    Command::new("git")
        .args(["remote", "set-url", "origin", remote_url])
        .current_dir(&clone_path)
        .envs(env_vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .status()
        .expect("Failed to set remote url");

    let push2 = Command::new("git")
        .args(["push", "origin", "HEAD:master"])
        .current_dir(&clone_path)
        .envs(env_vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .output()
        .expect("Failed to run second push");
    assert!(
        push2.status.success() || String::from_utf8_lossy(&push2.stderr).contains("-> master"),
        "second push failed: {}",
        String::from_utf8_lossy(&push2.stderr)
    );

    let set_fetch = Command::new("git")
        .args(["config", "remote.htree.fetch", "+refs/heads/*:refs/heads/*"])
        .current_dir(repo.path())
        .status()
        .expect("Failed to set fetch refspec");
    assert!(set_fetch.success(), "Failed to set fetch refspec");

    let fetch = Command::new("git")
        .args(["fetch", "htree"])
        .current_dir(repo.path())
        .envs(env_vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .output()
        .expect("Failed to run git fetch");

    assert!(
        !fetch.status.success(),
        "fetch should fail when updating checked-out branch"
    );
    let stderr = String::from_utf8_lossy(&fetch.stderr);
    assert!(
        stderr.contains("Refusing to update checked-out branch")
            || stderr.contains("refusing to fetch into branch"),
        "unexpected fetch error: {}",
        stderr
    );
}
