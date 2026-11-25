# CLAUDE.md

Personal fork of [howardchung/watchparty](https://github.com/howardchung/watchparty): a site for watching videos together with synced playback, chat, screen share and file share. The goal is to add my own features and self-host it for personal use, not to run the public watchparty.me service.

## Git & PR rules (important)

- `origin` = `HeartwinJ/watchparty` (my fork, **public** repo, so never commit secrets). `upstream` = `howardchung/watchparty`, **fetch-only** (its push URL is deliberately disabled).
- **Never push to upstream and never open PRs/issues against `howardchung/watchparty`.** Because this is a fork, `gh pr create` may default to the parent repo, so **always** pass `--repo HeartwinJ/watchparty --base master`.
- Work on a feature branch (`feat/…`, `chore/…`, `fix/…`), open a PR to `master` on the fork, and merge only after CI is green.
- Before opening a PR, run `npm run format:check && npm run check && npx vite build`.
- A major modernization is planned in `PLAN.md` (strip paid/upstream features, SQLite, password auth, stack upgrades, UI redesign, single compose stack with cloudflared, Cloudflare TURN, AIOStreams integration). Follow it, and update this file as phases land, since the architecture notes below describe the _pre-plan_ code. After Phase 1 the fork diverges heavily, so cherry-pick specific upstream fixes rather than merging.

## Commands

```bash
npm install            # node_modules is not checked in; run this first
npm run dev            # backend on :8080, restarts on changes under server/ (node runs .ts directly)
npm run ui             # Vite dev server for the React client (run in a second shell)
npm run typecheck      # client typecheck (src/tsconfig.json)
npm run typecheckServer# server typecheck (server/tsconfig.json)
npm run build          # vite build -> build/, plus both typechecks
npm test               # Vitest, run once (npm run test:watch for watch mode)
npm run check          # both typechecks + tests
npm run format:check   # Prettier check (CI enforces it); npm run prettier to fix
npm start              # production: serves the API and build/ from one process
```

- CI (`.github/workflows/nodejs.yml`) runs on PRs and pushes to `master`: format check, both typechecks, unit tests and the Vite build.
- Tests use **Vitest** (+ `@testing-library/react` for hooks/components) and live next to the code as `*.test.ts(x)`. `server/**` tests run in the `node` environment and `src/**` tests in `happy-dom` (projects are defined in `vite.config.ts`). Add tests for new logic, especially pure helpers (parsers, sync math, stream ranking) and socket handlers.
- Node 24+ is required. The server runs TypeScript directly with no compile step, so server code must use only **erasable** TS syntax (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties. Relative imports must include the `.ts` extension (`import x from "./utils/db.ts"`).
- `typescript` is v7 (the native/Go compiler).

## Architecture

**Server (`server/`)**: Express 5 + Socket.IO (websocket transport only).

- `server.ts`: HTTP routes (`/createRoom`, `/generateName`, `/youtube`, `/youtubePlaylist/:id`, `/proxy/*`, subtitles, `/iceServers`, `/ping`), Socket.IO setup, the in-memory `rooms` Map, the 1s save loop that persists active rooms and unloads empty rooms idle for 8h, and graceful shutdown (SIGTERM/SIGINT save every room and close the DB). It also serves `build/` as a single-page app (SPA) fallback. Single process, no sharding.
- `room.ts`: the `Room` class. **Each room is its own Socket.IO namespace** (`/roomId`). Client→server events are named `CMD:*` and registered with the wrapped `on(...)` helper in the constructor, which catches errors so one bad message can't crash the process. Room state (video, timestamps, playlist, chat, roster) lives in memory. `serialize()`/`deserialize()` handle persistence, and `saveRoom()` writes the room to SQLite. Screen/file share is P2P WebRTC, signaled via `CMD:joinScreenShare`/`CMD:leaveScreenShare`/`signalSS`. Everyone who knows the instance password is trusted (anyone can kick or delete chat; there are no owners/locks).
- `config.ts`: **every server env var with its default and a comment**. Add new server config here.
- `utils/`: `db.ts` (SQLite via built-in `node:sqlite`; add schema changes to `MIGRATIONS`, tracked with `PRAGMA user_version`), `auth.ts` + `session.ts` (instance password, HMAC-signed `wp_session` cookie, login rate limit), `iceServers.ts` (Cloudflare TURN credentials, STUN fallback), `youtube.ts` (small `fetch` client for the YouTube Data API), `ssrf.ts` (guards the proxy), `moniker.ts` (random room/user names from `words/`). Optional integrations are no-ops when their env var isn't set; keep it that way.
- `addons/`: AIOStreams + Stremio addon integration (PLAN 6c/6d). `routes.ts` (`createAddonRouter`, mounted in `server.ts`), `streamParser.ts` (pure parser/classifier/ranker for AIOStreams results), `catalog.ts` (Cinemeta + Anime Kitsu search/meta/next episode), `subtitles.ts` (OpenSubtitles v3), `aiostreams.ts`, `cache.ts` (`TtlCache`: TTL + LRU + in-flight de-dupe), `http.ts` (`fetchJson` with timeout/size limit and URL-free `AddonError`s, `createRedactor`), `ids.ts` (param validation). Public addons are fetched through `safeFetch`. The AIOStreams host uses plain `fetch`, because it's owner-controlled and may be on a LAN.
- **Addon API** (all `requireAuth`. Every route returns `503 {error:"aiostreams_not_configured"}` without `AIOSTREAMS_MANIFEST_URL`, `400 {error:"invalid_params"}` for a bad type/id, and `502 {error:"upstream_error"|"upstream_timeout"}` when an upstream addon fails). `:type` is `movie|series|anime`. `:id` is `tt123`, `tt123:S:E`, `kitsu:123` or `kitsu:123:E`.
  - `GET /addon/search?q=` (1–100 chars) → `{movies, series, anime}: SearchItem[]`, with `SearchItem = {id, type: "movie"|"series", name, year: number|null, poster: string|null}`. Up to 20 per group, cached 1h. One failing source just gives an empty group.
  - `GET /addon/meta/:type/:id` → `Meta = {id, type, name, year, releaseInfo, poster, background, logo, description, runtime, genres[], imdbId, seasons: [{season, episodes: Episode[]}]}`, with `Episode = {id: "tt..:s:e"|"kitsu:N:e", season, episode, title, released, thumbnail}`. Movies have `seasons: []`. Specials (season 0) come last. An episode id is accepted and its base id is used. 404 `{error:"not_found"}` for unknown ids. Cached 1h.
  - `GET /addon/streams/:type/:id[?bingeGroup=]` → `{streams: StreamDTO[], counts: {direct, "convert-light", "convert-heavy", unlikely}, total}`. Sorted by tier, then score, then AIOStreams order, capped at 60 (`counts`/`total` cover everything playable). Torrent-only results are dropped. Kitsu ids are always queried as `anime`. Raw results are cached 10 min per id. `bingeGroup` adds +200 to matching streams' score (within their tier); use it for the next episode. `StreamDTO = {url, name, title, filename, resolution, sizeBytes, bitrateMbps, durationSec, source, remux, videoCodec: "h264"|"hevc"|"av1"|"vp9"|"vc1"|"mpeg2"|"mpeg4"|null, bitDepth: 8|10|null, hdr: string[], audio: ("aac"|"opus"|"mp3"|"flac"|"ac3"|"eac3"|"dts"|"dts-hd"|"truehd"|"atmos"|"pcm")[], languages: string[] (flag country codes, "multi", "dubbed"), container: "mkv"|"mp4"|...|"other:<ext>"|null, cached: boolean|null, service, addon, indexer, releaseGroup, bingeGroup, tier, reasons: string[], score}`. `url` is the AIOStreams playback URL (307s to the debrid CDN, which allows CORS + range requests).
  - `GET /addon/subtitles/:type/:id` → `[{id, lang (ISO 639-1 where known, e.g. "en", "pt-BR"), label ("English", "English 2"), url}]`. `SUBTITLE_LANGS` languages come first. Kitsu ids are mapped to the IMDb episode via Kitsu meta, or give `[]`. The SRT URLs send CORS `*`, so the browser fetches them directly.
  - `GET /addon/next/:type/:id` → `{next: Episode|null}`. Null for movies, the last episode, unknown ids, or a next episode that hasn't aired yet.
  - Tiers (guesses only; the client still probes the real tracks): `unlikely` = REMUX, > 40 Mbps, > 40 GB, unsupported container (avi/iso/m2ts/...), VC-1/MPEG-2/XviD video, or only DTS/DTS-HD/TrueHD/PCM audio. Otherwise `convert-heavy` = HEVC or 10-bit H.264. Otherwise `convert-light` = audio only AC3/EAC3/FLAC, MPEG-TS, or unknown video/audio codec. Otherwise `direct` = H.264/AV1/VP9 + AAC/Opus/MP3 (MKV stays direct with a note). Score: 1080p > 1440p > 720p > 4K, cached +50, a sane bitrate (2–20 Mbps) +20, WEB-DL +10.
- **Auth**: if `APP_PASSWORD` is set, every API route uses the `requireAuth` middleware (except `/ping`, `/session`, `/login`, `/logout`, static assets and the SPA fallback), and every Socket.IO namespace rejects connections without a valid session (`connect_error` "unauthorized"; checked on the engine handshake, enforced via `io.on("new_namespace")`). New API routes must add `requireAuth`.

**Client (`src/`)**: React 19 + Vite 8 + Mantine 9, with a tiny hand-rolled router (`router.ts`).

- `index.tsx`: routes via `useRoute()` from `router.ts` (`/`, `/create`, `/watch/:roomId`, plus a not-found page), wrapped in `components/AuthGate`, which calls `GET /session` on load and shows a password form (`POST /login`) until logged in. A 401 from any API call or a socket `connect_error` of `"unauthorized"` sends the app back to the login form. `AuthContext`/`useAuth()` exposes `authRequired` and `logout()` (the "Log out" button is in `TopBar`). A 404 from `/session` is treated as "no auth". Use `navigate()` from `router.ts` for client-side navigation.
- `components/App/` is the room page: `App.tsx` is layout only and `hooks/useRoom.ts` composes `useRoomSocket`, `usePlayer`, `useConvert`, `useShare`, `useChat`, `usePlaylist` and `useSubtitles`. Pure logic (sync math, media classification, chat updates, playlist decisions, SDP tweaks) is in `components/App/logic/` with tests. Socket events are typed in `components/App/socketEvents.ts`; emit through `room.cmd.*`, never raw strings. **See `components/App/README.md` before changing it.** `Player.ts`, `HTML.ts` and `YouTube.ts` abstract the video players. Supported sources: YouTube, direct URLs, HLS (hls.js, lazy), DASH (dash.js, lazy), screen share and file share (P2P WebRTC only, optional in-browser transcoding via mediabunny, lazy). The emoji picker (emoji-mart) is lazy too.
- Mantine 9 is configured to keep the 8.x look (`defaultRadius: "sm"`, `v8CssVariablesResolver`) until the Phase 4 redesign.
- `config.ts`: client `VITE_*` env vars (only `VITE_SERVER_HOST`). `utils/api.ts` `serverPath` decides where the client sends requests: `VITE_SERVER_HOST`, or `hostname:8080` in dev, or the same origin in prod.
- **Always call the server through `apiFetch()` (`utils/api.ts`)**, never bare `fetch`: it sends `credentials: "include"` (the dev client runs on a different port) and handles 401s. URLs on other origins go through plain `fetch` without credentials. The room socket uses `withCredentials: true`.
- `utils/iceServers.ts` `getIceServers()`: fetches `GET /iceServers` once (cached 1h in memory, failures not cached) for screen/file share, falling back to Cloudflare STUN.
- Components are in `src/components/<Name>/<Name>.tsx`, with CSS modules where styling is needed.
- `global.d.ts` (repo root) has types shared by client and server (`User`, `ChatMessage`, `RoomState`, etc.). Update it when you change data sent over the socket.

**Data**: one SQLite file, `$DATA_DIR/watchparty.db` (default `./data`, gitignored, WAL mode). Tables: `rooms` (roomId, data JSON, lastUpdateTime, createdAt; every room persists) and `subtitles` (uploaded/downloaded subtitles, gzipped, 24h sliding expiry). The schema lives in `server/utils/db.ts`. In the compose stack the `backup` sidecar writes nightly consistent copies to `data/backups/` (see `DEPLOY.md`); otherwise back up by copying `data/` while the app is stopped. There's no Postgres or Redis.

## Configuration / self-hosting notes

- Copy `.env.example` to `.env` (gitignored). Both server and Vite load it via `loadEnvFile()`.
- Client env: only `VITE_SERVER_HOST` (optional). Firebase/OAuth config, accounts and the marketing/legal pages are gone.
- Server env: `APP_PASSWORD` (blank disables auth, with a warning), `SESSION_SECRET` (blank means a random secret per process, so sessions reset on restart), `DATA_DIR`, `TRUST_PROXY` (default trusts private/loopback proxies such as cloudflared, so `req.secure`/`req.ip` honor `X-Forwarded-*`), `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` (optional TURN), `YOUTUBE_API_KEY`, `OPENSUBTITLES_KEY`, `AIOSTREAMS_MANIFEST_URL` (secret, enables `/addon/*`), `SUBTITLE_LANGS` (default `en`). See `server/config.ts`.
- CORS: none in production (same origin). `npm run dev` sets `NODE_ENV=development`, which reflects the request origin with credentials so the Vite dev server on another port can send the session cookie.
- **Deployment** (see `DEPLOY.md`): `compose.yaml` runs `app` (image `ghcr.io/heartwinj/watchparty:latest`, `build: .` fallback, no published ports, `./data:/app/data`, 256 MB limit), `cloudflared` (tunnel token from `TUNNEL_TOKEN`, public hostname → `http://app:8080`, provides HTTPS) and `backup` (`backup/`: alpine + sqlite3, `.backup` nightly into `data/backups`, keeps 7) on a project-scoped network. `.github/workflows/docker.yml` builds the image on PRs and pushes `latest` + short SHA (amd64 + arm64) on `master`.
- **Dockerfile**: multi-stage. The build stage runs `vite build` and `npm run buildServer` (`tsc -p server/tsconfig.build.json` → plain JS in `dist-server/`, `.ts` imports rewritten to `.js`). The runtime is `alpine` + the stripped `node` binary copied from `node:24-alpine` (the official image alone is ~175 MB; ours is ~140 MB), prod deps only, uid 1000, tini as PID 1, `HEALTHCHECK` on `/ping`, `NODE_OPTIONS=--max-old-space-size=128 --max-semi-space-size=1`. Running compiled JS saves ~28 MB RSS versus running `.ts` (type stripping loads a wasm transformer). `npm run dev`/`npm start` still run the `.ts` directly; `npm run start:prod` runs `dist-server/`. Keep server code compatible with both (relative `.ts` imports, paths resolved from `process.cwd()` or `import.meta.dirname/..`, which is the repo/app root from both `server/` and `dist-server/`). Files the server reads at runtime (like `words/`) must be copied in the Dockerfile.
- HTTPS is required for camera, mic and screen-share features. To serve TLS directly instead of via the tunnel, set `SSL_KEY_FILE`/`SSL_CRT_FILE`.

## Gotchas

- `AIOSTREAMS_MANIFEST_URL` (in `.env`) embeds the owner's AIOStreams config/debrid credentials. Use it only in `server/addons/aiostreams.ts`. Never send it to the client, log it, put it in error messages, or commit it, and use fake URLs (`https://aio.example.com/...`) in tests. `AddonError` messages are built from fixed strings only, and the addon router's logger runs through `createRedactor`. Stream playback URLs (`/api/v1/debrid/playback/...`) don't contain it, but each carries an encrypted, reusable debrid credential blob, so treat them as room-private too.

- Dependabot opens grouped monthly PRs on the fork.
- Socket handlers receive untrusted input. Type params as `unknown` and validate them, following the existing `CMD:*` handlers. Anything that fetches user-supplied URLs must go through `utils/ssrf.ts`.
- Rooms with no users and 8h of idle time are unloaded from memory and reloaded from Postgres when someone connects (`io.engine.use` in `server.ts`). New room fields must be added to `serialize`/`deserialize` or they'll be lost.
