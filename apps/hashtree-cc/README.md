# hashtree.cc

Landing page and file sharing app at [hashtree.cc](https://hashtree.cc).

Upload files, get a content-addressed `nhash` link. Recipients fetch data P2P via WebRTC or from Blossom servers — no accounts, no server-side storage.

## Development

```bash
pnpm install
pnpm run dev      # Dev server
pnpm run build    # Production build
pnpm run test     # E2E tests (Playwright)
pnpm run test:portable
pnpm run publish:portable
pnpm run release:site
```

`pnpm run test:portable` builds the site, verifies the generated `dist/index.html` stays portable for `htree://` delivery, and smoke-tests that exact build from a nested path so root-absolute asset URLs fail before publish.

`pnpm run release:site` runs the same build and portable checks, publishes the resulting `dist/` directory to hashtree, and then deploys that same directory to a Cloudflare Worker service named `hashtree-cc` by default.

The live `https://hashtree.cc` domain is still served from GitHub Pages today, not Cloudflare, so the release script does not attach the production custom domain automatically. Once the zone is moved to Cloudflare, pass `--domain hashtree.cc` (or `--route hashtree.cc/*`) to cut traffic over there.

## License

MIT
