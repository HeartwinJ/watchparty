# WatchParty (personal fork)

A self-hosted site for watching videos in sync with friends. This is a personal fork of [howardchung/watchparty](https://github.com/howardchung/watchparty), cut down to the features I use, redesigned, and tuned to run cheaply on a single small server (about 30 MB of RAM when idle).

![A WatchParty room: the video plays on the left, chat on the right, with "In sync" and two viewers in the top bar](docs/screenshot.webp)

<sub>Screenshot: <a href="https://studio.blender.org/films/spring/">Spring</a> by Blender Studio (CC BY 4.0).</sub>

## Features

**Watching together**

- Synced play, pause, seek, speed and loop for everyone in the room. Small drift is corrected by briefly nudging the playback speed instead of jumping, and an "In sync" indicator shows how far behind each person is.
- One click on the video plays or pauses for everyone, with a toast saying who did it.
- **Ready check** (on by default, can be turned off per room): when someone buffers or joins mid-play, the room pauses until everyone has enough loaded.
- **Next episode**: near the end of an episode, everyone gets an "Up next" card. It plays the next episode from the same release automatically unless someone cancels.
- **Skip intro** (off by default, per room): every video the room switches to from the beginning (a pick, the queue, the next episode) starts a set time in, for everyone at the same spot. Presets from 15 s to 2:00 or a custom value up to 10 minutes. Everyone sees "Skipped intro (1:30) · Watch from start" for a few seconds. Resumed videos, screen/file shares, live streams and short videos (under 5 minutes or twice the skip) start normally, and the skipped part doesn't count as watched.
- **Continue watching** on the home page: what you were watching, with progress, resumes in a new room where you left off.
- **Voice and video call**: join from the room's top bar, pick your mic and check its level first. If the video is playing you join muted (so you don't talk over the movie); after that, play/pause never changes your mic. `M` mutes and unmutes, optional push-to-talk (hold `T`), speaking rings on avatars, and an optional per-device "lower the movie while people talk" (40 % quieter while someone speaks). **Camera** is off until you turn it on (`V`, the camera button, or with a live preview in the call panel before joining; your camera choice is remembered per device). Cameras show as small tiles floating over the video, also in fullscreen: drag them anywhere, collapse them, click one to enlarge it, or hide them on your device. While your tiles are hidden or collapsed, or the tab is in the background, the others stop sending you camera video (voice keeps going), so it costs no bandwidth; it resumes within about a second when you show them again. Video is kept small and capped by how many people actually receive it (720p for one, 540p for two, 360p for three or four, 240p above that) so it never gets in the way of the movie or the voices. Owners can ask someone to mute or turn their camera off, or remove them from the call. Peer-to-peer, up to 8 people (best under 5); a reload or a dropped connection rejoins on its own. **TURN credentials (`CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN`) are strongly recommended**: without a relay, calls between some networks (mobile data, strict NATs) can't connect.

**Sources**

- YouTube, direct video links, HLS (`.m3u8`) and DASH streams.
- **Movies & shows search** through an [AIOStreams](https://github.com/Viren070/AIOStreams) addon: search a title, pick a season and episode, and choose a stream. Streams are grouped by how likely they are to play in a browser.
- **Auto-convert**: each viewer's browser checks what it can play and converts video it can't play natively (MKV, AC3/EAC3 audio, etc.), right there in that viewer's browser. Anyone whose device can't keep up can be sent a converted stream shared by someone else.
- Screen sharing and stream-your-own-file over peer-to-peer WebRTC, with an optional Cloudflare TURN relay for strict networks.
- A queue with drag to reorder.
- **Stop video**: anyone can clear the player for everyone (⋯ menu or the top of the picker). The queue stays as it is.

**Player**

- Fullscreen with auto-hiding controls and cursor, keyboard shortcuts (`?` lists them; hold Space to play the room at 2×) and phone gestures.
- Subtitles: upload, load from a URL, **search by title** (movies, shows and anime, no API key needed; it guesses the title and episode from what's playing), or get them automatically for movies and shows. Whatever you pick loads for everyone. Adjust the **subtitle offset** for everyone or just yourself; it's remembered per title and episode. **Auto-sync** (the wand in the subtitles menu) listens to a few minutes of the video's audio in your browser and lines the subtitles up with the speech, also correcting frame-rate drift (subtitles made for a 25 fps release on a 23.976 fps video and similar); owners can turn it on for every subtitle loaded in a room (one viewer's device does the work). Size and style are adjustable. Long subtitle lists are grouped by language with a filter. If you had subtitles on, the next episode turns them on again in the same language (and keeps them off if you had them off).
- **Volume boost and Night mode** (just you, remembered per device, in the Audio menu: the headphones button): play up to 300 % louder, and/or even out the volume so speech is louder and explosions quieter, with a limiter so it doesn't distort. Works for everything except YouTube, as long as the video's server allows it (AIOStreams streams, HLS/DASH, converted videos and shares do). If a later video's server doesn't, the page reloads once to play it normally. In Firefox, MKV files whose audio would stutter through the boost are re-packed in the browser first (a copy, no re-encoding).
- Chat with reactions and emoji. Messages show as bubbles over the video in fullscreen or with the sidebar hidden, where `c` opens a one-line quick reply (with an emoji picker). The full chat (history, replies, reactions, emoji) can slide in over the right side of the video there too: the chat button in the player controls (with an unread count) or `Shift + C`; the video keeps playing at full size, and it starts collapsed every time. Videos that start on their own (queue, next episode) get a "Now playing" line.

**Rooms and hosting**

- Room settings: title, ready check, when the next-episode card appears, subtitle auto-sync and skip intro.
- Resizable sidebar on desktop, and a bottom sheet on phones.
- No user accounts: the owner logs in with the instance password; guests get a room link plus that room's auto-generated password (or a link with the password built in), can only use that one room, and can't change its settings or remove people. The owner can regenerate, set or turn off each room's password, and removing a guest revokes their access (also while the password is off) until the password is changed or turned on. Someone who clears their browser's cookies can rejoin an open room.
- Everything is stored in one SQLite file, so rooms survive restarts. A sidecar container takes a nightly backup.
- Owners can delete a room (room menu or Home's recent rooms), and rooms nobody has used for 60 days are deleted automatically (`ROOM_MAX_IDLE_DAYS`, `0` keeps them forever).
- One `docker compose up -d` with a Cloudflare Tunnel, so the host doesn't need to open any ports.

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

| Variable                               | Purpose                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `APP_PASSWORD`                         | Instance password. Blank turns off auth (fine for local dev only)                                 |
| `SESSION_SECRET`                       | Signs login cookies. Set it in production so logins survive restarts                              |
| `DATA_DIR`                             | Where the SQLite database lives (default `./data`)                                                |
| `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` | Cloudflare Realtime TURN relay for voice calls and screen/file share behind strict networks       |
| `AIOSTREAMS_MANIFEST_URL`              | Your AIOStreams manifest URL. Turns on movies & shows search. **Secret**: it contains your config |
| `SUBTITLE_LANGS`                       | Preferred languages for automatic subtitles, e.g. `en,es` (default `en`)                          |
| `ROOM_MAX_IDLE_DAYS`                   | Delete rooms nobody has used for this many days (default `60`, `0` = never)                       |
| `YOUTUBE_API_KEY`                      | Turns on YouTube search and titles                                                                |
| `OPENSUBTITLES_KEY`                    | Adds subtitle search by file name (an OpenSubtitles.com API key); title search needs no key       |

## License

MIT, as upstream. See [`LICENSE`](LICENSE).
