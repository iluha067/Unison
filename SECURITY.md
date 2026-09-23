# Security

Unison moves the contents of a vault between machines. Treat the server as
untrusted infrastructure and lock it down accordingly.

## Threat model

- Anyone who can reach the WebSocket port **and knows the API key + room** can
  read, modify and delete every file in that room.
- Anyone who can reach `GET /plugin/*` can download the plugin files (only
  relevant if `PLUGIN_DIR` is set).
- The server keeps plaintext copies of every file under `DATA_DIR`.

## Hardening checklist

- [ ] Set a long random `API_KEY` (32+ bytes) and pass it to every client.
- [ ] Optionally set `ROOM_TOKEN` as a second factor.
- [ ] Run behind TLS (`wss://`) - otherwise keys travel in clear text.
- [ ] Bind to `127.0.0.1` and reverse-proxy, or firewall the port to known IPs.
- [ ] Run the service as an unprivileged user (the provided unit uses `unison`).
- [ ] Keep `CORS_ORIGINS` empty unless you host plugin files for browsers.
- [ ] Back up `DATA_DIR`, then protect it like the vault itself.
- [ ] Use a read-only, repo-scoped GitHub token for private self-updates.

## What the server protects against

- **Path traversal** - `.` / `..` segments, absolute paths, leading slashes and
  `.trash/` are rejected; every resolved path must stay inside the room folder.
- **Oversized payloads** - per-file limit, room storage limit, WebSocket
  `maxPayload`.
- **Floods** - per-client token bucket for file updates and for all messages.
- **Slow clients** - frames are dropped once `bufferedAmount` is too high.
- **Ghost clients** - ping/pong keepalive terminates dead sockets.
- **Timing attacks on secrets** - `API_KEY` / `ROOM_TOKEN` are compared with
  `crypto.timingSafeEqual`.

## What it does *not* protect against

- **No encryption at rest** beyond the OS/filesystem - files are stored as-is.
- **No end-to-end encryption** - the server can read everything.
- **No per-file access control** - access is per room, all-or-nothing.
- **No RBAC** - every authenticated client can delete files.

If you need E2E or fine-grained permissions, run the server only on a trusted
network and treat the API key as the single credential.

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer
listed in `plugin/manifest.json`.
