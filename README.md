# Unison

Real-time collaborative sync for [Obsidian](https://obsidian.md). Multiple people
open the same vault through a small self-hosted WebSocket server: edits merge
live, text and binary files stay in sync, and every file keeps server-side
version history.

> Formerly "UnisonSync" / "Realtime Sync". The plugin id is now `unison`.

## Repository layout

```
plugin/   Obsidian plugin (id: unison) — manifest.json, main.js, styles.css
server/   WebSocket sync server (Node.js, dependency: ws)
docs/     protocol.md · self-hosting.md · private-updates.md
```

Everything ships as plain files — **no build step**. `plugin/main.js` is the
whole plugin and can be dropped straight into a vault.

## Features

- **Live collaboration** — file updates, deletes and renames are broadcast to
  everyone in the room within milliseconds.
- **Three-way merge** — concurrent typing is merged in place (per-line diff),
  never silently overwritten or duplicated. Falls back to line union when the
  common base is unknown.
- **Text + binary** — text as UTF-8, everything else (images, PDFs, audio…)
  as base64.
- **Presence** — participant panel, remote carets and selection highlights
  drawn as overlays (the note text itself is never touched), file-tree badges,
  typing indicators.
- **File history** — the server keeps the last N versions per file; restore any
  of them from the command palette.
- **Scope control** — whole vault or selected folders, optional text-only mode,
  exclude patterns.
- **Quick connect** — share server/room/keys as a single paste-able code.
- **Self-update** — the plugin updates itself from this repository (works with
  either a public or a private repo, see `docs/private-updates.md`).

## Install the plugin

### Manual (works with a private repo)

1. Copy `plugin/` into your vault as `.obsidian/plugins/unison/` so that the
   folder contains `manifest.json`, `main.js`, `styles.css`.
2. In Obsidian: **Settings → Community plugins → enable "Unison"**.
3. Open **Settings → Unison** and fill in server URL, API key and room.

### BRAT

Add the repository in [BRAT](https://github.com/TfTHacker/obsidian42-brat).
BRAT needs to be able to read the repo, so it works best with a public repo.

## Run your own server

See [`docs/self-hosting.md`](docs/self-hosting.md). Quick version:

```bash
cd server
npm install --production
API_KEY="$(head -c32 /dev/urandom | base64)" PORT=3000 DATA_DIR=./data node server.js
```

Then in the plugin set **Server** `ws://your-host:3000`, **API key** to the same
value, and pick a shared **Room** name.

## Documentation

- [`docs/protocol.md`](docs/protocol.md) — WebSocket message reference.
- [`docs/self-hosting.md`](docs/self-hosting.md) — server setup, systemd, TLS.
- [`docs/private-updates.md`](docs/private-updates.md) — self-update and tokens.
- [`SECURITY.md`](SECURITY.md) — threat model and hardening checklist.
- [`CHANGELOG.md`](CHANGELOG.md) — version history.

## Development

```bash
# server tests (node:test + ws)
cd server && npm install && npm test

# plugin merge-engine tests (loads main.js with an obsidian stub)
cd plugin && npm test
```

## License

[MIT](LICENSE) © Bredatens
