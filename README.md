# WatchParty

![screenshot](https://github.com/howardchung/watchparty/raw/master/public/screenshot_full.png)

A website for watching videos together.

## Description

- Synchronizes the video being watched with the current room
- Plays, pauses, and seeks are synced to all watchers
- Supports:
  - Screen sharing (full screen, browser tab or application)
  - Launch a shared virtual browser in the cloud (similar to rabb.it)
  - Stream-your-own-file (optionally converted in your browser via WebCodecs, for formats browsers can't play)
  - Video files on the Internet (anything accessible via HTTP)
  - YouTube videos
  - Magnet links (via WebTorrent)
  - .m3u8 streams (HLS)
- Create separate rooms for users on demand
- Text chat
- Video chat

## Quick Start

- Clone this repo via `git clone git@github.com:howardchung/watchparty.git`
- Install npm dependencies for the project via `npm install`
- Start the server via `npm run dev`
  - Defaults to port 8080, customize with `PORT` env var
  - Set `SSL_KEY_FILE` and `SSL_CRT_FILE` for HTTPS.
- Start the React application in a separate shell and port via `npm run ui`
  - Point to server using `VITE_SERVER_HOST` env var if you customized it above
  - Set `SSL_KEY_FILE` and `SSL_CRT_FILE` for HTTPS.
  - HTTPS is required by the browser for some WebRTC features (camera, etc.)
- Duplicate the `.env.example` file
- Rename it to `.env`
- Add config for the features you want as described in the advanced setup

## Advanced Setup (optional)

All of these are optional and the application should work without them. Some functionality may be missing.

### YouTube API (video search)

This project uses the YouTube API for video search, which requires an API key. You can get one from Google [here](https://console.developers.google.com).

Without an API key you won't be able to search for videos via the searchbox.

After creating a **YouTube Data API V3** access, you can create an API key which you can add to your environment variables by copying the `.env.example`, renaming it to `.env` and adding the key to the YOUTUBE_API_KEY variable.

After that restart your server to enable the YouTube API access on your server.

### Firebase Config (user authentication)

This project uses Firebase for authentication. This is used for user login, account management, subscriptions, and handling some features like room locking/permanence.

To set up, create a new Firebase app (or reuse an old one) from [here](https://console.firebase.google.com/). After creating an application, click on the settings cog icon in the left menu next to "Project overview" and click on project settings. From there, scroll down, create a web application and copy the Firebase SDK configuration snippet JSON data.

Next, you have to stringify it: `JSON.stringify(PASTE_CONFIG_HERE)` in your browser console, then add it to `VITE_FIREBASE_CONFIG` in your .env file.

For server verification of accounts you'll also need `FIREBASE_ADMIN_SDK_CONFIG`, which you should do the same steps for.

### Instance password

Set `APP_PASSWORD` (and `SESSION_SECRET`, e.g. `openssl rand -hex 32`) in `.env`. Everyone who wants to use the instance must enter the password once; the session cookie lasts 30 days. Without `APP_PASSWORD`, the instance is open to anyone who can reach it.

### Room Persistence

Rooms are stored in SQLite at `$DATA_DIR/watchparty.db` (default `./data`). Back it up by copying the directory.

### TURN relay (optional)

Screen and file sharing are peer-to-peer. To relay them when a direct connection fails, create a Cloudflare Realtime TURN key and set `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`. Without them, only STUN is used.

## Tech

- React
- TypeScript
- Node.js
- SQLite (`node:sqlite`)
- Docker
