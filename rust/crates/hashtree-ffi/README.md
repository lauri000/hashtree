# hashtree-ffi

UniFFI bindings for common hashtree attachment operations.

This crate exposes a small, FFI-friendly surface for:

- generating `nhash` identifiers from local files
- uploading attachments to Blossom-compatible servers
- downloading attachment bytes or writing them to disk

It is intended for mobile or native app shells that want Kotlin/Swift bindings
without embedding the full hashtree CLI.

Part of [hashtree](https://files.iris.to/#/npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/hashtree).
