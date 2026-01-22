use std::collections::HashMap;
use std::hash::{Hash as StdHash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use futures::executor::block_on;
use hashtree_core::reader::{TreeEntry, TreeReader};
use hashtree_core::store::Store;
use hashtree_core::types::{Cid, Hash, LinkType};
use thiserror::Error;

pub const ROOT_INODE: u64 = 1;

#[derive(Debug, Error)]
pub enum FsError {
    #[error("root hash is not a directory")]
    InvalidRoot,
    #[error("entry not found")]
    NotFound,
    #[error("not a directory")]
    NotDir,
    #[error("is a directory")]
    IsDir,
    #[error("store error: {0}")]
    Store(String),
    #[error("reader error: {0}")]
    Reader(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryAttr {
    pub inode: u64,
    pub size: u64,
    pub kind: EntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub inode: u64,
    pub name: String,
    pub kind: EntryKind,
}

#[derive(Debug, Clone)]
struct Node {
    hash: Hash,
    link_type: LinkType,
    size: u64,
    key: Option<[u8; 32]>,
}

#[derive(Debug, Clone, Eq)]
struct ChildKey {
    parent: u64,
    name: String,
}

impl PartialEq for ChildKey {
    fn eq(&self, other: &Self) -> bool {
        self.parent == other.parent && self.name == other.name
    }
}

impl StdHash for ChildKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.parent.hash(state);
        self.name.hash(state);
    }
}

pub struct HashtreeFuse<S: Store> {
    reader: TreeReader<S>,
    nodes: RwLock<HashMap<u64, Node>>,
    children: RwLock<HashMap<ChildKey, u64>>,
    parents: RwLock<HashMap<u64, u64>>,
    next_inode: AtomicU64,
}

impl<S: Store> HashtreeFuse<S> {
    pub fn new(store: Arc<S>, root: Hash) -> Result<Self, FsError> {
        let reader = TreeReader::new(store);
        let is_dir = block_on(reader.is_directory(&root))
            .map_err(|e| FsError::Reader(e.to_string()))?;
        if !is_dir {
            return Err(FsError::InvalidRoot);
        }

        let mut nodes = HashMap::new();
        nodes.insert(
            ROOT_INODE,
            Node {
                hash: root,
                link_type: LinkType::Dir,
                size: 0,
                key: None,
            },
        );

        let mut parents = HashMap::new();
        parents.insert(ROOT_INODE, ROOT_INODE);

        Ok(Self {
            reader,
            nodes: RwLock::new(nodes),
            children: RwLock::new(HashMap::new()),
            parents: RwLock::new(parents),
            next_inode: AtomicU64::new(ROOT_INODE + 1),
        })
    }

    pub fn lookup_child(&self, parent: u64, name: &str) -> Result<EntryAttr, FsError> {
        if name.is_empty() {
            return Err(FsError::NotFound);
        }
        if name == "." {
            return self.get_attr(parent);
        }
        if name == ".." {
            let parent_inode = self.parent_inode(parent);
            return self.get_attr(parent_inode);
        }

        let node = self.node_for_inode(parent)?;
        if node.link_type != LinkType::Dir {
            return Err(FsError::NotDir);
        }

        let key = ChildKey {
            parent,
            name: name.to_string(),
        };
        if let Some(inode) = self.children.read().unwrap().get(&key).copied() {
            return self.get_attr(inode);
        }

        let entries = block_on(self.reader.list_directory(&node.hash))
            .map_err(|e| FsError::Reader(e.to_string()))?;

        let entry = entries.into_iter().find(|e| e.name == name).ok_or(FsError::NotFound)?;
        let inode = self.get_or_create_child(parent, &entry);
        self.get_attr(inode)
    }

    pub fn get_attr(&self, inode: u64) -> Result<EntryAttr, FsError> {
        let node = self.node_for_inode(inode)?;
        let kind = Self::kind_from_link(node.link_type);
        let size = if kind == EntryKind::Directory {
            0
        } else {
            self.ensure_size(inode)?
        };

        Ok(EntryAttr { inode, size, kind })
    }

    pub fn read_file(&self, inode: u64, offset: u64, size: u32) -> Result<Vec<u8>, FsError> {
        let node = self.node_for_inode(inode)?;
        if node.link_type == LinkType::Dir {
            return Err(FsError::IsDir);
        }

        let file_size = self.ensure_size(inode)?;
        if offset >= file_size {
            return Ok(vec![]);
        }
        let read_len = (size as u64).min(file_size - offset);
        if read_len == 0 {
            return Ok(vec![]);
        }

        if node.key.is_some() {
            let cid = Cid {
                hash: node.hash,
                key: node.key,
            };
            let data = block_on(self.reader.get(&cid))
                .map_err(|e| FsError::Reader(e.to_string()))?
                .ok_or(FsError::NotFound)?;

            let start = usize::try_from(offset).unwrap_or(usize::MAX);
            if start >= data.len() {
                return Ok(vec![]);
            }
            let end_u64 = offset.saturating_add(read_len);
            let mut end = usize::try_from(end_u64).unwrap_or(data.len());
            if end > data.len() {
                end = data.len();
            }
            return Ok(data[start..end].to_vec());
        }

        let end = offset.saturating_add(read_len);
        let data = block_on(self.reader.read_file_range(&node.hash, offset, Some(end)))
            .map_err(|e| FsError::Reader(e.to_string()))?
            .ok_or(FsError::NotFound)?;
        Ok(data)
    }

    pub fn read_dir(&self, inode: u64) -> Result<Vec<DirEntry>, FsError> {
        let node = self.node_for_inode(inode)?;
        if node.link_type != LinkType::Dir {
            return Err(FsError::NotDir);
        }

        let entries = block_on(self.reader.list_directory(&node.hash))
            .map_err(|e| FsError::Reader(e.to_string()))?;

        let mut out = Vec::with_capacity(entries.len());
        for entry in entries {
            let inode = self.get_or_create_child(inode, &entry);
            out.push(DirEntry {
                inode,
                name: entry.name,
                kind: Self::kind_from_link(entry.link_type),
            });
        }

        Ok(out)
    }

    fn node_for_inode(&self, inode: u64) -> Result<Node, FsError> {
        self.nodes
            .read()
            .unwrap()
            .get(&inode)
            .cloned()
            .ok_or(FsError::NotFound)
    }

    fn ensure_size(&self, inode: u64) -> Result<u64, FsError> {
        let node = self.node_for_inode(inode)?;
        if node.link_type == LinkType::Dir {
            return Ok(0);
        }
        if node.size > 0 {
            return Ok(node.size);
        }

        let size = if node.key.is_some() {
            let cid = Cid {
                hash: node.hash,
                key: node.key,
            };
            let data = block_on(self.reader.get(&cid))
                .map_err(|e| FsError::Reader(e.to_string()))?
                .ok_or(FsError::NotFound)?;
            data.len() as u64
        } else {
            block_on(self.reader.get_size(&node.hash))
                .map_err(|e| FsError::Reader(e.to_string()))?
        };

        if let Some(entry) = self.nodes.write().unwrap().get_mut(&inode) {
            entry.size = size;
        }

        Ok(size)
    }

    fn kind_from_link(link_type: LinkType) -> EntryKind {
        match link_type {
            LinkType::Dir => EntryKind::Directory,
            LinkType::Blob | LinkType::File => EntryKind::File,
        }
    }

    fn parent_inode(&self, inode: u64) -> u64 {
        self.parents
            .read()
            .unwrap()
            .get(&inode)
            .copied()
            .unwrap_or(ROOT_INODE)
    }

    fn get_or_create_child(&self, parent: u64, entry: &TreeEntry) -> u64 {
        let key = ChildKey {
            parent,
            name: entry.name.clone(),
        };

        if let Some(inode) = self.children.read().unwrap().get(&key).copied() {
            return inode;
        }

        let mut children = self.children.write().unwrap();
        if let Some(inode) = children.get(&key).copied() {
            return inode;
        }

        let inode = self.next_inode.fetch_add(1, Ordering::Relaxed);
        children.insert(key, inode);
        drop(children);

        self.nodes.write().unwrap().insert(
            inode,
            Node {
                hash: entry.hash,
                link_type: entry.link_type,
                size: entry.size,
                key: entry.key,
            },
        );
        self.parents.write().unwrap().insert(inode, parent);

        inode
    }
}

#[cfg(feature = "fuse")]
mod fuse_impl {
    use super::*;
    use fuser::{FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyData, ReplyDirectory, ReplyEntry, ReplyStatfs, Request};
    use std::ffi::OsStr;
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    const TTL: Duration = Duration::from_secs(1);

    impl FsError {
        fn errno(&self) -> i32 {
            match self {
                FsError::InvalidRoot => libc::EINVAL,
                FsError::NotFound => libc::ENOENT,
                FsError::NotDir => libc::ENOTDIR,
                FsError::IsDir => libc::EISDIR,
                FsError::Store(_) | FsError::Reader(_) => libc::EIO,
            }
        }
    }

    impl<S: Store + Send + Sync + 'static> HashtreeFuse<S> {
        pub fn mount(self, mountpoint: impl AsRef<Path>, options: &[MountOption]) -> std::io::Result<()> {
            fuser::mount2(self, mountpoint, options)
        }

        fn file_attr(&self, attr: &EntryAttr) -> FileAttr {
            let (kind, perm, nlink) = match attr.kind {
                EntryKind::Directory => (FileType::Directory, 0o555, 2),
                EntryKind::File => (FileType::RegularFile, 0o444, 1),
            };
            let uid = unsafe { libc::geteuid() };
            let gid = unsafe { libc::getegid() };
            let blocks = (attr.size + 511) / 512;

            FileAttr {
                ino: attr.inode,
                size: attr.size,
                blocks,
                atime: SystemTime::UNIX_EPOCH,
                mtime: SystemTime::UNIX_EPOCH,
                ctime: SystemTime::UNIX_EPOCH,
                crtime: SystemTime::UNIX_EPOCH,
                kind,
                perm,
                nlink,
                uid,
                gid,
                rdev: 0,
                blksize: 512,
                flags: 0,
            }
        }

        fn file_type(kind: EntryKind) -> FileType {
            match kind {
                EntryKind::Directory => FileType::Directory,
                EntryKind::File => FileType::RegularFile,
            }
        }
    }

    impl<S: Store + Send + Sync + 'static> Filesystem for HashtreeFuse<S> {
        fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
            let name = match name.to_str() {
                Some(value) => value,
                None => {
                    reply.error(libc::ENOENT);
                    return;
                }
            };

            match self.lookup_child(parent, name) {
                Ok(attr) => reply.entry(&TTL, &self.file_attr(&attr), 0),
                Err(err) => reply.error(err.errno()),
            }
        }

        fn getattr(&mut self, _req: &Request<'_>, ino: u64, reply: ReplyAttr) {
            match self.get_attr(ino) {
                Ok(attr) => reply.attr(&TTL, &self.file_attr(&attr)),
                Err(err) => reply.error(err.errno()),
            }
        }

        fn read(
            &mut self,
            _req: &Request<'_>,
            ino: u64,
            _fh: u64,
            offset: i64,
            size: u32,
            _flags: i32,
            _lock_owner: Option<u64>,
            reply: ReplyData,
        ) {
            let offset = if offset < 0 { 0 } else { offset as u64 };
            match self.read_file(ino, offset, size) {
                Ok(data) => reply.data(&data),
                Err(err) => reply.error(err.errno()),
            }
        }

        fn readdir(
            &mut self,
            _req: &Request<'_>,
            ino: u64,
            _fh: u64,
            offset: i64,
            mut reply: ReplyDirectory,
        ) {
            let mut entries = Vec::new();
            entries.push((ino, EntryKind::Directory, ".".to_string()));
            let parent = self.parent_inode(ino);
            entries.push((parent, EntryKind::Directory, "..".to_string()));

            match self.read_dir(ino) {
                Ok(children) => {
                    for entry in children {
                        entries.push((entry.inode, entry.kind, entry.name));
                    }
                }
                Err(err) => {
                    reply.error(err.errno());
                    return;
                }
            }

            let start = if offset < 0 { 0 } else { offset as usize };
            for (index, (inode, kind, name)) in entries.into_iter().enumerate().skip(start) {
                let next_offset = (index + 1) as i64;
                let full = reply.add(inode, next_offset, Self::file_type(kind), name);
                if full {
                    break;
                }
            }

            reply.ok();
        }

        fn statfs(&mut self, _req: &Request<'_>, _ino: u64, reply: ReplyStatfs) {
            reply.statfs(0, 0, 0, 0, 0, 512, 255, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hashtree_core::builder::{BuilderConfig, TreeBuilder};
    use hashtree_core::store::MemoryStore;
    use hashtree_core::types::DirEntry as TreeDirEntry;

    fn entry_kind(link_type: LinkType) -> EntryKind {
        match link_type {
            LinkType::Dir => EntryKind::Directory,
            LinkType::Blob | LinkType::File => EntryKind::File,
        }
    }

    #[tokio::test]
    async fn test_lookup_and_read_file() {
        let store = Arc::new(MemoryStore::new());
        let builder = TreeBuilder::new(BuilderConfig::new(store.clone()).public());

        let data = b"hello hashtree".to_vec();
        let (cid, size) = builder.put(&data).await.unwrap();

        let entry = TreeDirEntry::from_cid("hello.txt", &cid)
            .with_size(size)
            .with_link_type(LinkType::Blob);
        let root_hash = builder.put_directory(vec![entry]).await.unwrap();

        let fs = HashtreeFuse::new(store, root_hash).unwrap();

        let attr = fs.lookup_child(ROOT_INODE, "hello.txt").unwrap();
        assert_eq!(attr.kind, EntryKind::File);
        assert_eq!(attr.size, size);

        let read = fs.read_file(attr.inode, 0, data.len() as u32).unwrap();
        assert_eq!(read, data);
    }

    #[tokio::test]
    async fn test_read_dir_lists_entries() {
        let store = Arc::new(MemoryStore::new());
        let builder = TreeBuilder::new(BuilderConfig::new(store.clone()).public());

        let (cid_a, size_a) = builder.put(b"aaa").await.unwrap();
        let (cid_b, size_b) = builder.put(b"bbb").await.unwrap();

        let entry_a = TreeDirEntry::from_cid("a.txt", &cid_a)
            .with_size(size_a)
            .with_link_type(LinkType::Blob);
        let entry_b = TreeDirEntry::from_cid("b.txt", &cid_b)
            .with_size(size_b)
            .with_link_type(LinkType::Blob);

        let root_hash = builder.put_directory(vec![entry_a, entry_b]).await.unwrap();

        let fs = HashtreeFuse::new(store, root_hash).unwrap();
        let entries = fs.read_dir(ROOT_INODE).unwrap();

        let mut names: Vec<String> = entries.into_iter().map(|e| e.name).collect();
        names.sort();
        assert_eq!(names, vec!["a.txt".to_string(), "b.txt".to_string()]);
    }

    #[tokio::test]
    async fn test_read_range_chunked_file() {
        let store = Arc::new(MemoryStore::new());
        let builder = TreeBuilder::new(BuilderConfig::new(store.clone()).with_chunk_size(4).public());

        let data = b"chunked-file-data".to_vec();
        let (cid, size) = builder.put(&data).await.unwrap();

        let entry = TreeDirEntry::from_cid("chunked.bin", &cid)
            .with_size(size)
            .with_link_type(LinkType::File);
        let root_hash = builder.put_directory(vec![entry]).await.unwrap();

        let fs = HashtreeFuse::new(store, root_hash).unwrap();
        let attr = fs.lookup_child(ROOT_INODE, "chunked.bin").unwrap();
        assert_eq!(attr.kind, entry_kind(LinkType::File));

        let read = fs.read_file(attr.inode, 3, 6).unwrap();
        assert_eq!(read, data[3..9].to_vec());
    }

    #[tokio::test]
    async fn test_encrypted_file_read() {
        let store = Arc::new(MemoryStore::new());
        let builder = TreeBuilder::new(BuilderConfig::new(store.clone()));

        let data = b"secret data".to_vec();
        let (cid, size) = builder.put(&data).await.unwrap();

        let entry = TreeDirEntry::from_cid("secret.txt", &cid)
            .with_size(size)
            .with_link_type(LinkType::Blob);
        let root_hash = builder.put_directory(vec![entry]).await.unwrap();

        let fs = HashtreeFuse::new(store, root_hash).unwrap();
        let attr = fs.lookup_child(ROOT_INODE, "secret.txt").unwrap();
        let read = fs.read_file(attr.inode, 0, data.len() as u32).unwrap();
        assert_eq!(read, data);
    }

    #[tokio::test]
    async fn test_root_must_be_directory() {
        let store = Arc::new(MemoryStore::new());
        let builder = TreeBuilder::new(BuilderConfig::new(store.clone()).public());
        let (cid, _size) = builder.put(b"root file").await.unwrap();

        let result = HashtreeFuse::new(store, cid.hash);
        assert!(matches!(result, Err(FsError::InvalidRoot)));
    }
}
