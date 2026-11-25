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

- [x] **Server:** remove Stripe, Firebase admin, the Discord bot, the VM providers, the stats/timeSeries/health endpoints, `linkAccount`, the subscriber checks and room limits, `listRooms`/`deleteRoom` ownership logic, mediasoup and torrent handling. Shrink `config.ts` to the handful of vars still used. Also removed: room owner/lock/vanity URLs/sub-rooms, per-room passwords, video-chat signaling, Twitch URL resolution (it relied on an external proxy), and `dev/` + `sql/`. Server deps removed: `stripe`, `firebase-admin`, `discord.js`, `node-ssh`, `pm2`, `pg`, `@types/pg`, `ioredis`, `@googleapis/youtube`, `twitch-m3u8`.
- [x] **Client:** remove SubscribeButton/SubscribeModal, LoginModal, ProfileModal, UserMenu, VBrowser and VBrowserModal, VideoChat, the Discord page, Debug, the Privacy/Terms/FAQ pages, Footer, Announce, PermanentRoomModal, PasswordModal, MultiStreamModal, `MetadataContext`, `isSub` gating, room owner/lock/vanity/title/media-path settings, shard resolution, the WebTorrent/mediasoup paths in `App.tsx`, and the hardcoded upstream TURN servers (now `GET /iceServers`, STUN fallback). `ChatVideoCard` is kept: despite the name it renders playlist/search items, not video chat. The People panel is now a plain participant list. Added a minimal password login gate (`AuthGate`) and `apiFetch`. Client deps removed: `firebase`, `webtorrent`, `@types/webtorrent`, `mediasoup-client`, `recharts`, `react-countup`, `react-colorful`, `react-onclickoutside`, `@types/react-onclickoutside`, `eventemitter3`. `build/` went from 12 MB to 4.4 MB (main chunk 966 KB → 681 KB).
- **Deps removed:** `stripe`, `firebase`, `firebase-admin`, `discord.js`, `node-ssh`, `pm2`, `pg`, `ioredis`, `webtorrent`, `mediasoup-client`, `recharts`, `react-countup`, `@googleapis/youtube` (replaced with ~30 lines of `fetch` against the YouTube Data API).
- This also clears most of the `npm audit` findings, which come from the firebase-admin → grpc/protobuf chain.

### Phase 2: Simplify server & persistence

- [x] (server) Instance password: `APP_PASSWORD` env var, checked on login. The server issues a signed, httpOnly session cookie, and both HTTP routes and the Socket.IO handshake require it. **Per-room passwords are removed**: the instance password is the only gate.
- [x] (server) Replace Postgres with `node:sqlite`. Rewrite `saveRoom`/`deserialize`/the room loader against one `rooms` table. Rooms are permanent by default. Uploaded subtitles moved from Redis to a `subtitles` table. Still to do: an optional "My rooms" list.
- [x] (server) Clean up the `/proxy` route (keep the SSRF guard) and the subtitle endpoints. clientId session-spoof protection moved from Redis to an in-memory map.
- [x] (server) `GET /iceServers`: server-side endpoint that issues short-lived Cloudflare TURN credentials. The client uses it for screen/file share.
- [x] (server) Graceful shutdown, so rooms are saved on SIGTERM (container restarts).

### Phase 3: Upgrade the stack

Done after Phase 1, so there's less code to migrate:

