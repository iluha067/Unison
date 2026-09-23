# Server setup from scratch

This walks through deploying the Unison server on a **brand-new** server, from
an empty machine to a working `wss://` endpoint. Commands assume Ubuntu 22.04 /
24.04 or Debian 12 and a fresh SSH session as `root`. If you use `sudo`, prefix
the privileged commands with it.

By the end you will have:

- Node.js 20 installed
- a dedicated `unison` system user
- `/opt/unison` containing `server.js`, `node_modules` and `plugin/`
- a systemd service `unison` listening on port 3000
- (optional) TLS in front of it via Caddy

---

## 1. Connect and update the system

```bash
ssh root@YOUR_SERVER_IP

apt update && apt upgrade -y
apt install -y curl git ufw
```

## 2. Install Node.js 20

The version in the distro repos is often too old, so use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

node -v   # should print v20.x or newer
npm -v
```

## 3. Firewall

Allow SSH first, so you do not lock yourself out, then the sync port:

```bash
ufw allow OpenSSH
ufw allow 3000/tcp
ufw --force enable
ufw status
```

If you plan to put TLS in front (step 11), allow `443/tcp` instead of `3000`
and do not expose 3000 publicly.

## 4. Create the service user and directories

Running as a dedicated, unprivileged user keeps the vault data away from root:

```bash
useradd --system --home /opt/unison --shell /usr/sbin/nologin unison
mkdir -p /opt/unison/data
mkdir -p /opt/unison/plugin
```

## 5. Get the server files

### Option A: clone the repository (public)

```bash
git clone --depth 1 https://github.com/iluha067/Unison.git /tmp/unison

# server
cp /tmp/unison/server/server.js \
   /tmp/unison/server/package.json \
   /tmp/unison/server/package-lock.json \
   /opt/unison/

# optional: let the server host the plugin files at /plugin/<file>
cp /tmp/unison/manifest.json /tmp/unison/main.js /tmp/unison/styles.css /opt/unison/plugin/

rm -rf /tmp/unison
```

### Option B: copy from your computer

```bash
# run this on your computer, not the server
scp server/server.js server/package.json server/package-lock.json \
    root@YOUR_SERVER_IP:/opt/unison/
scp manifest.json main.js styles.css \
    root@YOUR_SERVER_IP:/opt/unison/plugin/
```

## 6. Install dependencies

```bash
cd /opt/unison
npm install --omit=dev
```

## 7. Generate an access key

The API key is the single shared secret every client must present. Generate a
long random one and keep it somewhere safe:

```bash
API_KEY="$(head -c32 /dev/urandom | base64)"
echo "API_KEY=$API_KEY"
```

Optionally set a second factor shared per room:

```bash
ROOM_TOKEN="$(head -c16 /dev/urandom | base64)"
echo "ROOM_TOKEN=$ROOM_TOKEN"
```

## 8. Write the environment file

Keeping secrets out of the unit file means you can share the unit safely:

```bash
cat > /etc/unison.env <<EOF
API_KEY=$API_KEY
ROOM_TOKEN=$ROOM_TOKEN
PORT=3000
HOST=0.0.0.0
DATA_DIR=/opt/unison/data
PLUGIN_DIR=/opt/unison/plugin
LOG_LEVEL=info
EOF

chmod 600 /etc/unison.env
```

Leave `ROOM_TOKEN` out of the file if you do not want the second factor.

## 9. Create the systemd service

```bash
cat > /etc/systemd/system/unison.service <<'EOF'
[Unit]
Description=Unison sync server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/unison
ExecStart=/usr/bin/node /opt/unison/server.js
Restart=always
RestartSec=3
EnvironmentFile=/etc/unison.env
User=unison
Group=unison
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/unison/data

[Install]
WantedBy=multi-user.target
EOF

chown -R unison:unison /opt/unison
systemctl daemon-reload
systemctl enable --now unison
```

## 10. Verify

```bash
systemctl status unison --no-pager

curl -s http://127.0.0.1:3000/health
# {"ok":true,"service":"unison","version":"3.0.0","authRequired":true,...}

journalctl -u unison -n 20 --no-pager
```

From another machine you can check the public endpoint:

```bash
curl -s http://YOUR_SERVER_IP:3000/health
```

If that fails, recheck the firewall (`ufw status`) and whether your hosting
provider has its own firewall in the control panel.

## 11. (Optional but recommended) TLS with Caddy

With a domain pointed at the server, Caddy gets a certificate automatically:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Create `/etc/caddy/Caddyfile`:

```
sync.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then reload and switch to `wss://` in the plugin:

```bash
systemctl reload caddy
ufw allow 443/tcp
# now bind the server to localhost only:
sed -i 's/^HOST=.*/HOST=127.0.0.1/' /etc/unison.env
systemctl restart unison
```

## 12. Point the plugin at the server

In Obsidian: **Settings -> Unison**.

| field | value |
| --- | --- |
| Server | `wss://sync.example.com` (or `ws://YOUR_SERVER_IP:3000` without TLS) |
| API key | the value of `API_KEY` from step 7 |
| Room | any shared name, e.g. `team` |

Everyone who joins must use the same server, API key and room. If you set
`ROOM_TOKEN`, they must enter that too.

## 13. Updating the server

```bash
git clone --depth 1 https://github.com/iluha067/Unison.git /tmp/unison
cp /tmp/unison/server/server.js /opt/unison/server.js
cd /opt/unison && npm install --omit=dev
chown -R unison:unison /opt/unison
systemctl restart unison
rm -rf /tmp/unison
```

## 14. Backups and logs

Everything lives in `DATA_DIR` (`/opt/unison/data`), including `.history`:

```bash
tar czf /root/unison-$(date +%F).tar.gz -C /opt/unison data

journalctl -u unison -f          # follow logs
```

## Troubleshooting

| symptom | likely cause |
| --- | --- |
| `curl` to `/health` fails from outside | firewall or provider security group |
| plugin says "invalid API key" | `API_KEY` mismatch between server and plugin |
| plugin says "invalid token" | `ROOM_TOKEN` is set but the plugin field is empty or wrong |
| service restarts in a loop | check `journalctl -u unison` (usually a port clash or missing `ws`) |
| `EADDRINUSE` | something else already uses port 3000, change `PORT` | 
