#![cfg_attr(not(feature = "fuse"), allow(dead_code))]

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use super::util::process_is_running;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ActiveMount {
    pub(crate) target: String,
    pub(crate) mountpoint: PathBuf,
    pub(crate) mounted_cid: String,
    pub(crate) visibility: String,
    pub(crate) published_key: Option<String>,
    pub(crate) allow_other: bool,
    pub(crate) pid: u32,
    pub(crate) registered_at: u64,
}

pub(crate) struct ActiveMountRegistration {
    path: PathBuf,
}

impl ActiveMountRegistration {
    #[allow(dead_code)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ActiveMountRegistration {
    fn drop(&mut self) {
        let _ = remove_mount_record(&self.path);
    }
}

pub(crate) fn register_active_mount(
    data_dir: &Path,
    mount: &ActiveMount,
) -> Result<ActiveMountRegistration> {
    let registry_dir = active_mount_registry_dir(data_dir);
    fs::create_dir_all(&registry_dir)
        .with_context(|| format!("Failed to create {}", registry_dir.display()))?;

    let record_name = format!("{}-{}.json", mount.pid, Uuid::new_v4().simple());
    let record_path = registry_dir.join(record_name);
    let temp_path = registry_dir.join(format!(".{}.tmp", Uuid::new_v4().simple()));
    let payload = serde_json::to_vec_pretty(mount)?;

    fs::write(&temp_path, payload)
        .with_context(|| format!("Failed to write {}", temp_path.display()))?;
    fs::rename(&temp_path, &record_path).with_context(|| {
        format!(
            "Failed to move mount record {} into place",
            record_path.display()
        )
    })?;

    Ok(ActiveMountRegistration { path: record_path })
}

pub(crate) fn list_active_mounts(data_dir: &Path) -> Result<Vec<ActiveMount>> {
    list_active_mounts_with_pid_check(data_dir, process_is_running)
}

fn active_mount_registry_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("mounts").join("active")
}

fn list_active_mounts_with_pid_check<F>(
    data_dir: &Path,
    mut pid_is_running: F,
) -> Result<Vec<ActiveMount>>
where
    F: FnMut(u32) -> bool,
{
    let registry_dir = active_mount_registry_dir(data_dir);
    if !registry_dir.exists() {
        return Ok(Vec::new());
    }

    let mut mounts = Vec::new();
    for entry in fs::read_dir(&registry_dir)
        .with_context(|| format!("Failed to read {}", registry_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.extension() != Some(OsStr::new("json")) {
            continue;
        }

        let mount = match read_mount_record(&path) {
            Ok(mount) => mount,
            Err(error) => {
                eprintln!(
                    "Ignoring invalid mount registry entry {}: {error}",
                    path.display()
                );
                let _ = remove_mount_record(&path);
                continue;
            }
        };

        if pid_is_running(mount.pid) {
            mounts.push(mount);
        } else {
            remove_mount_record(&path)?;
        }
    }

    mounts.sort_by(|left, right| {
        left.mountpoint
            .cmp(&right.mountpoint)
            .then_with(|| left.registered_at.cmp(&right.registered_at))
    });

    remove_registry_dir_if_empty(&registry_dir)?;
    Ok(mounts)
}

fn read_mount_record(path: &Path) -> Result<ActiveMount> {
    let payload = fs::read(path).with_context(|| format!("Failed to read {}", path.display()))?;
    serde_json::from_slice(&payload).with_context(|| format!("Failed to parse {}", path.display()))
}

fn remove_mount_record(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("Failed to remove {}", path.display()));
        }
    }

    if let Some(parent) = path.parent() {
        remove_registry_dir_if_empty(parent)?;
    }

    Ok(())
}

fn remove_registry_dir_if_empty(path: &Path) -> Result<()> {
    match fs::remove_dir(path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty
            ) => {}
        Err(error) => {
            return Err(error).with_context(|| format!("Failed to remove {}", path.display()));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_mount(temp_dir: &tempfile::TempDir, pid: u32) -> ActiveMount {
        ActiveMount {
            target: "npub1example/tree".to_string(),
            mountpoint: temp_dir.path().join("mountpoint"),
            mounted_cid: "nhash1qqsq9qxpq9qcrsszg2pvxq6rs0zqg3yyc5fc5z0knh0wlh".to_string(),
            visibility: "public".to_string(),
            published_key: Some("npub1example/tree".to_string()),
            allow_other: false,
            pid,
            registered_at: 1_717_171_717,
        }
    }

    #[test]
    fn registration_persists_active_mounts() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mount = sample_mount(&temp_dir, 4242);

        let registration =
            register_active_mount(temp_dir.path(), &mount).expect("register active mount");
        let listed = list_active_mounts_with_pid_check(temp_dir.path(), |pid| pid == 4242)
            .expect("list active mounts");

        assert_eq!(listed, vec![mount]);
        assert!(registration.path().exists());
    }

    #[test]
    fn dropping_registration_removes_mount_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mount = sample_mount(&temp_dir, 4242);

        let registration =
            register_active_mount(temp_dir.path(), &mount).expect("register active mount");
        let registration_path = registration.path().to_path_buf();
        drop(registration);

        assert!(!registration_path.exists());
        assert!(list_active_mounts_with_pid_check(temp_dir.path(), |_| true)
            .expect("list active mounts")
            .is_empty());
    }

    #[test]
    fn listing_prunes_stale_mount_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mount = sample_mount(&temp_dir, 7777);
        let registry_dir = active_mount_registry_dir(temp_dir.path());
        fs::create_dir_all(&registry_dir).unwrap();
        let record_path = registry_dir.join("stale.json");
        fs::write(&record_path, serde_json::to_vec_pretty(&mount).unwrap()).unwrap();

        let listed = list_active_mounts_with_pid_check(temp_dir.path(), |_| false)
            .expect("list active mounts");

        assert!(listed.is_empty());
        assert!(!record_path.exists());
        assert!(!registry_dir.exists());
    }

    #[test]
    fn listing_removes_invalid_mount_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let registry_dir = active_mount_registry_dir(temp_dir.path());
        fs::create_dir_all(&registry_dir).unwrap();
        let record_path = registry_dir.join("broken.json");
        fs::write(&record_path, b"{not-json").unwrap();

        let listed = list_active_mounts_with_pid_check(temp_dir.path(), |_| true)
            .expect("list active mounts");

        assert!(listed.is_empty());
        assert!(!record_path.exists());
        assert!(!registry_dir.exists());
    }
}
