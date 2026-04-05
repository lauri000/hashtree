mod common;

use std::path::Path;
use std::process::Command;

use common::htree_bin;
use hashtree_cli::HashtreeStore;
use hashtree_core::from_hex;
use tempfile::TempDir;

fn write_site_fixture(root: &Path) {
    std::fs::create_dir_all(root.join(".well-known")).expect("create .well-known");
    std::fs::create_dir_all(root.join(".Trashes")).expect("create .Trashes");
    std::fs::write(root.join("index.html"), "<html>ok</html>").expect("write index");
    std::fs::write(root.join(".DS_Store"), "finder").expect("write .DS_Store");
    std::fs::write(root.join("Thumbs.db"), "thumbs").expect("write Thumbs.db");
    std::fs::write(root.join(".well-known").join("assetlinks.json"), "{}")
        .expect("write assetlinks");
    std::fs::write(root.join(".Trashes").join("ghost.txt"), "ghost").expect("write ghost");
}

fn run_add(site_dir: &Path, data_dir: &Path, config_dir: &Path, extra_args: &[&str]) -> String {
    let output = Command::new(htree_bin())
        .arg("--data-dir")
        .arg(data_dir)
        .arg("add")
        .args(extra_args)
        .arg(site_dir)
        .env("HTREE_CONFIG_DIR", config_dir)
        .output()
        .expect("run htree add");

    assert!(
        output.status.success(),
        "htree add failed.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    String::from_utf8(output.stdout).expect("stdout utf-8")
}

fn parse_hash(stdout: &str) -> String {
    stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("hash:").map(str::trim))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| panic!("missing hash in output:\n{stdout}"))
}

fn root_entry_names(data_dir: &Path, hash_hex: &str) -> Vec<String> {
    let store = HashtreeStore::new(data_dir).expect("open store");
    let hash = from_hex(hash_hex).expect("decode hash");
    let node = store
        .get_tree_node(&hash)
        .expect("get tree node")
        .expect("tree node exists");

    let mut names: Vec<String> = node
        .links
        .iter()
        .filter_map(|link| link.name.clone())
        .collect();
    names.sort();
    names
}

#[test]
fn add_ignores_common_platform_junk_by_default() {
    let temp = TempDir::new().expect("temp dir");
    let site_dir = temp.path().join("site");
    let data_dir = temp.path().join("data");
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&site_dir).expect("create site dir");
    write_site_fixture(&site_dir);

    let stdout = run_add(
        &site_dir,
        &data_dir,
        &config_dir,
        &["--local", "--unencrypted"],
    );
    let names = root_entry_names(&data_dir, &parse_hash(&stdout));

    assert!(
        names.contains(&"index.html".to_string()),
        "expected regular file in root entries: {names:?}"
    );
    assert!(
        names.contains(&".well-known".to_string()),
        "expected hidden non-junk directory to remain visible: {names:?}"
    );
    assert!(
        !names.contains(&".DS_Store".to_string()),
        "expected .DS_Store to be ignored by default: {names:?}"
    );
    assert!(
        !names.contains(&"Thumbs.db".to_string()),
        "expected Thumbs.db to be ignored by default: {names:?}"
    );
    assert!(
        !names.contains(&".Trashes".to_string()),
        "expected .Trashes to be ignored by default: {names:?}"
    );
}

#[test]
fn add_no_ignore_includes_platform_junk_files() {
    let temp = TempDir::new().expect("temp dir");
    let site_dir = temp.path().join("site");
    let data_dir = temp.path().join("data");
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&site_dir).expect("create site dir");
    write_site_fixture(&site_dir);

    let stdout = run_add(
        &site_dir,
        &data_dir,
        &config_dir,
        &["--local", "--unencrypted", "--no-ignore"],
    );
    let names = root_entry_names(&data_dir, &parse_hash(&stdout));

    assert!(
        names.contains(&".DS_Store".to_string()),
        "expected .DS_Store when ignore rules are disabled: {names:?}"
    );
    assert!(
        names.contains(&"Thumbs.db".to_string()),
        "expected Thumbs.db when ignore rules are disabled: {names:?}"
    );
    assert!(
        names.contains(&".Trashes".to_string()),
        "expected .Trashes when ignore rules are disabled: {names:?}"
    );
    assert!(
        names.contains(&".well-known".to_string()),
        "expected hidden non-junk directory to remain visible: {names:?}"
    );
}
