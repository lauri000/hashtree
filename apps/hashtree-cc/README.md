# hashtree.cc

Landing page and file sharing app at [hashtree.cc](https://hashtree.cc).

Upload files, get a content-addressed `nhash` link. Recipients fetch data P2P via WebRTC or from Blossom servers — no accounts, no server-side storage.

## Development

```bash
pnpm install
pnpm run dev      # Dev server
pnpm run build    # Production build
pnpm run test     # E2E tests (Playwright)
```

## License

MIT
