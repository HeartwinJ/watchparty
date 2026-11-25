# Personal WatchParty: Modernization Plan

Status: **draft for review** (2026-11-26)

## Goals

1. **Lean:** one small container. Target **< 60 MB idle RSS** (today about 120 MB) and **< 2 MB** of client JS on the initial room load (today about 12 MB in `build/`).
2. **Current stack:** latest majors across the board, and `npm audit` shows 0 high/critical issues.
3. **Personal:** no subscriptions, accounts, Discord, analytics, marketing pages or cloud-VM features.
4. **Full UI redesign:** theater-first room layout that works well on mobile.
5. **One `docker compose up -d`:** app, TURN relay and cloudflared all in one stack.

## Decisions (from brainstorm)

| Topic             | Decision                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Hosting           | Existing VPS (shared with other Docker services). Single compose file, cloudflared included      |
| Features kept     | YouTube; direct video URLs; HLS (.m3u8); screen share; file share (incl. in-browser transcoding) |
| Features removed  | Virtual browser (neko/VMs), video chat, WebTorrent/magnet links, mediasoup SFU                   |
| Auth              | One instance password (env var) instead of Firebase                                              |
| UI                | Full redesign, with mockups reviewed before implementation                                       |
| TURN relay        | Hosted free tier (Cloudflare Realtime TURN). No UDP ports opened on the VPS                      |
| Router            | Implementer's choice (leaning toward a tiny hand-rolled router; there are ~3 routes)             |
| Personal features | Better fullscreen, subtitle offset, AIOStreams in the search bar (Phase 6)                       |

## Target architecture

```
                 Cloudflare edge (TLS)
                        │  HTTPS + WebSocket
┌───────────────── compose stack ────────────────────┐
│  cloudflared ──► app (node:24-alpine, :8080)       │
│                  ├ Express + Socket.IO             │
│                  ├ serves built React client       │
│                  ├ SQLite file in ./data volume    │
│                  └ server-side calls ──────────────┼──► AIOStreams (your instance)
└────────────────────────────────────────────────────┘    Cinemeta (title search)
                                                           Cloudflare TURN API (credentials)
  WebRTC media (screen/file share): peer-to-peer, or relayed through
  Cloudflare TURN when P2P fails. No inbound ports open on the VPS.
```

