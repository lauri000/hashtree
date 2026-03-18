# Iris

Native desktop shell for hashtree apps, built with [Tauri](https://tauri.app/).

Browser-like navigation with an address bar, back/forward history, and favorites. Loads web apps and `htree://` URLs in child webviews with NIP-07 signer injection. Embeds the htree daemon for local P2P connectivity.

## Development

```bash
pnpm install
pnpm run tauri:dev    # Dev mode
pnpm run tauri:build  # Build for distribution
```

Requires [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Automation

Iris can expose a localhost automation API for agents and smoke tests.

```bash
IRIS_AUTOMATION=1 pnpm run tauri:dev
```

When enabled, the app logs the chosen port and serves:

- `GET /automation/health`
- `GET /automation/state`
- `POST /automation/command`

Example command payload:

```json
{ "action": "open_url", "url": "htree://npub1.../public/index.html" }
```

Supported actions are `open_url`, `back`, `forward`, `reload`, `home`, and `settings`.

This is intended to pair well with Linux/Xvfb-based native smoke tests: the API drives the real shell state, while screenshots can come from Playwright (web shell) or OS capture tools (native app).

## License

MIT
