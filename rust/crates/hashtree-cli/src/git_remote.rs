//! Git remote helper binary - thin wrapper around git-remote-htree crate
//!
//! Build with `--features git-remote-wrapper` to install alongside `htree`

fn main() {
    git_remote_htree::main_entry();
}