- [x] (client) React 18 → **19**, Mantine 8 → **9** (8.x look kept until Phase 4), Vite 7 → **8** (Rolldown), latest hls.js, dashjs (lazy), mediabunny, socket.io-client, `@tabler/icons-react`, emoji-mart, `@types/*`. react-router v5 replaced by a ~60-line History API router (`src/router.ts`). Dropped `@emoji-mart/react` (no React 19 support; the picker is now a lazy wrapper around emoji-mart's web component), `react-linkify` + `react-secure-link` (high-severity `linkify-it` advisory; replaced by a small linkifier), `react-router-dom`, and the unused `SearchComponent`/`SearchResult`. `npm audit`: 0 vulnerabilities.
- [x] (client) Split `App.tsx` (1.8k-line class component) into hooks: `useRoom` composing `useRoomSocket`, `usePlayer`, `useConvert`, `useShare` (screen + file share), `useChat`, `usePlaylist`, `useSubtitles`, plus presentational components (`RoomToolbar`, `PlayerArea`, `RoomSidebar`, `RoomMessages`). Pure logic in `components/App/logic/` with unit tests. See `src/components/App/README.md`.
- [x] Code-split: hls/dash/mediabunny/AC3 and emoji-mart load only via dynamic `import()`. Main chunk 681 KB → 655 KB (gzip 218 → 199 KB).
- [ ] (server) express/socket.io server deps (left to the server workstream).

### Phase 4: UI redesign

**Status: done (2026-11-26).** Tokens + copper theme (#11), RoomUi/toasts (#12), shell/home/login (#14), player/fullscreen/subtitle offset/smoother sync (#15), wiring (#16, #18), source picker + AIOStreams + per-viewer auto-convert (#17). Wave 2 (next-episode card, ready check, server-side history, room settings) is next.

**Step 1: mockups.** Done (2026-11-26). The clickable HTML mockups and the design spec live only in the owner's local checkout (`design/`, git-ignored on purpose, never committed). Ask the owner for them if you need the exact tokens.

**Design decisions (signed off 2026-11-26):**

- **Accent: copper** `#C66B3D` (dark) / `#9C4F27` (light). Filled copper buttons use near-black text (`#1B0F08`) in dark mode for contrast.
- Status colours were moved away from copper: warning is **yellow** `#E8CF4A` / `#8A6D00`, error/danger is **rose-red** `#FF5C7A` / `#C8234A`, success is green. The 4K chip is **platinum**, not gold. Avatar colours avoid orange, brown, yellow and rose hues.
- **Dark-only** for now (no light theme shipped). **System font** stack (no bundled Inter).
- Single click on the video = play/pause for everyone, with a toast saying who did it. Double-click = fullscreen.
- **Speed and loop are room-wide.**
- Chat bubbles show over the video when the sidebar is collapsed, as well as in fullscreen, with a setting to turn them off.
- Next-episode card: fixed offset before the end (default 25 s), adjustable in room settings.
- **Resizable sidebar**, width remembered per device.
- Source picker: a custom command palette, not Mantine `Spotlight`, because of the drill-down and poster grid.
- Incompatible streams stay visible: auto-convert where possible (see 6c), otherwise collapsed with "Try anyway".

Working concept:

- **Home:** one screen with a big "Start a room" button, recent rooms, and paste-a-link to start instantly.
- **Room (desktop):** the video fills the viewport (theater-first). A **collapsible right sidebar** has tabs for Chat, Queue (playlist) and People. The top bar holds the room name, the invite/copy-link button and the source picker.
- **Room (mobile):** video on top, with the sidebar as a bottom sheet below it.
- **Source picker:** one command-palette-style input. Paste a URL (YouTube/HLS/MP4), search YouTube, or pick "Share screen" / "Share file". This replaces the current combo box plus several modals.
- **Player controls:** custom overlay controls that auto-hide, show buffered ranges, and include speed, subtitles and loop.
- **Theme:** dark-only, copper accent, Mantine 9 theme tokens (see design decisions above).
- **Polish:** sync status indicator ("in sync / you're 2s behind"), toast notifications instead of modals, keyboard shortcuts (space, ←/→, f, c).

### Phase 5: Packaging & deployment

- [x] **Multi-stage Dockerfile:** build stage (full deps, `vite build`, server compiled to JS with `npm run buildServer` → `dist-server/`) → runtime stage: plain `alpine` + the stripped `node` binary from `node:24-alpine` (the official image alone is ~175 MB), prod deps only, `build/`, `dist-server/`, `words/`. Non-root (uid 1000), tini, healthcheck on `/ping`, `DATA_DIR=/app/data` volume, `NODE_OPTIONS=--max-old-space-size=128 --max-semi-space-size=1`. **Image 140 MB.** Build/deps stages run on `$BUILDPLATFORM`, so arm64 only emulates the tiny runtime stage.
- [x] **Precompile decision (measured 2026-11-26, Node 24, host RSS idle):** `node server/server.ts` 115 MB, `tsc`-emitted JS 87 MB, plus heap flags 83 MB (with the AIOStreams routes from #6). An esbuild single-file bundle only saved ~2 MB more in an earlier run, not worth a new dep. So: `tsc` emit, run plain JS; `npm run dev` keeps running `.ts`. Most of the rest is Node itself (`node:http` alone is +13 MB over a bare 43 MB process) and Express (+7 MB); lazy-loading `compression` saves nothing because Express already loads `mime-db`. `--lite-mode` would save ~10 MB more but disables the optimizing JIT, so it's not on by default. **In the container (`docker stats`): ~27 MB idle, ~28 MB with one room and two clients**; process RSS reads ~85 MB because ~60 MB of it is the node binary mapped from disk (shared page cache).
- [x] **`compose.yaml`:**
  - `app`: built on the host (`build: .`, `pull_policy: build`; GHCR publishing was dropped on 2026-11-26), no published ports, named volume `data` → `/app/data`, `mem_limit: 256m`, `env_file: .env`, healthcheck, `restart: unless-stopped`.
  - `cloudflared`: `cloudflare/cloudflared` (pinned tag), `tunnel --no-autoupdate run`, `TUNNEL_TOKEN` from `.env`, starts once the app is healthy. Ingress (public hostname → `http://app:8080`) is set in the Cloudflare dashboard.
  - `backup`: `backup/` (alpine + sqlite3), `sqlite3 .backup` at startup if stale, then nightly at 03:00 UTC, integrity-checked, keeps 7 in `./data/backups`.
  - Project-scoped network, no published ports, small memory limits on the sidecars, `json-file` log rotation.
- [x] `.env.example` covers `APP_PASSWORD`, `SESSION_SECRET`, `TUNNEL_TOKEN`, `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`, `AIOSTREAMS_MANIFEST_URL`, `YOUTUBE_API_KEY` (optional) and `OPENSUBTITLES_KEY` (optional).
- [x] `DEPLOY.md`: tunnel + public hostname, TURN key, `SESSION_SECRET`, start/update/logs, backups and restore, resource expectations, troubleshooting.
- [x] `.github/workflows/docker.yml`: build-only check (amd64, no push) on PRs and `master`. Image publishing to GHCR was removed on 2026-11-26 in favour of building on the host.

### Phase 6: Personal features

Fullscreen and subtitles are built _with_ the Phase 4 player rather than after it. AIOStreams follows once the new source picker exists.

#### 6a. Fullscreen experience (requested)

- [x] Done with the Phase 4 player (`src/components/App/player/`): container fullscreen, overlay controls, auto-hide controls + cursor, chat bubbles + `c` quick chat, keyboard, double-click, phone gestures and landscape lock.

- Fullscreen the **player container** (video + overlay controls + optional chat overlay), not the bare `<video>`. The custom controls and chat then still work in fullscreen, and it behaves the same for YouTube and HTML5 sources.
- Overlay controls: play/pause, seek bar with buffered ranges and hover time preview, volume, speed, subtitles menu (incl. offset), loop, PiP, exit fullscreen.
- **Auto-hide** controls _and cursor_ (`cursor: none`) after ~2.5s without mouse movement. They reappear on mouse move, tap or key press, and stay visible while paused or hovering the controls.
- Chat in fullscreen: incoming messages fade in as a translucent overlay. Press `c` to open a compact input without leaving fullscreen.
- Keyboard: space/k play, ←/→ ±10s, ↑/↓ volume, f fullscreen, m mute, c chat, `[`/`]` subtitle offset. Double-click toggles fullscreen.
- Mobile: tap toggles controls, double-tap left/right seeks, and the screen locks to landscape when entering fullscreen where the browser supports it.

#### 6b. Subtitle offset (requested)

- [x] Done: cue re-timing (`logic/subtitles.ts`), `CMD:subtitleOffset` → `REC:subtitleOffset`, `subtitle_offsets` table (keyed by a URL hash for now; TODO: IMDb id + episode once the room stores AIOStreams metadata), "Just me" override, size/background per device.

- Shift all cues by ±N seconds (0.1s steps, `[`/`]` keys, plus a slider and a reset button in the subtitles menu). It's applied client-side by re-timing the `TextTrack` cues, so no re-download is needed.
- **Synced across the room by default** (the offset is a property of the file, so everyone needs the same shift), stored in room state, with a local "override for me only" option.
- Saved per video in SQLite, so the offset comes back the next time the same video loads.
- Also covers subtitle styling (size, background), since it lives in the same menu.

#### 6c. AIOStreams in the search bar (requested)

The personal manifest URL contains your config/credentials, so it lives **only** in the server env (`AIOSTREAMS_MANIFEST_URL`, already in local `.env`) and is never sent to the browser, logged or committed.

What the configured manifest provides (probed 2026-11-26): `stream` only, for `movie`/`series`/`anime`, id prefixes `tt` and `kitsu`. It has **no catalogs** and no subtitles. A movie lookup returned 200 streams, all with `url` (debrid playback links already proxied by AIOStreams), sorted 4K REMUX first: ~90 GB, HEVC, DTS-HD, MKV. Codec info only appears in the free-text `description` and `behaviorHints.filename`.

- **Flow:** type a title → server searches **Cinemeta** (`v3-cinemeta.strem.io`, keyless) for movies/series and the **Kitsu addon** for anime → pick a movie, or series → season → episode → server calls `{base}/stream/{type}/{id}.json` → the stream list is shown → pick one → it plays as a normal URL for the whole room.
- **Stream ranking:** parse `filename`/`description` for resolution, size, video codec (H.264/HEVC/AV1), audio tracks (AAC/AC3/EAC3/DTS/TrueHD; descriptions often list several, e.g. "DD | DTS-HD MA"), container and REMUX. Three groups:
  1. **Plays directly:** H.264/AV1/VP9 video + AAC/Opus audio in MP4/WebM, or MKV the browser can open.
  2. **Plays with conversion:** needs the in-browser converter (below). Cheap when only audio is re-encoded (H.264 + AC3/EAC3, the most common debrid case). Heavy when the video is HEVC (decode + re-encode, capped at 1080p).
  3. **Probably won't play:** only DTS/TrueHD audio (no browser decoder for those), or too large/high-bitrate to stream (REMUX, > ~40 Mbps). Shown collapsed with "Try anyway".
- **Auto-convert (requested, based on the existing "Convert" option):** `src/utils/clientTranscode.ts` already converts URLs in the browser with WebCodecs + mediabunny (+ `@mediabunny/ac3` for AC3/EAC3). It copies tracks that play natively and re-encodes only what doesn't, streaming fragmented MP4 into MediaSource. Verified 2026-11-26: AIOStreams playback URLs redirect to the debrid CDN, which serves CORS (`Access-Control-Allow-Origin` reflects our origin) and range requests (`206`), the two things the converter needs.
  - When a stream is picked, **each viewer's browser probes it** (mediabunny reads the container headers via a few range requests) and decides for itself: play directly, convert, or fail with a toast in the room ("Alex can't play this stream"). This uses the real track list, not filename guesses.
  - Conversion turns on **automatically when needed**, with a per-device "Auto-convert" setting (default on) replacing the old global toggle. Audio-track selection from the converter (multi-language files) is exposed in the player's audio/subtitle menu.
  - **Limits to surface in the UI:**
    - HEVC decoding depends on the browser and hardware (not available in Firefox).
    - Re-encoding 4K HEVC is heavy on phones and low-end laptops.
    - Every viewer downloads the source bitrate.
    - The ready check (6d) covers viewers whose conversion can't keep up.
  - **Fallback for weak devices:** "Share converted stream". The host converts once and streams the result to the room through the existing file-share WebRTC pipeline, limited by the host's upload bandwidth.
- **Recommended:** create a **separate AIOStreams config for WatchParty** that prefers 1080p WEB-DL, H.264/AV1, excludes REMUX/DTS/TrueHD/DV-only and caps size, then use that URL here. The Stremio config stays untouched. This does most of the filtering upstream and keeps responses small.
- **Speed:** stream lookups took several seconds and returned ~200 results. The server caches them (~10 min per id) and trims what it sends to the client.
- [x] **Server routes** (behind the password session, `server/addons/`): `GET /addon/search?q=`, `GET /addon/meta/:type/:id`, `GET /addon/streams/:type/:id`, plus `/addon/subtitles` and `/addon/next` for 6d. Results are cached in memory (TTL + LRU, concurrent lookups de-duplicated). The stream parser/classifier (`server/addons/streamParser.ts`) does the ranking described above server-side. API contract in CLAUDE.md.
- [x] **Client** (Phase 4 picker): `src/api/addons.ts` + the command-palette source picker (`components/App/picker/`): search → movie streams / series → season → episode → streams, grouped by tier, readable names instead of URLs, `CMD:videoMeta` room metadata, recent sources.
- [x] **Auto-convert client:** per-viewer probe (`probeMedia`) → `decidePlayback` (direct / convert / fail) with the per-device "Auto-convert when needed" setting (default on), audio-track choice, "Converting · N% buffered" status, `CMD:playbackIssue` toasts with "Pick another", and "Share converted stream" over the file-share pipeline.
  - Kitsu ids are always looked up as type `anime`: as `series`, AIOStreams returns lots of unrelated results (spin-offs, movies, other shows).
  - Playback URLs don't contain the manifest's uuid/config, but each one carries an AIOStreams-encrypted debrid credential blob (`{i,e,t}`) that can be reused to start other playbacks through the owner's debrid account. That's acceptable while every instance user is trusted. Hiding it would need a video byte proxy, because a redirect still exposes the `Location`.
- **Playback compatibility:** debrid results are often MKV/HEVC/AC3/EAC3, which browsers can't always play. The picker shows a "browser-friendly" badge (MP4/WebM, H.264/AV1/VP9, AAC/Opus), and those are sorted first. Use AIOStreams' own filters/sorting to prefer them too.
- **IP-locked links:** not an issue. Your AIOStreams already proxies playback, so the app never proxies video.
- Torrent-only results (`infoHash` with no URL) are hidden, since WebTorrent is removed.
- Room state stores the IMDb id and episode, so the stream can be re-resolved if a debrid link expires mid-session.

#### 6d. Accepted recommendations (in scope)

- [ ] **Next episode:** when an AIOStreams episode ends, offer "Next episode in 10s" (cancelable) for the whole room. It re-resolves streams for `s:e+1`, preferring the same `bingeGroup` so quality and source stay consistent. _Server done:_ `GET /addon/next/:type/:id` and `?bingeGroup=` on `/addon/streams`. The client is still to do.
- [ ] **Auto subtitles for AIOStreams titles:** a Stremio subtitle addon (OpenSubtitles v3, keyless, by IMDb id/episode) fills the subtitle menu automatically, with the offset from 6b applied. _Server done:_ `GET /addon/subtitles/:type/:id` (kitsu ids are mapped to IMDb episodes; the SRT URLs allow CORS `*`). _Client:_ `picker/useAutoSubtitles.ts` lists them in the subtitle menu (`state.subtitleTracks`) while the room has `videoMeta`.
- [x] **Smoother sync:** fix drift under ~2s by briefly nudging `playbackRate` (0.95–1.05x) and hard-seek only beyond that. A sync indicator shows in the controls. _Done:_ `nextDriftAction` in `logic/sync.ts` (proportional, hysteresis, seek cooldown, YouTube-supported rates only) and `SyncIndicator` (pill + per-person popover + "Resync me").
- [ ] **Ready check:** optional room toggle. When anyone buffers or joins mid-play, the room auto-pauses until all viewers report enough buffer, then resumes.
- [ ] **Continue watching / history:** per-room list of recent titles (AIOStreams metadata + poster) with resume position, stored in SQLite.
- [x] **Nightly SQLite backup:** `sqlite3 .backup` via a tiny sidecar in the compose stack, keeping the last 7 copies in `./data/backups` (done in Phase 5).

Not in scope: PWA install / share target.

## Upstream relationship

After Phase 1 this fork diverges heavily, so merging upstream regularly won't be practical. Instead, cherry-pick specific upstream fixes (e.g. player/sync bugs) when they're relevant (`git log upstream/master`).

## Open questions

None blocking. Optional: create the WatchParty-specific AIOStreams config (see 6c) and replace `AIOSTREAMS_MANIFEST_URL` in `.env`.
