Homebrew packaging notes

Homebrew taps do not need GitHub. `brew tap user/repo URL` accepts any Git
remote URL that `git clone` understands.

That means a GitHub-independent tap works if both of these are true:

1. The tap itself is published as a Git repository that can be cloned over HTTP.
2. The formula assets are published at stable HTTP(S) URLs with fixed checksums.

For a generic static file host, the tap repository must be served as an
HTTP-cloneable bare Git repository. A plain directory of files is not enough.
The bare repository needs `git update-server-info` so dumb HTTP cloning works.

For an `htree://`-published repository served through the `upload.iris.to`
gateway, users can tap the repository's `/.git` subtree directly:

```bash
brew tap <user>/htree https://upload.iris.to/<npub>/<repo>/.git
```

That path works as long as the published repo includes dumb-HTTP metadata in
`.git/info/refs` and `.git/objects/info/packs`.

## Recommended naming

- Formula name: `htree`
- Installed binaries: `htree`, `htree-cashu`, `git-remote-htree`
- Alias: `hashtree`

This keeps the package name aligned with the commonly used command while still
allowing discovery by the project name.

## Create a tap repository

Build release artifacts first so the checksum files exist:

```bash
rust/scripts/build_release_artifacts.sh --version v<version>
```

Then generate a bare tap repository:

```bash
packaging/homebrew/create_tap.sh \
  --version v<version> \
  --release-base-url https://upload.iris.to/<npub>/<release-tree>/v<version> \
  --checksums-dir rust/dist/hashtree-v<version> \
  --output-dir dist/homebrew-htree.git
```

This writes a bare Git repository at `dist/homebrew-htree.git` containing:

- `Formula/htree.rb`
- `Aliases/hashtree`

Publish that bare repository directory to static HTTP hosting, preserving its
paths exactly. After it is reachable at a stable URL, users can install with:

```bash
brew tap <user>/htree https://upload.iris.to/<npub>/<tap-path>/homebrew-htree.git
brew install htree
```

Or in one command:

```bash
brew install <user>/htree/htree
```

After tapping, `brew install hashtree` should also work via the alias.

If you prefer publishing the tap repo itself through hashtree instead of
hosting a bare repo directory, push a normal Git repository to
`htree://self/<repo>` and tap the gateway URL instead:

```bash
brew tap <user>/htree https://upload.iris.to/<npub>/<repo>/.git
brew install htree
```

The repo includes a helper for that flow:

```bash
packaging/homebrew/publish_tap.sh \
  --version v<version> \
  --release-base-url https://upload.iris.to/<npub>/releases/hashtree/v<version> \
  --checksums-dir rust/dist/hashtree-v<version>
```

By default it pushes to `htree://self/homebrew-hashtree`, creating or
replacing that tap repo without needing a pre-existing GitHub repository or
manually managed tap checkout.

`rust/scripts/release_to_htree.sh` calls this automatically when the release
directory contains the full macOS/Linux checksum set needed by the formula. Add
`--cargo-publish` there if you also want the same command to publish the Rust
crates to crates.io.

## Local verification

Run the end-to-end transport test:

```bash
packaging/homebrew/tests/test_static_http_tap.sh
```

That test serves a bare tap repository over local static HTTP, runs
`brew tap ... <URL>`, installs the formula, and runs `brew test`.

To verify the publish helper against a local git remote:

```bash
packaging/homebrew/tests/test_publish_tap_to_file_remote.sh
```
