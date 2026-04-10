use git_remote_htree::git::object::{ObjectId, ObjectType};
use git_remote_htree::git::refs::Ref;
use git_remote_htree::git::storage::{GitStorage, LocalStore};
use hashtree_config::StorageBackend;
use hashtree_core::store::Store;
use hashtree_core::types::Hash;
use hashtree_lmdb::compute_sha256;
use tempfile::TempDir;

fn payload(seed: u8, len: usize) -> Vec<u8> {
    let mut state = seed as u32 + 1;
    let mut bytes = Vec::with_capacity(len);
    for _ in 0..len {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        bytes.push((state >> 16) as u8);
    }
    bytes
}

fn local_total_bytes(storage: &GitStorage) -> u64 {
    match storage.store().as_ref() {
        LocalStore::Fs(store) => store.stats().unwrap().total_bytes,
        #[cfg(feature = "lmdb")]
        LocalStore::Lmdb(store) => store.stats().unwrap().total_bytes,
    }
}

fn write_large_commit(storage: &GitStorage) -> ObjectId {
    let mut tree_content = Vec::new();

    for (index, seed) in [11u8, 29, 47, 83].iter().copied().enumerate() {
        let blob_oid = storage
            .write_raw_object(ObjectType::Blob, &payload(seed, 4 * 1024))
            .unwrap();
        tree_content.extend_from_slice(format!("100644 track-{}.bin", index + 1).as_bytes());
        tree_content.push(0);
        tree_content.extend_from_slice(&hex::decode(blob_oid.to_hex()).unwrap());
    }

    let tree_oid = storage
        .write_raw_object(ObjectType::Tree, &tree_content)
        .unwrap();
    let commit_content = format!(
        "tree {}\nauthor Test User <test@example.com> 0 +0000\ncommitter Test User <test@example.com> 0 +0000\n\nCache pressure regression\n",
        tree_oid.to_hex()
    );
    storage
        .write_raw_object(ObjectType::Commit, commit_content.as_bytes())
        .unwrap()
}

#[test]
fn test_git_storage_build_evicts_shared_lmdb_on_write_path() {
    let max_size_bytes = 16 * 1024;
    let temp_dir = TempDir::new().unwrap();
    let storage = GitStorage::open_with_backend_and_max_bytes(
        temp_dir.path(),
        StorageBackend::Lmdb,
        max_size_bytes,
    )
    .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();

    let stale_blobs = vec![
        payload(1, 5 * 1024),
        payload(2, 5 * 1024),
        payload(3, 5 * 1024),
    ];
    let stale_hashes: Vec<Hash> = stale_blobs
        .iter()
        .map(|blob| compute_sha256(blob))
        .collect();
    for (hash, blob) in stale_hashes.iter().copied().zip(stale_blobs) {
        runtime.block_on(storage.store().put(hash, blob)).unwrap();
    }

    let before = local_total_bytes(&storage);
    assert!(
        before <= max_size_bytes,
        "prefill should stay within cache budget"
    );

    let commit_oid = write_large_commit(&storage);
    storage
        .write_ref("refs/heads/main", &Ref::Direct(commit_oid))
        .unwrap();
    storage
        .write_ref("HEAD", &Ref::Symbolic("refs/heads/main".to_string()))
        .unwrap();

    storage.build_tree().unwrap();

    let after = local_total_bytes(&storage);
    assert!(
        after <= max_size_bytes,
        "write path should evict stale blobs before exceeding cache limit: after={after} max={max_size_bytes}"
    );

    let evicted_stale = stale_hashes
        .iter()
        .filter(|hash| !runtime.block_on(storage.store().has(hash)).unwrap())
        .count();
    assert!(
        evicted_stale > 0,
        "expected stale shared-cache blobs to be evicted during build"
    );
}
