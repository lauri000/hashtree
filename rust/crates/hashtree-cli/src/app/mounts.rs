use anyhow::Result;
use std::path::Path;

use super::mount_registry::{list_active_mounts, ActiveMount};
use super::util::chrono_humanize_timestamp;

pub(crate) fn print_active_mounts(data_dir: &Path, json: bool) -> Result<()> {
    let mounts = list_active_mounts(data_dir)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&mounts)?);
        return Ok(());
    }

    print!(
        "{}",
        format_active_mounts_with(&mounts, chrono_humanize_timestamp)
    );
    Ok(())
}

fn format_active_mounts_with<F>(mounts: &[ActiveMount], humanize_age: F) -> String
where
    F: Fn(u64) -> String,
{
    if mounts.is_empty() {
        return "No active hashtree mounts found.\n".to_string();
    }

    let mut output = String::new();
    for (index, mount) in mounts.iter().enumerate() {
        if index > 0 {
            output.push('\n');
        }
        output.push_str(&format!("{}\n", mount.mountpoint.display()));
        output.push_str(&format!("  target: {}\n", mount.target));
        output.push_str(&format!("  cid: {}\n", mount.mounted_cid));
        output.push_str(&format!("  pid: {}\n", mount.pid));
        output.push_str(&format!("  visibility: {}\n", mount.visibility));
        output.push_str(&format!("  age: {}\n", humanize_age(mount.registered_at)));
        if let Some(published_key) = mount.published_key.as_deref() {
            output.push_str(&format!("  published: {}\n", published_key));
        }
        if mount.allow_other {
            output.push_str("  allow-other: yes\n");
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample_mount() -> ActiveMount {
        ActiveMount {
            target: "npub1example/tree".to_string(),
            mountpoint: PathBuf::from("/tmp/example-mount"),
            mounted_cid: "nhash1qqsq9qxpq9qcrsszg2pvxq6rs0zqg3yyc5fc5z0knh0wlh".to_string(),
            visibility: "public".to_string(),
            published_key: Some("npub1example/tree".to_string()),
            allow_other: true,
            pid: 4242,
            registered_at: 1_717_171_717,
        }
    }

    #[test]
    fn format_active_mounts_shows_useful_fields() {
        let rendered = format_active_mounts_with(&[sample_mount()], |_| "5m ago".to_string());

        assert!(rendered.contains("/tmp/example-mount"));
        assert!(rendered.contains("target: npub1example/tree"));
        assert!(rendered.contains("cid: nhash1qqsq9qxpq9qcrsszg2pvxq6rs0zqg3yyc5fc5z0knh0wlh"));
        assert!(rendered.contains("pid: 4242"));
        assert!(rendered.contains("visibility: public"));
        assert!(rendered.contains("age: 5m ago"));
        assert!(rendered.contains("published: npub1example/tree"));
        assert!(rendered.contains("allow-other: yes"));
    }

    #[test]
    fn format_active_mounts_reports_empty_registry() {
        assert_eq!(
            format_active_mounts_with(&[], |_| unreachable!()),
            "No active hashtree mounts found.\n"
        );
    }
}
