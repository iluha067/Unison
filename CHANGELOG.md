# Changelog

All notable changes to Unison are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
`MAJOR.MINOR.PATCH` versions across the plugin and the server.

## [3.0.1] - 2026-09-23

### Removed

- The optional private-repository "update token". The repository is public, so
  self-updates fetch files straight from the raw CDN.

### Changed

- README rewritten to be short and public-first.
- Added a from-scratch server guide (`docs/server-setup.md`); docs reorganized
  (`docs/updates.md` replaces `docs/private-updates.md`).

## [3.0.0] - 2026-09-23

Rebrand of "UnisonSync" to **Unison** plus a security and reliability pass.

### Changed

- **Rebrand**: plugin id `unison-sync` → `unison`, display name → `Unison`,
  view type `unison-presence`, CSS classes `rts-*` → `unison-*`, log prefix
  `[unison]`. A fresh install into `.obsidian/plugins/unison/` is required.
- Server and plugin versions are now aligned at `3.0.0` (they used to disagree:
  `1.3.0` vs `2.0.0` vs `2.5.1`).
- Plugin self-updates now read the repository URL from a single constant.

### Added

- Server: `GET /rooms` and `GET /metrics` (Prometheus text format).
- Server: graceful shutdown on `SIGINT`/`SIGTERM`, flushing pending writes.
- Server: idle-room unloading from memory (files remain on disk).
- Server: per-room storage accounting and `MAX_ROOM_BYTES` limit.
- Server: `MAX_CLIENTS_PER_ROOM`, backpressure-aware sends.
- Server: configurable CORS for plugin hosting (no more hard-coded `*`).
- Server: structured logging with `LOG_LEVEL` and `X-Content-Type-Options`.
- Unit tests: 13 server tests (`node --test` + `ws`) and 8 plugin merge tests.
- Documentation: `README`, `docs/protocol.md`, `docs/server-setup.md`,
  `docs/updates.md`, `SECURITY.md`, `CHANGELOG.md`.

### Security

- `API_KEY` / `ROOM_TOKEN` compared with `crypto.timingSafeEqual`.
- `REQUIRE_AUTH` can force authentication even without a configured key.
- Message content is stripped of control characters in user names.
- The repository no longer contains any server credentials.

### Fixed

- `/health` reports the real package version instead of a hard-coded string.
- Idle rooms no longer leak memory; empty rooms are unloaded on a timer.

## [2.5.1] - legacy

Last release under the `unison-sync` id: three-way merge, file history, folder
scope, presence overlay and quick connect.
