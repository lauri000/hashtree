#![cfg(feature = "fuse")]

mod common;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use common::htree_bin;
use hashtree_cli::HashtreeStore;
use hashtree_core::{from_hex, nhash_encode};
use serde_json::Value;
use tempfile::TempDir;

const EMPTY_MOUNTS_OUTPUT: &str = "No active hashtree mounts found.";

struct ChildGuard(Option<Child>);

impl ChildGuard {
    fn spawn(command: &mut Command) -> Self {
        let child = command.spawn().expect("spawn mount command");
        Self(Some(child))
    }

    fn child_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("child process available")
    }

    fn kill(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
        }
    }

    fn wait_with_output(&mut self) -> Output {
        self.0
            .take()
            .expect("child process available")
            .wait_with_output()
            .expect("wait for child output")
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[test]
fn mounts_command_reports_empty_state() {
    let tmp = TempDir::new().expect("temp dir");
    let config_dir = tmp.path().join("config");
    let data_dir = tmp.path().join("data");
    std::fs::create_dir_all(&config_dir).expect("create config dir");
    std::fs::create_dir_all(&data_dir).expect("create data dir");

    let output = run_htree_command(&config_dir, &data_dir, ["mounts"]);
    assert_success(&output, "htree mounts");

    let stdout = String::from_utf8(output.stdout).expect("stdout utf-8");
    assert!(
        stdout.contains(EMPTY_MOUNTS_OUTPUT),
        "expected empty mounts output.\nstdout:\n{stdout}"
    );
}

#[test]
fn mount_smoke_lists_active_mount_and_unmounts_cleanly() {
    if let Some(reason) = fuse_smoke_skip_reason() {
        eprintln!("skipping fuse smoke test: {reason}");
        return;
    }

    let tmp = TempDir::new().expect("temp dir");
    let config_dir = tmp.path().join("config");
    let data_dir = tmp.path().join("data");
    let source_dir = tmp.path().join("source");
    let mountpoint = tmp.path().join("mount");
    std::fs::create_dir_all(&config_dir).expect("create config dir");
    std::fs::create_dir_all(&data_dir).expect("create data dir");
    std::fs::create_dir_all(source_dir.join("nested")).expect("create source dir");
    std::fs::create_dir_all(&mountpoint).expect("create mountpoint");
    std::fs::write(
        source_dir.join("nested").join("hello.txt"),
        "hello through fuse",
    )
    .expect("write source file");

    let store = HashtreeStore::new(&data_dir).expect("create store");
    let root_hex = store.upload_dir(&source_dir).expect("upload source dir");
    let nhash =
        nhash_encode(&from_hex(&root_hex).expect("decode root hash")).expect("encode nhash");

    let mut mount_command = Command::new(htree_bin());
    mount_command
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("mount")
        .arg(&nhash)
        .arg(&mountpoint);
    #[cfg(target_os = "macos")]
    mount_command.arg("--allow-other");
    mount_command
        .env("HTREE_CONFIG_DIR", &config_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = ChildGuard::spawn(&mut mount_command);
    wait_for_mounted_file(
        &mut child,
        &config_dir,
        &data_dir,
        mountpoint.join("nested").join("hello.txt"),
        "hello through fuse",
    );

    let mounts_output = run_htree_command(&config_dir, &data_dir, ["mounts"]);
    assert_success(&mounts_output, "htree mounts while mounted");
    let mounts_stdout = String::from_utf8(mounts_output.stdout).expect("stdout utf-8");
    assert!(
        mounts_stdout.contains(&mountpoint.display().to_string()),
        "expected mounts output to include mountpoint.\nstdout:\n{mounts_stdout}"
    );
    assert!(
        mounts_stdout.contains(&nhash),
        "expected mounts output to include target/root.\nstdout:\n{mounts_stdout}"
    );

    let mounts_json_output = run_htree_command(&config_dir, &data_dir, ["mounts", "--json"]);
    assert_success(&mounts_json_output, "htree mounts --json while mounted");
    let mounts_json: Value =
        serde_json::from_slice(&mounts_json_output.stdout).expect("parse mounts json");
    let mounts = mounts_json.as_array().expect("mounts array");
    assert_eq!(mounts.len(), 1, "expected one active mount in json");
    let mount = mounts[0].as_object().expect("mount entry object");
    assert_eq!(
        mount.get("mountpoint").and_then(Value::as_str),
        Some(mountpoint.to_string_lossy().as_ref())
    );
    assert_eq!(
        mount.get("target").and_then(Value::as_str),
        Some(nhash.as_str())
    );
    assert_eq!(
        mount.get("mounted_cid").and_then(Value::as_str),
        Some(nhash.as_str())
    );
    assert_eq!(
        mount.get("visibility").and_then(Value::as_str),
        Some("public")
    );
    assert_eq!(
        mount.get("pid").and_then(Value::as_u64),
        Some(child.child_mut().id().into())
    );
    assert_eq!(mount.get("published_key"), Some(&Value::Null));
    assert_eq!(
        mount.get("allow_other").and_then(Value::as_bool),
        Some(cfg!(target_os = "macos"))
    );

    unmount(&mountpoint);

    let mount_exit = child.wait_with_output();
    assert_success(&mount_exit, "mounted htree process");

    let post_unmount = run_htree_command(&config_dir, &data_dir, ["mounts"]);
    assert_success(&post_unmount, "htree mounts after unmount");
    let post_unmount_stdout = String::from_utf8(post_unmount.stdout).expect("stdout utf-8");
    assert!(
        post_unmount_stdout.contains(EMPTY_MOUNTS_OUTPUT),
        "expected mounts output to be empty after unmount.\nstdout:\n{post_unmount_stdout}"
    );
}

fn run_htree_command<const N: usize>(
    config_dir: &Path,
    data_dir: &Path,
    args: [&str; N],
) -> Output {
    Command::new(htree_bin())
        .arg("--data-dir")
        .arg(data_dir)
        .args(args)
        .env("HTREE_CONFIG_DIR", config_dir)
        .output()
        .expect("run htree command")
}

fn assert_success(output: &Output, description: &str) {
    assert!(
        output.status.success(),
        "{description} failed.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn wait_for_mounted_file(
    child: &mut ChildGuard,
    config_dir: &Path,
    data_dir: &Path,
    path: PathBuf,
    expected: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.child_mut().try_wait().expect("poll child") {
            panic!("mount process exited early: {status}");
        }
        if let Ok(contents) = std::fs::read_to_string(&path) {
            if contents == expected {
                return;
            }
        }
        if Instant::now() >= deadline {
            let registry_output = run_htree_command(config_dir, data_dir, ["mounts", "--json"]);
            child.kill();
            let mount_output = child.wait_with_output();
            panic!(
                "timed out waiting for mounted file {}\nregistry stdout:\n{}\nregistry stderr:\n{}\nmount stdout:\n{}\nmount stderr:\n{}",
                path.display(),
                String::from_utf8_lossy(&registry_output.stdout),
                String::from_utf8_lossy(&registry_output.stderr),
                String::from_utf8_lossy(&mount_output.stdout),
                String::from_utf8_lossy(&mount_output.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn unmount(mountpoint: &Path) {
    #[cfg(target_os = "linux")]
    let commands: &[&str] = &["fusermount3", "fusermount", "umount"];
    #[cfg(not(target_os = "linux"))]
    let commands: &[&str] = &["umount"];

    for command in commands {
        let status = Command::new(command).arg(mountpoint).status();
        match status {
            Ok(status) if status.success() => return,
            Ok(_) | Err(_) => continue,
        }
    }

    panic!("failed to unmount {}", mountpoint.display());
}

fn fuse_smoke_skip_reason() -> Option<String> {
    if std::env::var_os("HTREE_REQUIRE_FUSE_SMOKE").is_some() {
        return None;
    }

    #[cfg(not(target_os = "linux"))]
    {
        return Some(
            "automatic FUSE smoke coverage only runs on Linux; set HTREE_REQUIRE_FUSE_SMOKE=1 to force a local run"
                .to_string(),
        );
    }

    #[cfg(target_os = "linux")]
    {
        if !Path::new("/dev/fuse").exists() {
            return Some("/dev/fuse is not available".to_string());
        }

        return None;
    }
}
