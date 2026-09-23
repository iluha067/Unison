# Unison

Real-time collaborative sync for [Obsidian](https://obsidian.md). Several people
connect the same vault through a small self-hosted WebSocket server: edits merge
live, text and binary files stay in sync, and every file keeps server-side
version history. It runs on Obsidian desktop (Windows, macOS, Linux) and mobile
(iOS and Android).

## Features

- **Desktop and mobile** - works on Obsidian for Windows, macOS, Linux, iOS and
  Android, from the same vault and the same server.
- **Live collaboration** - updates, deletes and renames go to everyone in the
  room within milliseconds.
- **Three-way merge** - concurrent typing merges in place, never silently
  overwrites or duplicates.
- **Text and binary** - text as UTF-8, everything else (images, PDFs, audio) as
  base64.
- **Presence** - participant panel, remote carets and selections (drawn as
  overlays, the note text is never touched), file-tree badges, typing.
- **File history** - the server keeps the last N versions per file; restore any
  of them from the command palette.
- **Scope control** - whole vault or selected folders, optional text-only mode,
  exclude patterns.
- **Quick connect** - share server, room and keys as one paste-able code.
- **Self-update** - installs new versions from GitHub releases.

## Install the plugin

### BRAT (easiest)

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. **BRAT -> Add beta plugin** -> `iluha067/Unison`.
3. Enable **Unison** in **Settings -> Community plugins**.

### Manual

1. Copy `manifest.json`, `main.js` and `styles.css` into
   `<vault>/.obsidian/plugins/unison/`.
2. Enable **Unison** in **Settings -> Community plugins**.
3. Open **Settings -> Unison** and fill in server URL, API key and room.

## Run a server

Step-by-step guide from a clean server:
[`docs/server-setup.md`](docs/server-setup.md).

Minimal start:

```bash
cd server
npm install --omit=dev
API_KEY="$(head -c32 /dev/urandom | base64)" PORT=3000 DATA_DIR=./data node server.js
```

Then in the plugin set **Server** `ws://your-host:3000`, the same **API key**,
and pick a shared **Room** name.

## Documentation

- [`docs/server-setup.md`](docs/server-setup.md) - deploy the server from scratch
- [`docs/protocol.md`](docs/protocol.md) - WebSocket message reference
- [`docs/updates.md`](docs/updates.md) - how plugin updates work
- [`SECURITY.md`](SECURITY.md) - threat model and hardening
- [`CHANGELOG.md`](CHANGELOG.md) - version history

## Development

```bash
# plugin merge-engine tests (loads main.js with an obsidian stub)
npm test

# server tests (node:test + ws)
cd server && npm install && npm test
```

## License

[MIT](LICENSE) (c) Unison
