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

## License

MIT
