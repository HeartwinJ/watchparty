# Deploying WatchParty

One `compose.yaml` runs the whole stack on a VPS that already has Docker:

| Service       | What it does                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `app`         | WatchParty (`ghcr.io/heartwinj/watchparty`): API, Socket.IO and the built client on `:8080`, SQLite in `./data`   |
| `cloudflared` | Cloudflare Tunnel. Dials out to Cloudflare and forwards your hostname to `http://app:8080`. Provides HTTPS        |
| `backup`      | Nightly consistent SQLite backup into `./data/backups`, keeping the last 7 (built locally from `backup/`, ~12 MB) |

**No ports are published on the host.** The stack has its own private network (`watchparty_watchparty`), so it doesn't touch your other services. WebRTC media (screen/file share) goes peer-to-peer, or through Cloudflare's TURN relay when P2P fails, so no UDP ports are needed either.

## 1. Get the files onto the VPS

You need `compose.yaml`, `backup/` and a `.env`. The easiest way is to clone the repo:

```bash
git clone https://github.com/HeartwinJ/watchparty.git && cd watchparty
cp .env.example .env
chmod 600 .env
# The app runs as uid 1000 inside the container and must be able to write ./data
mkdir -p data && sudo chown 1000:1000 data
```

## 2. Create the Cloudflare Tunnel

