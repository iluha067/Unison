# Changelog

All notable changes to Unison are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
`MAJOR.MINOR.PATCH` versions across the plugin and the server.

## [3.1.0] - 2026-09-23

Unison (formerly UnisonSync / Realtime Sync): real-time collaborative vault
sync over a self-hosted WebSocket server.

### Features

- **Host on your computer** (desktop): start the sync server from the plugin
  with one click and share a single connection code; friends join by pasting it.
  The plugin spawns a bundled server, so there is no terminal and no install.
- Live file updates, deletes and renames, broadcast to everyone in the room.
- Three-way line merge with a line-union fallback, so concurrent typing merges
  in place instead of being overwritten or duplicated.
- Text files as UTF-8, everything else (images, PDFs, audio) as base64.
- Presence: participant panel, remote carets and selections drawn as overlays
  (the note text is never touched), file-tree badges, typing indicators.
- Per-file server-side version history with restore from the command palette.
- Scope control: whole vault or selected folders, text-only mode, excludes.
- Quick connect codes and self-update from GitHub releases.

### Changed

- The server is now a single file with **zero dependencies** (its own minimal
  WebSocket implementation), so hosting needs nothing but Node.js.
- The sidebar is reduced to one primary action plus a share button; scope,
  sync mode, name and color moved into settings.

### Server

- Rooms with presence, cursor and history relay.
- `GET /health`, `GET /rooms` and `GET /metrics` (Prometheus format).
- Graceful shutdown, idle-room unloading, per-room storage limits, per-client
  rate limiting and backpressure handling.
- Timing-safe `API_KEY` / `ROOM_TOKEN` comparison, optional `REQUIRE_AUTH`.

### Fixed

- Name and color moved to **Settings -> Unison** (they lived in the sidebar,
  where presence updates re-rendered them mid-typing and could tear the panel
  apart or blank it).
- The sidebar is never rebuilt while one of its controls has focus, and a
  render error can no longer empty the whole panel.
- Renaming or recoloring now reaches every other client immediately.
- Typing no longer duplicates text when alone in a room: periodic file-index
  responses are treated as deltas instead of a full reconcile, so the file is
  no longer merged against the server on every sweep.
