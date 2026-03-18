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

## Testing

Use two layers on purpose:

- `pnpm run test:e2e` for fast shell/UI logic in a regular browser.
- `pnpm run test:native:linux` for real native desktop smoke tests on Linux with `tauri-driver`.

Short rationale: WebDriver owns native clicks, text selection, and screenshots; the Iris automation bridge only exposes Iris-specific readiness and shell state. That keeps the bridge narrow instead of rebuilding a second UI driver.

The native smoke harness is Linux-only and expects a desktop-capable environment. Run it in a Linux VM or container with WebKitGTK, `WebKitWebDriver`, D-Bus, and Xvfb:

```bash
xvfb-run -a pnpm run test:native:linux
```

If you need multiple Iris instances on one host, set `IRIS_DAEMON_PORT` (or `IRIS_DAEMON_BIND`) so each app uses its own embedded htree daemon socket.

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

The automation bridge is intentionally semantic. Use it for readiness checks, current shell state, and app-aware commands; use Linux WebDriver for generic UI actions like clicking arbitrary elements, text selection, and taking screenshots.

## License

MIT
