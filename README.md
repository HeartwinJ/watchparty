# WatchParty (personal fork)

A self-hosted site for watching videos in sync with friends. This is a personal fork of [howardchung/watchparty](https://github.com/howardchung/watchparty), cut down to the features I use and tuned to run cheaply on a single small server.

## Features

- Synced play, pause, seek, speed and loop for everyone in the room
- Sources: YouTube, direct video URLs, HLS (`.m3u8`) and DASH streams
- Screen sharing and stream-your-own-file over peer-to-peer WebRTC, with in-browser conversion for formats browsers can't play natively
- Playlist, text chat with reactions, and subtitles
- One shared instance password instead of user accounts
- Rooms saved in SQLite, so they survive restarts
- Continue watching on the home page: what you were watching, with progress, resumes in a new room where you left off

See [`PLAN.md`](PLAN.md) for the roadmap: UI redesign, fullscreen improvements, subtitle offset and AIOStreams search.

## Development

Requires Node 24+.

```bash
npm install
cp .env.example .env   # optional settings; everything works with defaults
npm run dev            # server on :8080
npm run ui             # client dev server (in a second shell)
```

Checks (the same ones CI runs):

```bash
npm run format:check && npm run check && npx vite build
```

## Deployment

One `docker compose up -d` runs the app, a Cloudflare Tunnel and a nightly SQLite backup, with no ports opened on the host. The app image is built on the host from the checkout. See [`DEPLOY.md`](DEPLOY.md) for the step-by-step setup.

## Configuration

All settings are environment variables. See [`.env.example`](.env.example) and `server/config.ts`. The important ones:

| Variable                               | Purpose                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `APP_PASSWORD`                         | Instance password. Blank turns off auth (fine for local dev only)           |
| `SESSION_SECRET`                       | Signs login cookies. Set it in production so logins survive restarts        |
| `DATA_DIR`                             | Where the SQLite database lives (default `./data`)                          |
| `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` | Cloudflare Realtime TURN relay for screen/file share behind strict networks |
| `YOUTUBE_API_KEY`                      | Turns on YouTube search                                                     |
| `OPENSUBTITLES_KEY`                    | Turns on subtitle search                                                    |

## License

MIT, as upstream. See [`LICENSE`](LICENSE).
