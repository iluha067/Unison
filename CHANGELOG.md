# Changelog

All notable changes to Unison are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
`MAJOR.MINOR.PATCH` versions across the plugin and the server.

## [3.4.1] - 2026-09-23

Unison: real-time collaborative vault sync over a hosted WebSocket server.

### Features

- **Rooms on the public Unison server**: "Create a room" starts a room on the
  hosted relay and shares one code, so people can join from anywhere.
- **Per-room keys**: every new room gets its own generated key; the invite code
  carries server, room and key, and a fresh room starts empty.
- **Plans as cards**: Free (up to 5 devices per room) and Pro ($3/month,
  unlimited). Pro is unlocked with a license key the server verifies offline
  (`server/make-license.js`, `docs/plans.md`).
- **Create rooms from mobile** too (rooms run on the hosted server).
- Live file updates, deletes and renames, broadcast to everyone in the room.
- Three-way line merge with a line-union fallback, so concurrent typing merges
  in place instead of being overwritten or duplicated.
- Text files as UTF-8, everything else (images, PDFs, audio) as base64.
- Presence: participant panel, remote carets and selections drawn as overlays
  (the note text is never touched), file-tree badges, typing indicators.
- Per-file server-side version history with restore from the command palette.
- Scope control: whole vault or selected folders, text-only mode, excludes.
- Quick connect codes and self-update from GitHub releases.
- Self-hosting: run `server/server.js` on any machine.

### Changed

- Settings reorganized into Room, Plan, Profile, Sync, Updates and a collapsible
  Advanced section.
- Connection fields are down to three: server address, API key and room key.
  They are hidden when using the hosted relay, so the server address is not
  exposed.
- The Pro buy button is a disabled "Coming soon" placeholder until payments are
  wired up.
- The public server no longer needs a global API key: rooms are protected by
  their own per-room keys.
- The sidebar is reduced to one primary action plus a share button.

### Removed

- The in-plugin local server host (desktop). It used Node `fs`, `os` and
  `eval`, which the community review flags; self-host by running
  `server/server.js` instead.

### Server

- Rooms with presence, cursor and history relay; per-room keys; Free and Pro
  plans via offline license verification.
- `GET /health`, `GET /rooms` and `GET /metrics` (Prometheus format).
- Graceful shutdown, idle-room unloading, per-room storage limits, per-client
  rate limiting and backpressure handling.
- Timing-safe `API_KEY` / `ROOM_TOKEN` comparison, optional `REQUIRE_AUTH`.
- Zero dependencies (its own minimal WebSocket implementation).

### Fixed

- The sidebar no longer shows the server address in the header.
- Name and color moved to Settings (they were re-rendered in the sidebar while
  typing, which could tear the panel apart or blank it).
- The sidebar is never rebuilt while one of its controls has focus, and a render
  error can no longer empty the whole panel.
- Renaming or recoloring now reaches every other client immediately.
- Typing no longer duplicates text when alone in a room (periodic file-index
  responses are delta reconciles, not a full one).

### Build

- Release assets are attested (build provenance) and a root lockfile enables
  reproducible builds.
