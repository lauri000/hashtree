mod common;

use common::htree_bin;
use nostr::nips::nip19::ToBech32;
use nostr::Keys;
use std::process::Command;
use tempfile::TempDir;

fn run_user_command(config_dir: &std::path::Path, home_dir: &std::path::Path) -> (String, String) {
    let output = Command::new(htree_bin())
        .arg("user")
        .env("HOME", home_dir)
        .env("HTREE_CONFIG_DIR", config_dir)
        .output()
        .expect("run htree user");

    assert!(
        output.status.success(),
        "htree user failed.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    (
        String::from_utf8(output.stdout).expect("stdout utf-8"),
        String::from_utf8(output.stderr).expect("stderr utf-8"),
    )
}

#[test]
fn user_lists_default_signer_first_and_aliases_separately() {
    let tmp = TempDir::new().expect("temp dir");
    let config_dir = tmp.path().join("config");
    std::fs::create_dir_all(&config_dir).expect("create config dir");

    let work = Keys::generate();
    let default = Keys::generate();
    let alias = Keys::generate();

    let work_nsec = work.secret_key().to_bech32().expect("work nsec");
    let default_nsec = default.secret_key().to_bech32().expect("default nsec");
    let work_npub = work.public_key().to_bech32().expect("work npub");
    let default_npub = default.public_key().to_bech32().expect("default npub");
    let alias_npub = alias.public_key().to_bech32().expect("alias npub");

    std::fs::write(
        config_dir.join("keys"),
        format!("{work_nsec} work\n{default_nsec} default\n"),
    )
    .expect("write keys");
    std::fs::write(
        config_dir.join("aliases"),
        format!("{alias_npub} coworker\n"),
    )
    .expect("write aliases");

    let (stdout, stderr) = run_user_command(&config_dir, tmp.path());
    let lines: Vec<&str> = stdout.lines().collect();

    assert_eq!(lines[0], format!("{default_npub} (default)"));
    assert_eq!(lines[1], format!("{work_npub} (work)"));
    assert_eq!(lines[2], "");
    assert_eq!(lines[3], "Aliases:");
    assert_eq!(lines[4], format!("{alias_npub} (coworker)"));
    assert!(
        !stdout.contains("nsec1"),
        "stdout should not include secret keys:\n{stdout}"
    );
    assert!(
        !stderr.contains("Generated new identity"),
        "existing signing keys should not trigger generation:\n{stderr}"
    );
}

#[test]
fn user_generates_and_shows_a_signing_identity_when_missing() {
    let tmp = TempDir::new().expect("temp dir");
    let config_dir = tmp.path().join("config");
    std::fs::create_dir_all(&config_dir).expect("create config dir");

    let (stdout, stderr) = run_user_command(&config_dir, tmp.path());
    let first_line = stdout.lines().next().expect("npub output");

    assert!(
        first_line.starts_with("npub1"),
        "expected npub on first line, got:\n{stdout}"
    );
    assert!(
        first_line.contains("(self)"),
        "generated key should retain the default self alias:\n{stdout}"
    );
    assert!(
        !stdout.contains("nsec1"),
        "stdout should not include secret keys:\n{stdout}"
    );
    assert!(
        stderr.contains("Generated new identity"),
        "generation should still be reported on stderr:\n{stderr}"
    );
}