1. In the Cloudflare dashboard open **Zero Trust → Networks → Tunnels** and click **Create a tunnel**.
2. Choose **Cloudflared**, give it a name (e.g. `watchparty`) and save.
3. On the "Install and run connectors" page pick **Docker**. The command shown ends in `--token eyJ...`. Copy only that token into `.env`:
   ```
   TUNNEL_TOKEN=eyJ...
   ```
   (Don't run the command shown; the compose stack runs cloudflared for you.)
4. Next, add a **public hostname** (called "Published application routes" in newer dashboards):
   - Subdomain/domain: e.g. `watch.example.com` (the domain must be on your Cloudflare account)
   - Service type: **HTTP**, URL: **`app:8080`** (i.e. `http://app:8080`, the compose service name)
5. Save. WebSockets are enabled by default on Cloudflare (Network → WebSockets for the zone); Socket.IO needs them, so leave that on.

## 3. Create the TURN key (screen/file share across strict networks)

Screen and file share are peer-to-peer WebRTC. Between some networks (mobile carriers, corporate NAT) P2P fails and traffic has to be relayed. Cloudflare Realtime TURN does that for free within its limits (check Cloudflare's pricing page).

1. In the Cloudflare dashboard (account level, not Zero Trust) open **Realtime → TURN Server** and click **Create** (name it e.g. `watchparty`).
2. Cloudflare shows a **Turn Token ID** and an **API Token** once. Put them in `.env`:
   ```
   CF_TURN_KEY_ID=<Turn Token ID>
   CF_TURN_API_TOKEN=<API Token>
   ```

The API token stays on the server. Browsers only get short-lived credentials from `GET /iceServers`. If you skip this step, screen share still works when P2P succeeds (STUN only).

## 4. Fill in the rest of `.env`

```bash
# Generate a session secret (keeps logins valid across restarts)
openssl rand -hex 32
```

```
APP_PASSWORD=<the password your friends will type>
SESSION_SECRET=<output of openssl rand -hex 32>
TUNNEL_TOKEN=eyJ...
CF_TURN_KEY_ID=...
CF_TURN_API_TOKEN=...
# Optional
YOUTUBE_API_KEY=...
OPENSUBTITLES_KEY=...
AIOSTREAMS_MANIFEST_URL=...   # contains credentials, keep .env private
SUBTITLE_LANGS=en              # subtitle languages for AIOStreams titles
```

`.env` is read by compose (for `TUNNEL_TOKEN`) and passed to the app. Never commit it.

## 5. Log in to GHCR (only while the package is private)

GitHub Container Registry packages are **private by default**. Either:

- make it public once: GitHub → your profile → **Packages → watchparty → Package settings → Change visibility → Public** (the image contains no secrets), or
- log the VPS in with a personal access token (classic) that has only the **`read:packages`** scope:
  ```bash
  echo <PAT> | docker login ghcr.io -u HeartwinJ --password-stdin
  ```

The image is published by `.github/workflows/docker.yml` on every push to `master` (`latest` and the short commit SHA, for amd64 and arm64).

## 6. Start it

```bash
docker compose pull
docker compose up -d
docker compose ps        # app should become "healthy", then cloudflared starts
```

Open `https://watch.example.com` and log in with `APP_PASSWORD`.

To build the image on the VPS instead of pulling it: `docker compose up -d --build`.

## Updating

```bash
git pull                 # only needed when compose.yaml/backup/ changed
docker compose pull
docker compose up -d
docker image prune -f    # optional: drop old image layers
```

`up -d` recreates the app container. It gets SIGTERM, saves every room to SQLite and exits; rooms come back on start. To pin a version, replace `latest` in `compose.yaml` with a short SHA tag.

## Logs

```bash
docker compose logs -f app
docker compose logs --tail 100 cloudflared
docker compose logs backup
```

Logs use the `json-file` driver capped at 3 × 10 MB per container.

## Backups and restore

The `backup` service uses `sqlite3 .backup` (SQLite's online backup API), which takes a consistent snapshot while the app keeps writing (WAL mode). It runs right away if the newest backup is missing or more than a day old, then every night at 03:00 UTC (`BACKUP_HOUR` in `compose.yaml`), verifies each copy with `PRAGMA integrity_check` and keeps the newest 7 (`BACKUP_KEEP`) as `data/backups/watchparty-YYYYMMDD-HHMMSS.db`.

Take one now: `docker compose exec backup backup.sh once`

For off-site copies, sync `data/backups/` with whatever you already use (restic, rclone, ...).

**Restore:**

```bash
docker compose stop app backup
cp data/backups/watchparty-YYYYMMDD-HHMMSS.db data/watchparty.db
rm -f data/watchparty.db-wal data/watchparty.db-shm   # leftovers belong to the old file
sudo chown 1000:1000 data/watchparty.db
docker compose start app backup
```

## Resource expectations

Measured with `docker stats` (cgroup memory) on the stack itself:

| Service       | Memory                                          | Limit  |
| ------------- | ----------------------------------------------- | ------ |
| `app`         | ~27 MB idle, ~28 MB with a room and two clients | 256 MB |
| `cloudflared` | typically 20–40 MB                              | 128 MB |
| `backup`      | < 1 MB (sleeps between runs)                    | 32 MB  |

The node process's RSS reads higher (~85 MB) because it counts ~60 MB of the node binary that is mapped from disk; that's shared page cache, not private memory. The app image is ~140 MB (Alpine + stripped node binary + prod deps). CPU is negligible when idle. Video normally goes straight from its source to each browser; only HLS streams played through the `/proxy` route pass through the server.

## Troubleshooting

- **Login doesn't stick / you keep getting the password form:** always use the `https://` hostname from the tunnel. The app marks the session cookie `Secure` when the request arrived over HTTPS (it trusts cloudflared's `X-Forwarded-Proto` because cloudflared connects from a private address; see `TRUST_PROXY` in `server/config.ts` if you put another proxy in front). Screen/file share also need HTTPS (a secure context). And set `SESSION_SECRET`, otherwise every restart logs everyone out.
- **Screen share connects for some people but not others:** that's a strict NAT. Set `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` (step 3). `curl` the app's `/iceServers` while logged in to check it returns `turn:` URLs.
- **`cloudflared` keeps restarting with "Provided Tunnel token is not valid":** recheck `TUNNEL_TOKEN` (no quotes, no `--token` prefix).
- **Cloudflare shows 502 / "Bad gateway":** the public hostname must point at `http://app:8080` (not `localhost`), and `docker compose ps` should show `app` as healthy.
- **App exits with "unable to open database file":** `./data` isn't writable by uid 1000: `sudo chown -R 1000:1000 data`. On SELinux hosts (Fedora/RHEL) also append `:z` to both `./data` volume entries in `compose.yaml`.
- **The page loads but rooms never connect:** the client uses WebSocket transport only, so check that WebSockets are on under the zone's **Network** settings.
