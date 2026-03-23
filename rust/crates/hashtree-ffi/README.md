# hashtree-ffi

UniFFI bindings for common hashtree attachment operations.

This crate exposes a small, FFI-friendly surface for:

- generating `nhash` identifiers from local files
- uploading attachments to Blossom-compatible servers
- downloading attachment bytes or writing them to disk

It is intended for mobile or native app shells that want Kotlin/Swift bindings
without embedding the full hashtree CLI.

Part of [hashtree](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree).
