use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathEntry<T> {
    pub path: String,
    pub kind: PathEntryKind,
    pub value: T,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathTombstone {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathMergeSource<T> {
    pub name: String,
    pub precedence: i32,
    pub entries: Vec<PathEntry<T>>,
    pub tombstones: Vec<PathTombstone>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HiddenReason {
    Shadowed,
    Tombstoned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HiddenPath {
    pub path: String,
    pub kind: PathEntryKind,
    pub source: String,
    pub reason: HiddenReason,
    pub by_source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedPathEntry<T> {
    pub path: String,
    pub kind: PathEntryKind,
    pub value: T,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathMergeResult<T> {
    pub entries: Vec<MergedPathEntry<T>>,
    pub hidden: Vec<HiddenPath>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathMergeError {
    InvalidPath(String),
}

impl std::fmt::Display for PathMergeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathMergeError::InvalidPath(path) => write!(f, "invalid path: {path}"),
        }
    }
}

impl std::error::Error for PathMergeError {}

pub fn merge_path_sources<T>(
    sources: Vec<PathMergeSource<T>>,
) -> Result<PathMergeResult<T>, PathMergeError> {
    let mut ordered = sources
        .into_iter()
        .enumerate()
        .collect::<Vec<(usize, PathMergeSource<T>)>>();
    ordered.sort_by(|(left_index, left), (right_index, right)| {
        right
            .precedence
            .cmp(&left.precedence)
            .then_with(|| right_index.cmp(left_index))
    });

    let mut winners = BTreeMap::<String, MergedPathEntry<T>>::new();
    let mut tombstones = BTreeMap::<String, String>::new();
    let mut hidden = Vec::<HiddenPath>::new();

    for (_, source) in ordered {
        let mut source_entries = BTreeMap::<String, PathEntry<T>>::new();
        for entry in source.entries {
            let normalized_path = normalize_path(&entry.path)?;
            source_entries.insert(
                normalized_path.clone(),
                PathEntry {
                    path: normalized_path,
                    kind: entry.kind,
                    value: entry.value,
                },
            );
        }

        let mut source_tombstones = BTreeSet::<String>::new();
        for tombstone in source.tombstones {
            source_tombstones.insert(normalize_path(&tombstone.path)?);
        }

        for path in &source_tombstones {
            if winners.contains_key(path) || tombstones.contains_key(path) {
                continue;
            }
            tombstones.insert(path.clone(), source.name.clone());
        }

        for path in &source_tombstones {
            if let Some(entry) = source_entries.get(path) {
                hidden.push(HiddenPath {
                    path: path.clone(),
                    kind: entry.kind,
                    source: source.name.clone(),
                    reason: HiddenReason::Tombstoned,
                    by_source: source.name.clone(),
                });
            }
        }

        for (path, entry) in source_entries {
            if source_tombstones.contains(&path) {
                continue;
            }

            if let Some(tombstone_source) = tombstones.get(&path) {
                hidden.push(HiddenPath {
                    path,
                    kind: entry.kind,
                    source: source.name.clone(),
                    reason: HiddenReason::Tombstoned,
                    by_source: tombstone_source.clone(),
                });
                continue;
            }

            if let Some(existing) = winners.get(&path) {
                hidden.push(HiddenPath {
                    path,
                    kind: entry.kind,
                    source: source.name.clone(),
                    reason: HiddenReason::Shadowed,
                    by_source: existing.source.clone(),
                });
                continue;
            }

            winners.insert(
                path.clone(),
                MergedPathEntry {
                    path,
                    kind: entry.kind,
                    value: entry.value,
                    source: source.name.clone(),
                },
            );
        }
    }

    hidden.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.source.cmp(&right.source))
            .then_with(|| left.by_source.cmp(&right.by_source))
    });

    Ok(PathMergeResult {
        entries: winners.into_values().collect(),
        hidden,
    })
}

fn normalize_path(path: &str) -> Result<String, PathMergeError> {
    let trimmed = path.trim();
    let normalized = trimmed
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<&str>>();

    if normalized.is_empty() {
        return Err(PathMergeError::InvalidPath(path.to_string()));
    }

    if normalized
        .iter()
        .any(|segment| *segment == "." || *segment == "..")
    {
        return Err(PathMergeError::InvalidPath(path.to_string()));
    }

    Ok(normalized.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, value: &str) -> PathEntry<String> {
        PathEntry {
            path: path.to_string(),
            kind: PathEntryKind::File,
            value: value.to_string(),
        }
    }

    fn dir(path: &str, value: &str) -> PathEntry<String> {
        PathEntry {
            path: path.to_string(),
            kind: PathEntryKind::Directory,
            value: value.to_string(),
        }
    }

    #[test]
    fn prefers_higher_precedence_entries_on_the_same_path_and_keeps_provenance() {
        let result = merge_path_sources(vec![
            PathMergeSource {
                name: "owner".to_string(),
                precedence: 10,
                entries: vec![file("/docs/readme.md", "owner")],
                tombstones: vec![],
            },
            PathMergeSource {
                name: "writer".to_string(),
                precedence: 20,
                entries: vec![file("docs/readme.md", "writer")],
                tombstones: vec![],
            },
        ])
        .unwrap();

        assert_eq!(
            result.entries,
            vec![MergedPathEntry {
                path: "docs/readme.md".to_string(),
                kind: PathEntryKind::File,
                value: "writer".to_string(),
                source: "writer".to_string(),
            }]
        );
        assert_eq!(
            result.hidden,
            vec![HiddenPath {
                path: "docs/readme.md".to_string(),
                kind: PathEntryKind::File,
                source: "owner".to_string(),
                reason: HiddenReason::Shadowed,
                by_source: "writer".to_string(),
            }]
        );
    }

    #[test]
    fn treats_missing_paths_as_no_opinion_and_keeps_lower_precedence_unique_paths() {
        let result = merge_path_sources(vec![
            PathMergeSource {
                name: "owner".to_string(),
                precedence: 10,
                entries: vec![file("docs/guide.md", "guide")],
                tombstones: vec![],
            },
            PathMergeSource {
                name: "writer".to_string(),
                precedence: 20,
                entries: vec![file("docs/notes.md", "notes")],
                tombstones: vec![],
            },
        ])
        .unwrap();

        assert_eq!(
            result.entries,
            vec![
                MergedPathEntry {
                    path: "docs/guide.md".to_string(),
                    kind: PathEntryKind::File,
                    value: "guide".to_string(),
                    source: "owner".to_string(),
                },
                MergedPathEntry {
                    path: "docs/notes.md".to_string(),
                    kind: PathEntryKind::File,
                    value: "notes".to_string(),
                    source: "writer".to_string(),
                },
            ]
        );
        assert!(result.hidden.is_empty());
    }

    #[test]
    fn applies_explicit_tombstones_without_inferring_deletes_from_absence() {
        let result = merge_path_sources(vec![
            PathMergeSource {
                name: "owner".to_string(),
                precedence: 10,
                entries: vec![file("docs/guide.md", "guide")],
                tombstones: vec![],
            },
            PathMergeSource {
                name: "writer".to_string(),
                precedence: 20,
                entries: vec![],
                tombstones: vec![PathTombstone {
                    path: "/docs/guide.md/".to_string(),
                }],
            },
        ])
        .unwrap();

        assert!(result.entries.is_empty());
        assert_eq!(
            result.hidden,
            vec![HiddenPath {
                path: "docs/guide.md".to_string(),
                kind: PathEntryKind::File,
                source: "owner".to_string(),
                reason: HiddenReason::Tombstoned,
                by_source: "writer".to_string(),
            }]
        );
    }

    #[test]
    fn treats_file_vs_directory_collisions_as_path_conflicts_resolved_by_precedence() {
        let result = merge_path_sources(vec![
            PathMergeSource {
                name: "owner".to_string(),
                precedence: 10,
                entries: vec![dir("docs", "dir-owner")],
                tombstones: vec![],
            },
            PathMergeSource {
                name: "writer".to_string(),
                precedence: 20,
                entries: vec![file("docs", "file-writer")],
                tombstones: vec![],
            },
        ])
        .unwrap();

        assert_eq!(
            result.entries,
            vec![MergedPathEntry {
                path: "docs".to_string(),
                kind: PathEntryKind::File,
                value: "file-writer".to_string(),
                source: "writer".to_string(),
            }]
        );
        assert_eq!(
            result.hidden,
            vec![HiddenPath {
                path: "docs".to_string(),
                kind: PathEntryKind::Directory,
                source: "owner".to_string(),
                reason: HiddenReason::Shadowed,
                by_source: "writer".to_string(),
            }]
        );
    }

    #[test]
    fn rejects_non_normalizable_paths() {
        let err = merge_path_sources(vec![PathMergeSource {
            name: "owner".to_string(),
            precedence: 0,
            entries: vec![file("../secrets.txt", "nope")],
            tombstones: vec![],
        }])
        .unwrap_err();

        assert!(err.to_string().contains("invalid path"));
    }
}
