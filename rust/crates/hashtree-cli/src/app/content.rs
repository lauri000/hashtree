use anyhow::Result;

/// Recursively add a directory (handles encryption automatically based on tree config).
pub(crate) async fn add_directory<S: hashtree_core::store::Store>(
    tree: &hashtree_core::HashTree<S>,
    dir: &std::path::Path,
    respect_gitignore: bool,
) -> Result<hashtree_core::Cid> {
    use futures::io::AllowStdIo;
    use hashtree_core::DirEntry;
    use ignore::WalkBuilder;
    use std::collections::HashMap;

    // Collect files by their parent directory path
    let mut dir_contents: HashMap<String, Vec<(String, hashtree_core::Cid)>> = HashMap::new();

    // Use ignore crate for gitignore-aware walking
    let walker = WalkBuilder::new(dir)
        .git_ignore(respect_gitignore)
        .git_global(respect_gitignore)
        .git_exclude(respect_gitignore)
        .hidden(false)
        .build();

    for result in walker {
        let entry = result?;
        let path = entry.path();

        // Skip the root directory itself
        if path == dir {
            continue;
        }

        let relative = path.strip_prefix(dir).unwrap_or(path);

        if path.is_file() {
            let file = std::fs::File::open(path)
                .map_err(|e| anyhow::anyhow!("Failed to open file {}: {}", path.display(), e))?;
            let (cid, _size) = tree
                .put_stream(AllowStdIo::new(file))
                .await
                .map_err(|e| anyhow::anyhow!("Failed to add file {}: {}", path.display(), e))?;

            let parent = relative
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let name = relative
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            dir_contents.entry(parent).or_default().push((name, cid));
        } else if path.is_dir() {
            // Ensure directory entry exists
            let dir_path = relative.to_string_lossy().to_string();
            dir_contents.entry(dir_path).or_default();
        }
    }

    // Build directory tree bottom-up
    let mut dirs: Vec<String> = dir_contents.keys().cloned().collect();
    dirs.sort_by(|a, b| {
        let depth_a = a.matches('/').count() + if a.is_empty() { 0 } else { 1 };
        let depth_b = b.matches('/').count() + if b.is_empty() { 0 } else { 1 };
        depth_b.cmp(&depth_a) // Deepest first
    });

    let mut dir_cids: HashMap<String, hashtree_core::Cid> = HashMap::new();

    for dir_path in dirs {
        let files = dir_contents.get(&dir_path).cloned().unwrap_or_default();

        let mut entries: Vec<DirEntry> = files
            .into_iter()
            .map(|(name, cid)| DirEntry::from_cid(name, &cid))
            .collect();

        // Add subdirectory entries
        for (subdir_path, cid) in &dir_cids {
            let parent = std::path::Path::new(subdir_path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            if parent == dir_path {
                let name = std::path::Path::new(subdir_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                entries.push(DirEntry::from_cid(name, cid));
            }
        }

        let cid = tree
            .put_directory(entries)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to create directory node: {}", e))?;

        dir_cids.insert(dir_path, cid);
    }

    // Return root directory cid
    dir_cids
        .get("")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("No root directory"))
}
