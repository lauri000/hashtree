use ignore::{Walk, WalkBuilder};
use std::path::{Component, Path, PathBuf};

const DEFAULT_JUNK_NAMES: &[&str] = &[
    ".DS_Store",
    "Thumbs.db",
    "Desktop.ini",
    ".Spotlight-V100",
    ".Trashes",
    ".TemporaryItems",
    ".fseventsd",
    ".apdisk",
    "$RECYCLE.BIN",
    "System Volume Information",
];

pub fn build_content_walker(root: &Path, respect_ignore_rules: bool) -> Walk {
    let mut builder = WalkBuilder::new(root);
    builder
        .git_ignore(respect_ignore_rules)
        .git_global(respect_ignore_rules)
        .git_exclude(respect_ignore_rules)
        .hidden(false);

    if respect_ignore_rules {
        let root = root.to_path_buf();
        builder.filter_entry(move |entry| should_include_entry(entry.path(), &root));
    }

    builder.build()
}

fn should_include_entry(path: &Path, root: &PathBuf) -> bool {
    path == root || !is_default_junk_path(path)
}

fn is_default_junk_path(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => is_default_junk_name(&name.to_string_lossy()),
        _ => false,
    })
}

fn is_default_junk_name(name: &str) -> bool {
    name.starts_with("._") || DEFAULT_JUNK_NAMES.contains(&name)
}
