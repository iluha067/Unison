# Unison server

WebSocket sync hub for the [Unison](../) Obsidian plugin. A single Node.js file
with **zero dependencies** (it ships its own minimal WebSocket implementation).
See [`../docs/server-setup.md`](../docs/server-setup.md) for full deployment
instructions and [`../docs/protocol.md`](../docs/protocol.md) for the wire format.

```bash
API_KEY="your-long-random-key" PORT=3000 DATA_DIR=./data node server.js
```

## Files

| file | purpose |
| --- | --- |
| `server.js` | the server (exports `createServer()` for tests) |
| `package.json` | metadata + `npm test` |
| `unison.service` | systemd unit |
| `.env.example` | every environment variable with defaults |
| `test/server.test.js` | integration tests (`node --test`) |

## Endpoints

- `GET /health` - JSON status
- `GET /rooms` - rooms with user/file counts
- `GET /metrics` - Prometheus-style metrics
- `GET /plugin/<file>` - optional plugin-file hosting (`PLUGIN_DIR`)

## Tests

```bash
npm install
npm test
```
