# Iris Files

Content-addressed file storage on Nostr. A web app built on [hashtree](../hashtree).

## Features

- Content-addressed file storage with SHA256 merkle trees
- P2P file sync via WebRTC with Nostr signaling
- Mutable `npub/path` addresses via Nostr events
- Collaborative editing with Yjs CRDT
- Git-like version control (commits, branches)
- Cashu wallet integration
- Offline-first architecture

## URL Format

Routes use `/#/{npub}/{treeName}/{path...}` where treeName is URL-encoded (e.g. `my%20doc` for `my doc`).

## Web App

```bash
# Development
npm run dev

# Build
npm run build

# Preview build
npm run preview
```

Portable Iris video build:

```bash
pnpm run build:video
pnpm run smoke:video:iris
pnpm run publish:video:iris
```

The shared video build lives in `dist-video`. The same artifacts work for both `https://video.iris.to` and `htree://.../video/index.html`: runtime code now picks the right backend for hosted HTTPS, native `http://127.0.0.1`, and Iris `htree://` delivery. The publish helper runs `htree add .` inside `dist-video` and publishes the CHK-encrypted/shareable `nhash` root directly, so the resulting URL shape is `htree://nhash.../index.html`, not `.../dist-video/index.html`.

Portable Pages release:

```bash
# One app
pnpm run release:iris -- files
pnpm run release:iris -- video
pnpm run release:iris -- docs
pnpm run release:iris -- maps
pnpm run release:iris -- boards

# All apps
pnpm run release:all:iris
```

Each release script performs one build, runs focused tests against that exact build output, publishes the built directory to hashtree, and only then deploys the same directory to Cloudflare Pages. If build or tests fail, neither hashtree nor Pages upload runs.

Cloudflare Pages setup:

```bash
npx wrangler pages project create
```

- Create one Direct Upload Pages project per site, for example `docs-iris-to`, `files-iris-to`, `maps-iris-to`, `video-iris-to`, and `boards-iris-to`.
- Attach the desired custom domain in Cloudflare Pages, for example `docs.iris.to`, `files.iris.to`, `maps.iris.to`, `video.iris.to`, or `boards.iris.to`.
- Authenticate Wrangler either with `wrangler login` or with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Set the matching `CF_PAGES_PROJECT_*` environment variables in your shell so the release script knows which Pages project to deploy.

## Desktop App (Tauri)

Build as a native desktop application with [Tauri](https://tauri.app/).

### Prerequisites

Install Tauri prerequisites for your platform: https://v2.tauri.app/start/prerequisites/

- **macOS**: Xcode Command Line Tools
- **Windows**: Microsoft Visual Studio C++ Build Tools, WebView2
- **Linux**: Various system dependencies (see Tauri docs)

Plus Rust: https://rustup.rs/

### Development

```bash
npm run tauri:dev
```

This starts the Vite dev server and opens a native window with hot reload.

### Build

```bash
npm run tauri:build
```

Outputs platform-specific installers in `src-tauri/target/release/bundle/`:
- **macOS**: `.dmg`, `.app`
- **Windows**: `.msi`, `.exe`
- **Linux**: `.deb`, `.AppImage`

### Desktop Features

- **Autostart**: Launch on login (toggle in Settings > Desktop App)
- **System tray**: Background operation with tray icon
- **Native dialogs**: File open/save dialogs
- **Notifications**: Native OS notifications

### Bundling hashtree-cli

To include the `htree` CLI tool in the desktop app:

1. Build htree for target platforms:
   ```bash
   cd ../../rust  # from apps/iris-files
   cargo build --release -p hashtree-cli
   ```

2. Create `src-tauri/bin/` and add platform-specific binaries:
   ```
   src-tauri/bin/
   ├── htree-x86_64-pc-windows-msvc.exe
   ├── htree-x86_64-apple-darwin
   ├── htree-aarch64-apple-darwin
   └── htree-x86_64-unknown-linux-gnu
   ```

3. Update `src-tauri/tauri.conf.json`:
   ```json
   "externalBin": ["bin/htree"]
   ```

4. Access from frontend via Tauri's shell API.

## License

MIT
