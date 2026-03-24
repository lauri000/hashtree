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

Portable hashtree publish:

```bash
pnpm run build:docs
pnpm run smoke:docs:iris
pnpm run publish:docs:iris

pnpm run build:video
pnpm run smoke:video:iris
pnpm run publish:video:iris

pnpm run build:maps
pnpm run smoke:maps:iris
pnpm run publish:maps:iris
```

The shared docs, video, and maps builds live in `dist-docs`, `dist-video`, and `dist-maps`. The same artifacts work for both their hosted HTTPS deployments and `htree://.../<tree>/index.html` inside Iris. Each publish helper runs `htree add .` inside the built output directory and publishes the CHK-encrypted/shareable root directly, so the resulting URL shape is `htree://nhash.../index.html`, not `.../dist-*/index.html`.

Portable Cloudflare release:

```bash
# One app
pnpm run release:iris -- files
pnpm run release:iris -- video
pnpm run release:iris -- docs
pnpm run release:iris -- maps
pnpm run release:iris -- boards

# All apps
pnpm run release:all:iris

# Iris Git
pnpm run release:git:iris
```

Each release script performs one build, runs focused tests against that exact build output, publishes the built directory to hashtree, and only then deploys the same directory to Cloudflare. If build or tests fail, neither hashtree nor Cloudflare upload runs.

Frontend debug rule:

- For TypeScript or UI changes, test the app shell from `http://localhost` / `pnpm tauri dev` while developing.
- After publishing, test the released shell from the immutable `htree://nhash.../index.html` URL or the deployed HTTPS site.
- Do not use the mutable `htree://npub.../<app>` app URL to verify unreleased frontend changes. That mutable tree only updates after the publish/release step, so it can easily serve an older app build while you are debugging new code.

Cloudflare Worker static-assets setup:

```bash
npx wrangler deploy --assets ./dist --name iris-files --compatibility-date 2026-03-19 --dry-run
```

- Create or reuse one Worker static-assets service per site, for example `iris-files`.
- The built-in defaults are:
  - `files` -> Worker `iris-files`
  - `git` -> Worker `iris-git`
  - `video` -> Worker `iris-video`, route `video.iris.to/*`
  - `docs` -> Worker `iris-docs`, route `docs.iris.to/*`
  - `maps` -> Worker `iris-maps`, route `maps.iris.to/*`
  - `boards` -> Worker `iris-boards`, custom domain `boards.iris.to`
- Authenticate Wrangler either with `wrangler login` or with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- `pnpm run release:iris -- files` defaults to the `iris-files` Worker service.
- `pnpm run release:git:iris` publishes to the `git` hashtree tree and deploys the `iris-git` Worker service by default.
- Set `CF_WORKER_NAME_*` environment variables only when you want to override the default Worker target. Production routes/domains are only auto-attached when using the built-in Worker name.
- Optionally set `CF_WORKER_COMPATIBILITY_DATE` if you do not want to use the script default.

Cloudflare Pages fallback:

- If you need Pages for a profile with a built-in Worker target, pass `--pages-only` together with `--pages-project` (or set `CF_PAGES_PROJECT_*`).
- If a profile does not have a Worker service yet, you can still set `CF_PAGES_PROJECT_*` instead.
- When both `CF_WORKER_NAME_*` and `CF_PAGES_PROJECT_*` are set for the same profile, the release script deploys to the Worker service.

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
