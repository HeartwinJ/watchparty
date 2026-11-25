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
- Tests use **Vitest** and live next to the code as `*.test.ts(x)`. `server/**` tests run in the `node` environment and `src/**` tests in `happy-dom` (projects are defined in `vite.config.ts`). Add tests for new logic, especially pure helpers (parsers, sync math, stream ranking) and socket handlers.
- Node 24+ is required. The server runs TypeScript directly with no compile step, so server code must use only **erasable** TS syntax (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties. Relative imports must include the `.ts` extension (`import x from "./utils/db.ts"`).
- `typescript` is v7 (the native/Go compiler).

## Architecture

**Server (`server/`)**: Express 5 + Socket.IO (websocket transport only).

- `server.ts`: HTTP routes (`/createRoom`, `/generateName`, `/youtube`, `/youtubePlaylist/:id`, `/proxy/*`, subtitles, `/iceServers`, `/ping`), Socket.IO setup, the in-memory `rooms` Map, the 1s save loop that persists active rooms and unloads empty rooms idle for 8h, and graceful shutdown (SIGTERM/SIGINT save every room and close the DB). It also serves `build/` as a single-page app (SPA) fallback. Single process, no sharding.
- `room.ts`: the `Room` class. **Each room is its own Socket.IO namespace** (`/roomId`). Client→server events are named `CMD:*` and registered with the wrapped `on(...)` helper in the constructor, which catches errors so one bad message can't crash the process. Room state (video, timestamps, playlist, chat, roster) lives in memory. `serialize()`/`deserialize()` handle persistence, and `saveRoom()` writes the room to SQLite. Screen/file share is P2P WebRTC, signaled via `CMD:joinScreenShare`/`CMD:leaveScreenShare`/`signalSS`. Everyone who knows the instance password is trusted (anyone can kick or delete chat; there are no owners/locks).
- `config.ts`: **every server env var with its default and a comment**. Add new server config here.
- `utils/`: `db.ts` (SQLite via built-in `node:sqlite`; add schema changes to `MIGRATIONS`, tracked with `PRAGMA user_version`), `auth.ts` + `session.ts` (instance password, HMAC-signed `wp_session` cookie, login rate limit), `iceServers.ts` (Cloudflare TURN credentials, STUN fallback), `youtube.ts` (small `fetch` client for the YouTube Data API), `ssrf.ts` (guards the proxy), `moniker.ts` (random room/user names from `words/`). Optional integrations are no-ops when their env var isn't set; keep it that way.
- **Auth**: if `APP_PASSWORD` is set, every API route uses the `requireAuth` middleware (except `/ping`, `/session`, `/login`, `/logout`, static assets and the SPA fallback), and every Socket.IO namespace rejects connections without a valid session (`connect_error` "unauthorized"; checked on the engine handshake, enforced via `io.on("new_namespace")`). New API routes must add `requireAuth`.

**Client (`src/`)**: React 18 + Vite + Mantine 8, react-router v5.

- `index.tsx`: routes (`/`, `/create`, `/watch/:roomId`) wrapped in `components/AuthGate`, which calls `GET /session` on load and shows a password form (`POST /login`) until logged in. A 401 from any API call or a socket `connect_error` of `"unauthorized"` sends the app back to the login form. `AuthContext`/`useAuth()` exposes `authRequired` and `logout()` (the "Log out" button is in `TopBar`). A 404 from `/session` is treated as "no auth".
- `components/App/App.tsx` (~1.8k lines) is the main room page and holds most client state and socket handling. `App/Player.ts`, `HTML.ts` and `YouTube.ts` abstract the video players. Supported sources: YouTube, direct URLs, HLS (hls.js, lazy), DASH (dash.js, lazy), screen share and file share (P2P WebRTC only, optional in-browser transcoding via mediabunny, lazy).
- `config.ts`: client `VITE_*` env vars (only `VITE_SERVER_HOST`). `utils/api.ts` `serverPath` decides where the client sends requests: `VITE_SERVER_HOST`, or `hostname:8080` in dev, or the same origin in prod.
- **Always call the server through `apiFetch()` (`utils/api.ts`)**, never bare `fetch`: it sends `credentials: "include"` (the dev client runs on a different port) and handles 401s. URLs on other origins go through plain `fetch` without credentials. The room socket uses `withCredentials: true`.
- `utils/iceServers.ts` `getIceServers()`: fetches `GET /iceServers` once (cached 1h in memory, failures not cached) for screen/file share, falling back to Cloudflare STUN.
- Components are in `src/components/<Name>/<Name>.tsx`, with CSS modules where styling is needed.
- `global.d.ts` (repo root) has types shared by client and server (`User`, `ChatMessage`, `RoomState`, etc.). Update it when you change data sent over the socket.

**Data**: one SQLite file, `$DATA_DIR/watchparty.db` (default `./data`, gitignored, WAL mode). Tables: `rooms` (roomId, data JSON, lastUpdateTime, createdAt; every room persists) and `subtitles` (uploaded/downloaded subtitles, gzipped, 24h sliding expiry). The schema lives in `server/utils/db.ts`. Back up by copying `data/`. There's no Postgres or Redis.

## Configuration / self-hosting notes

- Copy `.env.example` to `.env` (gitignored). Both server and Vite load it via `loadEnvFile()`.
- Client env: only `VITE_SERVER_HOST` (optional). Firebase/OAuth config, accounts and the marketing/legal pages are gone.
- Server env: `APP_PASSWORD` (blank disables auth, with a warning), `SESSION_SECRET` (blank means a random secret per process, so sessions reset on restart), `DATA_DIR`, `TRUST_PROXY` (default trusts private/loopback proxies such as cloudflared, so `req.secure`/`req.ip` honor `X-Forwarded-*`), `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` (optional TURN), `YOUTUBE_API_KEY`, `OPENSUBTITLES_KEY`. See `server/config.ts`.
- CORS: none in production (same origin). `npm run dev` sets `NODE_ENV=development`, which reflects the request origin with credentials so the Vite dev server on another port can send the session cookie.
- Simplest deployment: `Dockerfile` (`npm ci && npm run build && npm start`) behind a TLS reverse proxy. HTTPS is required for camera, mic and screen-share features. To serve TLS directly instead, set `SSL_KEY_FILE`/`SSL_CRT_FILE`.

## Gotchas

- `AIOSTREAMS_MANIFEST_URL` (in `.env`) embeds the owner's AIOStreams config/debrid credentials. Use it server-side only. Never send it to the client, log it, put it in error messages, or commit it.

- Dependabot opens grouped monthly PRs on the fork.
- Socket handlers receive untrusted input. Type params as `unknown` and validate them, following the existing `CMD:*` handlers. Anything that fetches user-supplied URLs must go through `utils/ssrf.ts`.
- Rooms with no users and 8h of idle time are unloaded from memory and reloaded from Postgres when someone connects (`io.engine.use` in `server.ts`). New room fields must be added to `serialize`/`deserialize` or they'll be lost.
