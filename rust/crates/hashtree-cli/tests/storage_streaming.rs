use hashtree_cli::HashtreeStore;
use hashtree_core::{from_hex, Cid};

#[test]
fn upload_and_download_streaming_roundtrip_preserves_bytes() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = HashtreeStore::new(tmp.path().join("store")).expect("store");

    let mut source = Vec::with_capacity(2_750_000);
    for i in 0..2_750_000u32 {
        source.push((i % 251) as u8);
    }

    let source_path = tmp.path().join("source.bin");
    std::fs::write(&source_path, &source).expect("write source");

    let cid_str = store
        .upload_file_encrypted(&source_path)
        .expect("upload encrypted");
    let cid = Cid::parse(&cid_str).expect("parse cid");

    let out_path = tmp.path().join("restored.bin");
    let written = store
        .write_file_by_cid(&cid, &out_path)
        .expect("stream download");
    assert_eq!(written as usize, source.len());

    let restored = std::fs::read(&out_path).expect("read restored");
    assert_eq!(restored, source);
}

#[test]
fn upload_public_and_write_by_hash_streaming_roundtrip_preserves_bytes() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = HashtreeStore::new(tmp.path().join("store")).expect("store");

    let source = vec![42u8; 1_600_000];
    let source_path = tmp.path().join("source-public.bin");
    std::fs::write(&source_path, &source).expect("write source");

    let hash_hex = store.upload_file(&source_path).expect("upload public");
    let hash = from_hex(&hash_hex).expect("hash");

    let out_path = tmp.path().join("restored-public.bin");
    let written = store.write_file(&hash, &out_path).expect("stream download");
    assert_eq!(written as usize, source.len());

    let restored = std::fs::read(&out_path).expect("read restored");
    assert_eq!(restored, source);
}

#[test]
fn write_file_by_cid_errors_when_content_missing() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = HashtreeStore::new(tmp.path().join("store")).expect("store");

    let missing_hash = [0x7fu8; 32];
    assert!(store
        .get_chunk(&missing_hash)
        .expect("chunk lookup")
        .is_none());
    let missing_cid = Cid::public(missing_hash);
    let out_path = tmp.path().join("missing.bin");

    let err = store
        .write_file_by_cid(&missing_cid, &out_path)
        .expect_err("missing cid should fail");
    assert!(
        err.to_string().contains("not found"),
        "expected not found error, got: {err}"
    );
    assert!(
        !out_path.exists(),
        "output file should not be created on missing cid"
    );
}
