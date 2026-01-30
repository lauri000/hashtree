# hashtree-cli

Hashtree daemon and CLI - content-addressed storage with P2P sync.

## Installation

```bash
# Full install with P2P and social graph (default)
cargo install hashtree-cli

# Without social graph (nostrdb)
cargo install hashtree-cli --no-default-features --features p2p

# Minimal install without P2P or social graph
cargo install hashtree-cli --no-default-features
```

## Commands

```bash
# Add content
htree add myfile.txt                    # Add file (encrypted)
htree add mydir/ --public               # Add directory (unencrypted)
htree add myfile.txt --publish mydata   # Add and publish to Nostr

# Push to Blossom servers
htree push <hash>                       # Push to configured servers

# Get/cat content
htree get <hash>                        # Download to file
htree cat <hash>                        # Print to stdout

# Pins
htree pins                              # List pinned content
htree pin <hash>                        # Pin content
htree unpin <hash>                      # Unpin content

# Nostr identity
htree user                              # Show npub
htree publish mydata <hash>             # Publish hash to npub.../mydata
htree follow npub1...                   # Follow user
htree following                         # List followed users

# Daemon
htree start                             # Start P2P daemon
htree start --daemon                    # Start in background
htree start --daemon --log-file /var/log/hashtree.log
htree stop                              # Stop background daemon
htree status                            # Check daemon status
```

## Social Graph

The daemon embeds [nostrdb](https://github.com/damus-io/nostrdb) to maintain a local social graph. On startup it crawls follow lists (kind 3) from Nostr relays and uses follow distance to control write access to your Blossom server -- no allow-lists needed for people in your social circle.

The social graph API is available at `/api/socialgraph/distance/:pubkey`.

## Configuration

Config file: `~/.hashtree/config.toml`

```toml
[blossom]
read_servers = ["https://cdn.iris.to", "https://hashtree.iris.to"]
write_servers = ["https://hashtree.iris.to"]

[nostr]
relays = ["wss://relay.damus.io", "wss://nos.lol"]
socialgraph_root = "npub1..."   # defaults to own key
crawl_depth = 2                 # BFS depth for follow graph crawl
max_write_distance = 3          # max follow distance for write access
```

Keys file: `~/.hashtree/keys`

```
nsec1abc123... default
nsec1xyz789... work
```

Part of [hashtree-rs](https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree).
