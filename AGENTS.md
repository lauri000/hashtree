# Agent Guidelines

We are building a decentralized system independent of DNS, SSL certificates, web servers, CDNs, etc., so avoid DNS-based identity like NIP-05.

## Shared Rules
- TDD when practical: start with a failing test, then implement.
- Keep tests deterministic; avoid flaky tests.
- Verify changes with unit or e2e tests. Don't ask the user to test. Don't assume code works - everything must be verified with tests.
- Fix all errors you encounter, whether related to your changes or not.
- If remote `origin` exists, run `git pull origin master --rebase` before starting work and again before pushing.
- `origin/master` is the only branch to rebase/merge onto. Never run `git pull`/`git rebase` from `htree://self/*` (or remote `htree`) because it is publish/storage, not an integration upstream.
- If push to `htree://self/hashtree` is non-fast-forward, do not pull from `htree`; keep `master` based on `origin/master` and update `htree` via push strategy (for example `git push --force-with-lease htree master`) only when needed.
- Commit after relevant tests (and build/lint if applicable) pass, then push to htree remote (`htree://self/hashtree`).
- For frontend or TypeScript changes, verify unreleased work in the local dev app (`pnpm tauri dev` / localhost) or in an immutable released shell (`htree://nhash.../index.html`). Do not debug against the mutable `htree://npub.../<app>` shell until that app has actually been published, because it may still point to an older build.