- **No Postgres or Redis containers.** Persistence moves to `node:sqlite`, which is built into Node 24 with no extra dependency. It stores rooms, room settings and saved playlists. Redis was only used for metrics and session spoof protection, which the in-memory version handles fine for a personal instance.
- **Single process, no sharding, no pm2.** Delete `ecosystem.config.js`, `resolveShard.ts`, `vmWorker.ts`, `syncSubs.ts`, `timeSeries.ts`, `cleanup.ts` and `discordBot.ts`.
- **TURN:** screen and file share use P2P WebRTC with relay servers hardcoded to _upstream's_ machines (`src/utils/utils.ts` `iceServers`). Cloudflare Tunnel can't carry UDP, so the relay is **Cloudflare Realtime TURN** (free tier; check current limits on Cloudflare's pricing page). A server endpoint (`GET /iceServers`, behind the password session) uses `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` to request short-lived credentials from Cloudflare's API and returns them to the client. Credentials are cached until shortly before they expire. If they aren't configured, it falls back to STUN only.

## Phases

Each phase ends with a green `npm run build` and a manual smoke test. Each is one commit, or a small PR, on a `personal` branch.

### Phase 0: Baseline & guardrails

- Create the `personal` branch. Turn off the upstream CI auto-push to `release` and the `deploy` script, and change dependabot to grouped monthly updates.
- Record baseline numbers: idle RSS, bundle sizes, build time.
- Add a minimal **Vitest** setup with a couple of server tests (room state sync, password gate). There are no tests today, and the refactors below need a safety net.

### Phase 1: Strip removed features (biggest win, lowest risk)

- **Server:** remove Stripe, Firebase admin, the Discord bot, the VM providers, the stats/timeSeries/health endpoints, `linkAccount`, the subscriber checks and room limits, `listRooms`/`deleteRoom` ownership logic, mediasoup and torrent handling. Shrink `config.ts` to the handful of vars still used.
- **Client:** remove SubscribeButton/SubscribeModal, LoginModal, ProfileModal, VBrowser and VBrowserModal, VideoChat and ChatVideoCard, the Discord page, Debug, the Privacy/Terms/FAQ pages, Announce, PermanentRoomModal, `isSub` gating and the WebTorrent/mediasoup paths in `App.tsx`.
- **Deps removed:** `stripe`, `firebase`, `firebase-admin`, `discord.js`, `node-ssh`, `pm2`, `pg`, `ioredis`, `webtorrent`, `mediasoup-client`, `recharts`, `react-countup`, `@googleapis/youtube` (replaced with ~30 lines of `fetch` against the YouTube Data API).
- This also clears most of the `npm audit` findings, which come from the firebase-admin → grpc/protobuf chain.

### Phase 2: Simplify server & persistence

- Instance password: `APP_PASSWORD` env var, checked on login. The server issues a signed, httpOnly session cookie, and both HTTP routes and the Socket.IO handshake require it. Optional per-room passwords stay as they are.
- Replace Postgres with `node:sqlite`. Rewrite `saveRoom`/`deserialize`/the room loader against one `rooms` table. Rooms are permanent by default. Add an optional "My rooms" list.
- Clean up the `/proxy` route (keep the SSRF guard) and the subtitle endpoints. Replace in-memory LRU caps where Redis was used.
- `GET /iceServers`: server-side endpoint that issues short-lived Cloudflare TURN credentials.
- Graceful shutdown, so rooms are saved on SIGTERM (container restarts).

### Phase 3: Upgrade the stack

Done after Phase 1, so there's less code to migrate:

- React 18 → **19**, react-router 5 → **7** (or a tiny custom router, since there are only ~3 routes), Mantine 8 → **9**, Vite 7 → **8**, latest hls.js, dashjs (lazy), mediabunny, socket.io, express, and `@types/*`.
- Split `App.tsx` (2.8k-line class component) into hooks: `useRoomSocket`, `usePlayer`, `useScreenShare`, `useFileShare`, `useChat`, plus presentational components. This is the main enabler for the redesign.
- Code-split: hls/dash/mediabunny/AC3 load only when needed (mostly done already; verify), and emoji-mart loads lazily.

### Phase 4: UI redesign

**Step 1: mockups.** Produce clickable HTML mockups of Home, Room (desktop and mobile), the source picker (incl. AIOStreams results) and fullscreen mode, for review. Implementation starts only after sign-off.

Working concept:

- **Home:** one screen with a big "Start a room" button, recent rooms, and paste-a-link to start instantly.
- **Room (desktop):** the video fills the viewport (theater-first). A **collapsible right sidebar** has tabs for Chat, Queue (playlist) and People. The top bar holds the room name, the invite/copy-link button and the source picker.
- **Room (mobile):** video on top, with the sidebar as a bottom sheet below it.
- **Source picker:** one command-palette-style input. Paste a URL (YouTube/HLS/MP4), search YouTube, or pick "Share screen" / "Share file". This replaces the current combo box plus several modals.
- **Player controls:** custom overlay controls that auto-hide, show buffered ranges, and include speed, subtitles and loop.
- **Theme:** dark by default, one accent color, Mantine 9 theme tokens.
- **Polish:** sync status indicator ("in sync / you're 2s behind"), toast notifications instead of modals, keyboard shortcuts (space, ←/→, f, c).

### Phase 5: Packaging & deployment

- **Multi-stage Dockerfile:** build stage (full deps + vite) → runtime stage `node:24-alpine` with only prod deps (≈ express, socket.io, compression), `build/` and `server/`. It runs as a non-root user and has a healthcheck on `/ping`. Target image under 150 MB.
- **`compose.yaml`:**
  - `app`: no published ports (only cloudflared reaches it), `./data:/app/data`, memory limit around 256 MB, `NODE_OPTIONS=--max-old-space-size=128`, `restart: unless-stopped`.
  - `cloudflared`: `cloudflare/cloudflared` with `tunnel run`, `TUNNEL_TOKEN` from `.env`, ingress → `http://app:8080`.
  - A dedicated network, so it doesn't collide with your other services. **No published ports at all.**
- `.env.example` covers only `APP_PASSWORD`, `SESSION_SECRET`, `TUNNEL_TOKEN`, `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`, `AIOSTREAMS_MANIFEST_URL`, `YOUTUBE_API_KEY` (optional) and `OPENSUBTITLES_KEY` (optional).
- A short `DEPLOY.md`: Cloudflare tunnel setup (public hostname → `http://app:8080`, WebSockets on), creating the TURN key in the Cloudflare dashboard, backup = copy `./data`.
- Optional: a GitHub Action that builds and pushes an image to GHCR, so the VPS only does `docker compose pull && up -d`.

### Phase 6: Personal features

Fullscreen and subtitles are built _with_ the Phase 4 player rather than after it. AIOStreams follows once the new source picker exists.

#### 6a. Fullscreen experience (requested)

- Fullscreen the **player container** (video + overlay controls + optional chat overlay), not the bare `<video>`. The custom controls and chat then still work in fullscreen, and it behaves the same for YouTube and HTML5 sources.
- Overlay controls: play/pause, seek bar with buffered ranges and hover time preview, volume, speed, subtitles menu (incl. offset), loop, PiP, exit fullscreen.
- **Auto-hide** controls _and cursor_ (`cursor: none`) after ~2.5s without mouse movement. They reappear on mouse move, tap or key press, and stay visible while paused or hovering the controls.
- Chat in fullscreen: incoming messages fade in as a translucent overlay. Press `c` to open a compact input without leaving fullscreen.
- Keyboard: space/k play, ←/→ ±10s, ↑/↓ volume, f fullscreen, m mute, c chat, `[`/`]` subtitle offset. Double-click toggles fullscreen.
- Mobile: tap toggles controls, double-tap left/right seeks, and the screen locks to landscape when entering fullscreen where the browser supports it.

#### 6b. Subtitle offset (requested)

- Shift all cues by ±N seconds (0.1s steps, `[`/`]` keys, plus a slider and a reset button in the subtitles menu). It's applied client-side by re-timing the `TextTrack` cues, so no re-download is needed.
- **Synced across the room by default** (the offset is a property of the file, so everyone needs the same shift), stored in room state, with a local "override for me only" option.
- Saved per video in SQLite, so the offset comes back the next time the same video loads.
- Also covers subtitle styling (size, background), since it lives in the same menu.

#### 6c. AIOStreams in the search bar (requested)

The personal manifest URL contains your config/credentials, so it lives **only** in the server env (`AIOSTREAMS_MANIFEST_URL`, already in local `.env`) and is never sent to the browser, logged or committed.

What the configured manifest provides (probed 2026-11-26): `stream` only, for `movie`/`series`/`anime`, id prefixes `tt` and `kitsu`. It has **no catalogs** and no subtitles. A movie lookup returned 200 streams, all with `url` (debrid playback links already proxied by AIOStreams), sorted 4K REMUX first: ~90 GB, HEVC, DTS-HD, MKV. Codec info only appears in the free-text `description` and `behaviorHints.filename`.

- **Flow:** type a title → server searches **Cinemeta** (`v3-cinemeta.strem.io`, keyless) for movies/series and the **Kitsu addon** for anime → pick a movie, or series → season → episode → server calls `{base}/stream/{type}/{id}.json` → the stream list is shown → pick one → it plays as a normal URL for the whole room.
- **Stream ranking:** parse `filename`/`description` for resolution, size, video codec (H.264/HEVC/AV1), audio (AAC/AC3/EAC3/DTS/TrueHD), container and REMUX. Show compact badges, and sort a "likely browser-playable" group first (H.264/AV1 + AAC/Opus/AC3/EAC3, ≤ ~20 GB). Show the rest collapsed under "May not play in browser".
- **Recommended:** create a **separate AIOStreams config for WatchParty** that prefers 1080p WEB-DL, H.264/AV1, excludes REMUX/DTS/TrueHD/DV-only and caps size, then use that URL here. The Stremio config stays untouched. This does most of the filtering upstream and keeps responses small.
- **Speed:** stream lookups took several seconds and returned ~200 results. The server caches them (~10 min per id) and trims what it sends to the client.
- **Server routes** (behind the password session): `GET /addon/search?q=`, `GET /addon/meta/:type/:id`, `GET /addon/streams/:type/:id`. Results are cached briefly in memory.
- **Playback compatibility:** debrid results are often MKV/HEVC/AC3/EAC3, which browsers can't always play. The picker shows a "browser-friendly" badge (MP4/WebM, H.264/AV1/VP9, AAC/Opus), and those are sorted first. Use AIOStreams' own filters/sorting to prefer them too.
- **IP-locked links:** not an issue. Your AIOStreams already proxies playback, so the app never proxies video.
- Torrent-only results (`infoHash` with no URL) are hidden, since WebTorrent is removed.
- Room state stores the IMDb id and episode, so the stream can be re-resolved if a debrid link expires mid-session.

#### 6d. Accepted recommendations (in scope)

- [ ] **Next episode:** when an AIOStreams episode ends, offer "Next episode in 10s" (cancelable) for the whole room. It re-resolves streams for `s:e+1`, preferring the same `bingeGroup` so quality and source stay consistent.
- [ ] **Auto subtitles for AIOStreams titles:** a Stremio subtitle addon (OpenSubtitles v3, keyless, by IMDb id/episode) fills the subtitle menu automatically, with the offset from 6b applied.
- [ ] **Smoother sync:** fix drift under ~2s by briefly nudging `playbackRate` (0.95–1.05x) and hard-seek only beyond that. A sync indicator shows in the controls.
- [ ] **Ready check:** optional room toggle. When anyone buffers or joins mid-play, the room auto-pauses until all viewers report enough buffer, then resumes.
- [ ] **Continue watching / history:** per-room list of recent titles (AIOStreams metadata + poster) with resume position, stored in SQLite.
- [ ] **Nightly SQLite backup:** `sqlite3 .backup` via a tiny sidecar in the compose stack, keeping the last 7 copies in `./data/backups`.

Not in scope: PWA install / share target.

## Upstream relationship

After Phase 1 this fork diverges heavily, so merging upstream regularly won't be practical. Instead, cherry-pick specific upstream fixes (e.g. player/sync bugs) when they're relevant (`git log upstream/master`).

## Open questions

None blocking. Optional: create the WatchParty-specific AIOStreams config (see 6c) and replace `AIOSTREAMS_MANIFEST_URL` in `.env`.
