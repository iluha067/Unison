# Protocol

Unison speaks newline-free JSON over a single WebSocket connection. Every
message is an object with a `type` string. File paths are always vault-relative
with `/` separators, and `.obsidian/` / `.trash/` are rejected.

A client must send `hello` first; any other message before that is answered with
`{"type":"error","message":"send hello first"}`.

## Client → server

| type | fields | notes |
| --- | --- | --- |
| `hello` | `room`, `user`, `clientId`, `color`, `token`, `apiKey`, `files?`, `device?` | Join a room. `apiKey` must match the server when auth is on. |
| `ping` | `t` | Latency probe. |
| `list` | - | Ask for the full server file index. |
| `file-update` | `path`, `content`, `encoding`, `mtime?` | `encoding` is `utf8` (default) or `base64`. |
| `file-delete` | `path` | |
| `file-rename` | `oldPath`, `newPath` | Server migrates content and history. |
| `file-pull` | `path` | Ask the server for one file. |
| `history-list` | `path` | List stored versions. |
| `history-get` | `path`, `version` | Fetch one stored version. |
| `cursor` | `path`, `line`, `ch`, `typing?`, `sel?`, `user?`, `color?` | `sel` is `{a:{line,ch}, h:{line,ch}}`. A `user`/`color` here refreshes the displayed name/color. |

## Server → client

| type | fields | notes |
| --- | --- | --- |
| `welcome` | `you:{user,clientId}`, `users[]`, `files[]` | Sent right after a valid `hello`. |
| `file-list` | `files[]` | Reply to `list`. Each item: `path`, `mtime`, `size`, `hash`, `version`, `encoding`. |
| `user-join` / `user-leave` | `user`, `clientId`, `color?` | |
| `presence` | `users[]` | Full participant list; each has `user`, `clientId`, `color`, `path`, `line`, `sel`. |
| `file-update` | `path`, `content`, `encoding`, `mtime`, `version`, `user`, `clientId` | Broadcast to everyone except the sender; `clientId:"server"` for pulls. |
| `file-delete` | `path`, `user`, `clientId` | |
| `file-rename` | `oldPath`, `newPath`, `user`, `clientId` | |
| `history` | `path`, `versions[]` | Each: `version`, `mtime`, `user`, `hash`. |
| `history-file` | `path`, `content`, `encoding`, `version`, `mtime`, `user` | |
| `cursor` | `path`, `line`, `ch`, `typing`, `sel`, `user`, `clientId`, `color` | |
| `error` | `message` | Non-fatal unless the server also closes the socket. |
| `pong` | `t` | Echo of `ping`. |

## Errors & close codes

The server closes a socket with a WebSocket close code `1008` and sends an
`error` first when:

- `room` is missing or invalid,
- the API key is wrong or missing while auth is required,
- the room token does not match,
- the room is full (`MAX_CLIENTS_PER_ROOM`).

Rate limits, oversized files and per-room storage limits are reported as
`error` messages **without** closing the connection.

## HTTP endpoints

| path | purpose |
| --- | --- |
| `GET /health` | JSON status: version, uptime, rooms, users, memory. |
| `GET /rooms` | JSON list of rooms with user/file counts. |
| `GET /metrics` | Prometheus-style text metrics. |
| `GET /plugin/<manifest.json\|main.js\|styles.css>` | Optional plugin-file hosting (set `PLUGIN_DIR`). |

## Version history

Only the *previous* copy of a changed file is pushed into history - that is why
the first update to a file creates no version (there is nothing older to keep).
History is bounded by `MAX_HIST`, `HIST_MAX_BYTES` and `HIST_TOTAL_BYTES`.
