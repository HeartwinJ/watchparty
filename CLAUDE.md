# CLAUDE.md

Personal fork of [howardchung/watchparty](https://github.com/howardchung/watchparty): a site for watching videos together with synced playback, chat, video chat, screen share and virtual browsers. The goal is to add my own features and self-host it for personal use, not to run the public watchparty.me service.

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
- Node 24+ is required. The server runs TypeScript directly with no compile step, so server code must use only **erasable** TS syntax (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties. Relative imports must include the `.ts` extension (`import x from "./utils/redis.ts"`).
- `typescript` is v7 (the native/Go compiler).

## Architecture

**Server (`server/`)**: Express 5 + Socket.IO (websocket transport only).

- `server.ts`: HTTP routes (`/createRoom`, `/youtube`, `/metadata`, `/proxy/*`, subtitles, Stripe and account endpoints), Socket.IO setup, the in-memory `rooms` Map, and the loops that persist and unload rooms. It also serves `build/` as a single-page app (SPA) fallback.
- `room.ts`: the `Room` class. **Each room is its own Socket.IO namespace** (`/roomId`). Client→server events are named `CMD:*` and registered with the wrapped `on(...)` helper in the constructor, which catches errors so one bad message can't crash the process. Room state (video, timestamps, playlist, chat, roster, vBrowser) lives in memory. `serialize()`/`deserialize()` handle persistence, and `saveRoom()` writes the room to Postgres.
- `config.ts`: **every server env var with its default and a comment**. Add new server config here.
- `utils/`: optional integrations (`postgres.ts`, `redis.ts`, `firebase.ts`, `stripe.ts`, `youtube.ts`) and helpers (`ssrf.ts` guards the proxy, `resolveShard.ts`). Each integration is null or a no-op when its env var isn't set. Keep it that way, and guard calls with `postgres?.` / `if (redis)`.
- `vm/`: virtual browser (neko) providers: `docker.ts` (easiest to self-host) plus Hetzner, DigitalOcean and Scaleway. `vmWorker.ts` manages VM pools and is auto-imported in development.
- Separate background processes (see `ecosystem.config.js`): `vmWorker`, `syncSubs` (Stripe), `timeSeries`, `cleanup`, `discordBot`. Most of these are for running the public service and probably aren't needed for personal hosting.
- Sharding: when `SHARD` is set, rooms are split across processes by the first letter of the room ID (`resolveShard.ts` counts the shards in `ecosystem.config.js`). With `SHARD` unset (normal single-process self-hosting), everything runs in one process.

**Client (`src/`)**: React 18 + Vite + Mantine 8, react-router v5.

- `index.tsx`: routes and app shell. `components/App/App.tsx` (~2.8k lines) is the main room page and holds most client state and socket handling. `App/Player.ts`, `HTML.ts` and `YouTube.ts` abstract the video players.
- `config.ts`: client `VITE_*` env vars. `utils/utils.ts` `serverPath` decides where the client sends requests: `VITE_SERVER_HOST`, or `hostname:8080` in dev, or the same origin in prod.
- Components are in `src/components/<Name>/<Name>.tsx`, with CSS modules where styling is needed.
- `global.d.ts` (repo root) has types shared by client and server (`User`, `ChatMessage`, `RoomState`, etc.). Update it when you change data sent over the socket.

**Data**: `sql/schema.sql` (tables: room, subscriber, link_account, active_user, vbrowser) and `sql/migrations.sql`. Postgres is optional. Without it, rooms aren't saved across restarts and the owner/lock/vanity URL features are off. Redis is optional and only used for metrics and session spoof protection.

## Configuration / self-hosting notes

- Copy `.env.example` to `.env` (gitignored). Both server and Vite load it via `loadEnvFile()`.
- Leave `VITE_FIREBASE_CONFIG=` blank to turn off login. All features are then usable without an account. If the variable is _missing_ entirely, `src/config.ts` falls back to **upstream's Firebase project**, so keep it set, even if blank.
- Upstream-specific values to change for my deployment:
  - `src/config.ts` `VITE_OAUTH_REDIRECT_HOSTNAME`, which defaults to `https://www.watchparty.me`
  - `server/discordBot.ts`, which has hardcoded watchparty.me hostnames
  - `server/ecosystem.config.js`, which has upstream's shard layout, gateways and VM image IDs
  - the Terms/Privacy/FAQ text in `src/components/Pages/Pages.tsx`, and the support email in `ProfileModal.tsx`
  - Discord IDs in `server/config.ts`
- Stripe/subscriptions, Discord bots, cloud VM providers and the stats/timeSeries endpoints are upstream's business features. They're optional and can be ignored or removed.
- Simplest deployment: `Dockerfile` (`npm ci && npm run build && npm start`) behind a TLS reverse proxy. HTTPS is required for camera, mic and screen-share features. To serve TLS directly instead, set `SSL_KEY_FILE`/`SSL_CRT_FILE`.

## Gotchas

- `AIOSTREAMS_MANIFEST_URL` (in `.env`) embeds the owner's AIOStreams config/debrid credentials. Use it server-side only. Never send it to the client, log it, put it in error messages, or commit it.

- Dependabot opens grouped monthly PRs on the fork.
- Socket handlers receive untrusted input. Type params as `unknown` and validate them, following the existing `CMD:*` handlers. Anything that fetches user-supplied URLs must go through `utils/ssrf.ts`.
- Rooms with no users and 8h of idle time are unloaded from memory and reloaded from Postgres when someone connects (`io.engine.use` in `server.ts`). New room fields must be added to `serialize`/`deserialize` or they'll be lost.
