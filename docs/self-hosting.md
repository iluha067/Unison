# Self-hosting the server

The server is a single Node.js file with one dependency (`ws`). It stores every
room's files under `DATA_DIR` and serves them as the source of truth.

## Requirements

- Node.js 18 or newer
- ~50 MB RAM for the process, plus the size of the room contents kept in memory
- An open TCP port (3000 by default), ideally behind a TLS-terminating proxy

## Quick start

```bash
cd server
npm install --production

API_KEY="$(head -c32 /dev/urandom | base64)" \
PORT=3000 \
DATA_DIR=/opt/unison/data \
node server.js
```

Set the same `API_KEY` in the plugin's **API key** field.

## Configuration

All configuration is environment variables (see `server/.env.example`).

| variable | default | meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. Use `127.0.0.1` behind a proxy. |
| `API_KEY` | _(empty)_ | Shared access key. When set, every client must send it. |
| `REQUIRE_AUTH` | `false` | Reject all clients unless a valid `API_KEY` is presented. |
| `ROOM_TOKEN` | _(empty)_ | Optional second factor, shared per room. |
| `DATA_DIR` | `./data` | Persistence directory. |
| `PLUGIN_DIR` | `./plugin` | Directory served at `GET /plugin/<file>` (optional). |
| `CORS_ORIGINS` | _(empty)_ | Comma list allowed for `/plugin/*`; `*` = any. Empty = no CORS header. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug`. |
| `MAX_FILE_BYTES` | `8388608` | Max size of a single file. |
| `MAX_ROOM_BYTES` | `536870912` | Max total bytes held per room. |
| `MAX_CLIENTS_PER_ROOM` | `64` | Connection cap per room. |
| `MAX_HIST` | `20` | Versions kept per file. |
| `HIST_MAX_BYTES` | `262144` | Largest version stored in history. |
| `HIST_TOTAL_BYTES` | `524288` | Total history budget per file. |
| `RATE_BURST` / `RATE_REFILL_PER_SEC` | `300` / `40` | Per-client token bucket. |
| `IDLE_UNLOAD_MS` | `1800000` | Drop an empty room from RAM after this time (files stay on disk). |

## systemd

A ready unit is provided at `server/unison.service`:

```bash
sudo useradd --system --home /opt/unison --shell /usr/sbin/nologin unison
sudo mkdir -p /opt/unison && sudo chown unison:unison /opt/unison
# copy server.js, package.json, node_modules and unison.service here, then:
cd /opt/unison && npm install --production
sudo cp unison.service /etc/systemd/system/unison.service
sudo systemctl daemon-reload
sudo systemctl enable --now unison
journalctl -u unison -f
```

Put the real `API_KEY` in `/etc/systemd/system/unison.service.d/override.conf`
rather than committing it.

## TLS / reverse proxy

WebSocket needs upgrade headers forwarded. With Caddy:

```
sync.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

With nginx:

```
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

Then use `wss://sync.example.com` in the plugin. If you bind the server to
`127.0.0.1`, it is unreachable except through the proxy.

## Operations

- **Health**: `curl https://sync.example.com/health`
- **Metrics**: `curl https://sync.example.com/metrics`
- **Backups**: snapshot `DATA_DIR` — it holds the plain files and `.history/`.
- **Upgrades**: replace `server.js`, `npm install`, restart. In-memory state is
  rebuilt from disk on first join per room.
