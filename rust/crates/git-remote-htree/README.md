# git-remote-htree

Git remote helper for hashtree - push/pull git repos via Nostr and hashtree.

## Installation

```bash
curl -fsSL https://github.com/mmalmi/hashtree/releases/latest/download/hashtree-$(uname -m | sed 's/arm64/aarch64/')-$(uname -s | tr '[:upper:]' '[:lower:]' | sed 's/darwin/apple-darwin/' | sed 's/linux/unknown-linux-musl/').tar.gz | tar -xz && cd hashtree && ./install.sh
```

That installs `htree`, `htree-cashu`, and `git-remote-htree`.

Or install with Cargo:

```bash
cargo install hashtree-cli git-remote-htree
```

If you already have `hashtree-cli`, just install the helper:

```bash
cargo install git-remote-htree
```

## Usage

```bash
# Clone a repo
git clone htree://npub1.../repo-name

# Push your own repo
git remote add htree htree://self/myrepo
git push htree master

# Link-visible repo (encrypted, shareable via secret URL)
git remote add origin htree://self/myrepo#link-visible
git push origin main

# Clone with secret key
git clone htree://npub1.../repo#k=<64-hex-chars>

# Private repo (encrypted, author-only)
git remote add origin htree://self/myrepo#private
git push origin main
```

## P2P

For P2P sharing between peers, run the hashtree daemon:

```bash
htree start
```

Git operations automatically use the local daemon when running, enabling direct peer-to-peer transfers via WebRTC.

## Configuration

Keys file: `~/.hashtree/keys`

```
nsec1abc123... default
nsec1xyz789... work
```

Use petnames in remote URLs: `htree://work/myproject`

Part of [hashtree-rs](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree).
