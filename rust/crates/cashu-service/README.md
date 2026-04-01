# cashu-service

Reusable Cashu helper and wallet primitives for paid connectivity services.

This crate provides the shared plumbing used by hashtree components that need
Cashu-backed payment flows without duplicating wallet and process-management
logic in each binary.

## Features

- optional wallet support behind the `wallet` feature
- shared async helpers for invoking external payment workflows
- serde-friendly request and response types for service integration

Part of [hashtree](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree).
