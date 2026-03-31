# hashtree-network

Mesh networking stack for hashtree: routing, signaling, peer links, and stores.

Enables direct peer-to-peer data transfer between hashtree nodes using WebRTC data channels, with signaling performed over Nostr relays.

## Features

- WebRTC data channels for P2P blob transfer
- Nostr-based signaling (kind 25050 ephemeral events)
- Peer discovery via contact lists
- Automatic fallback to Blossom servers

## Architecture

1. **Signaling**: Peers exchange WebRTC offers/answers via Nostr relays
2. **Connection**: Direct P2P connection established via ICE/STUN
3. **Data Transfer**: Blobs requested and transferred over data channels

## Usage

Used internally by `hashtree-cli` when running `htree start`. The daemon manages WebRTC connections and responds to blob requests from peers.

Part of [hashtree-rs](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree).
