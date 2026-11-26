# Room page (`/watch/:roomId`)

`App.tsx` is a thin layout. State and behavior live in hooks, pure logic lives in `logic/` with unit tests. The room
shell (top bar, sidebar, bottom sheet, settings) is the Phase 4 redesign and lives in `shell/`; the player is in
`player/` (re-exported from `PlayerArea.tsx`), the source picker in `picker/` (picker work).

## Data flow

```
useRoom(roomId)                          hooks/useRoom.ts: composes everything below
 ├ useStore(createInitialRoomState)      one RoomState (roomState.ts), get() is synchronous
 ├ useRoomSocket                         socket.io connection, auth handling, typed CMD:* emitters (cmd)
 ├ usePlayer                             HTML.ts / YouTube.ts, play/pause/seek/rate/loop, drift sync, fullscreen, CMD:ts loop (+ CMD:duration)
 ├ useConvert                            probe → direct/convert/fail per device (auto-convert), audio tracks
 ├ useShare                              screen + file share over WebRTC (/iceServers), signalSS
 ├ useChat / usePlaylist / useSubtitles  REC:* handlers and actions for each feature
 └ handlers                              maps every server event to the hooks above (REC:host loads media)
```

- **Store** (`hooks/useStore.ts`): socket handlers, timers and player callbacks run outside React's render, so they
  read state with `store.get()` (always current, even right after `store.set()`) instead of a stale closure. Rendering
  uses the `state` snapshot. `store.set(patch)` shallow-merges and re-renders.
- **Socket** (`socketEvents.ts`): `ServerToClientEvents`/`ClientToServerEvents` type every event. Names and payloads
  match `server/room.ts` exactly. Use `room.cmd.*` (e.g. `cmd.play()`, `cmd.setMedia(url)`, `cmd.sendChat(msg)`) and
  never emit raw strings. Child components get `cmd` (or one function from it), not the socket.
- **Auth**: `useRoomSocket` handles `connect_error: "unauthorized"` by calling `notifyUnauthorized()`, which sends the
  app back to the login form (`AuthGate`).
- **Player**: `player.current()` is the active `Player` (YouTube iframe or `<video id="leftVideo">`). `local*` actions
  only affect this device, `room*` actions also tell the room. Hls.js and dash.js are imported lazily in `onHost`.
- **Share state** (`useShare.ts`, `ShareSession`): peer connections and the local stream are mutable, not React
  state. `state.isPublishing` drives the UI.

## Files

| File                                      | What                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `App.tsx`                                 | Layout: CSS grid (top bar / stage / sidebar), phone layout with the bottom sheet             |
| `RoomMessages.tsx`                        | Share/subtitle modals, loading + error overlays, reconnecting banner, error/success toasts   |
| `PlayerArea.tsx`                          | Re-exports `PlayerArea` and `SyncIndicator` from `player/`                                   |
| `player/PlayerArea.tsx`                   | The player: media, cues, gestures, auto-hide, keyboard, OSD, chat overlay, quick chat        |
| `player/ControlBar.tsx`                   | Overlay controls + speed menu; `SeekBar.tsx`, `SubtitlesMenu.tsx`, `PlayerMenu.tsx` (portal) |
| `player/SyncIndicator.tsx`                | Sync pill + popover (per-person drift, "Resync me"); `variant="mini"` in the control bar     |
| `player/SubtitleCues.tsx`                 | Renders the active cues of the selected (hidden-mode) TextTrack with the device's style      |
| `player/ChatOverlay.tsx`, `QuickChat.tsx` | Chat bubbles over the video (8 s + 600 ms fade, max 4) and the `c` input                     |
| `player/formatChat.ts`                    | `describeChatCommand(cmd, msg)`: system line text incl. `subtitleOffset`, `roomSettings`     |
| `ui/RoomUi.tsx`                           | `useRoomUi()`: picker open, sidebar collapsed, chat overlay, settings modal                  |
| `ui/toast.tsx`                            | `toast(message, {tone, action})`                                                             |
| `shell/RoomTopBar.tsx`                    | Logo, room name, picker trigger, sync slot, avatars, invite, sidebar toggle, ⋯ menu          |
| `shell/SidePanels.tsx`                    | Chat / Queue / People tabs (shared by the sidebar and the bottom sheet), unread badge        |
| `shell/QueuePanel.tsx`                    | Now playing + playlist: drag to reorder, play now/next, move, remove, empty state            |
| `shell/PeoplePanel.tsx`                   | Invite box, roster (avatar colour, sharing, playback drift), rename popover                  |
| `shell/SidebarResize.tsx`                 | Drag/keyboard resize of the desktop sidebar (`sidebarWidth.ts`: clamp + localStorage)        |
| `shell/BottomSheet.tsx`                   | Phone sheet snap points min/docked/full (`sheet.ts`: pure snap logic)                        |
| `shell/NowPlayingStrip.tsx`               | Phone: title + "Change" under the video                                                      |
| `shell/RoomSettingsModal.tsx`             | Per-device + room-wide settings (title, ready check, next-episode card)                      |
| `shell/shortcuts.ts`                      | `/` opens the picker; `wp:show-shortcuts` event for the shortcuts overlay                    |
| `shell/invite.ts`, `roomInfo.ts`          | Copy invite link + toast; short media titles, per-person playback state                      |
| `roomState.ts`                            | `RoomState` type and initial values (incl. localStorage-backed prefs)                        |
| `socketEvents.ts`                         | Typed socket events and `createRoomCommands`                                                 |
| `Player.ts`, `HTML.ts`, `YouTube.ts`      | Player implementations (HTML.ts: subtitle track selection + cue re-timing)                   |
| `logic/sync.ts`                           | Leader time, drift controller (`nextDriftAction`), sync status, live-edge offsets, seeks     |
| `logic/subtitles.ts`                      | Offset step/format/normalize, `retimeCues`, SRT → WebVTT, subtitle style sizes               |
| `logic/autoHide.ts`                       | `IdleTimer`: 2.5 s auto-hide with holds (paused, hover, menu, quick chat)                    |
| `logic/gestures.ts`                       | Tap zones (40/20/40) and `TapDetector` (single vs double tap/click)                          |
| `logic/shortcuts.ts`                      | `resolveShortcut(event)` (ignored while typing / in modals) and the overlay's rows           |
| `logic/media.ts`                          | `classifyMedia(url)`, display names, sharer lookup                                           |
| `logic/chat.ts`                           | Immutable chat updates (append with 100 cap, reactions), chat sound rule                     |
| `logic/playlist.ts`                       | What happens when a video ends (loop / playlist next / next fileIndex)                       |
| `logic/durationReport.ts`                 | When to send `CMD:duration` (watch history's finished flag): media change or every 30 s      |
| `logic/readyCheck.ts`                     | Ready check: buffered-ahead readiness, stall debounce, pill/toast text (`useReadyCheck`)     |
| `logic/sdp.ts`                            | SDP tweaks for WebRTC (Safari offer fix, stereo/multichannel Opus)                           |
| `hooks/useRoom.test.ts`                   | Integration test with a fake socket: connect, auth, REC:* events, sync rate, CMD:* emits     |

## Room shell (Phase 4)

- **Desktop:** `App.module.css` grid: top bar (`--wp-topbar-h`, 52px) over the black stage, plus the sidebar column
  (`--room-sidebar-w`). The width is clamped to 280–560px, remembered in `localStorage` (`wp-sidebar-width`), and
  shrunk on narrow windows so the video keeps 400px. Collapsing animates the column to 0 (`useRoomUi().toggleSidebar`).
- **Phone (≤ 768px):** top bar 48px, 16:9 stage, `NowPlayingStrip`, then the sidebar becomes a fixed bottom sheet. Its
  height comes from the snap point (`sheet.ts`); drag the handle, tap it to toggle docked/full, or use ↑/↓.
- The panels stay at the same place in the React tree at every breakpoint, so `Chat` (and `room.chatRef`) keeps its
  state. `SidePanels` sets `state.currentTab` to the visible tab or `"none"` so `useChat` counts unread messages.
- Breakpoints: ≤ 1100px hides the avatars, ≤ 960px turns Invite into an icon, ≤ 768px is the phone layout.
- **Slots for the other workstreams:** `{/* SLOT(B): <SyncIndicator room={room} /> */}` in `RoomTopBar.tsx` (start of
  the right-hand group) and `{/* SLOT(C): <SourcePicker room={room} /> */}` at the end of `RoomLayout` in `App.tsx`.
  The picker opens via `useRoomUi().openPicker()` (top bar trigger, `/`, phone "Change"); the Queue tab's "Add to
  queue" uses `openPicker({ mode: "queue" })`.
- **Room settings (wave 2):** `state.roomSettings` (`RoomSettings`: `title`, `readyCheck`, `nextEpisodeOffset`) comes
  from `REC:roomSettings` (on connect and after every change) and starts as `DEFAULT_ROOM_SETTINGS` (`roomState.ts`).
  Change it with `room.cmd.setRoomSettings(patch)`; the server normalizes, broadcasts to everyone and posts a debounced
  `roomSettings` chat line. The settings modal sends the title on blur/Enter, the ready check switch immediately and the
  next-episode seconds 500 ms after the last change. `roomDisplayName(roomId, title)` names the room in the top bar,
  the tab title and recent rooms. Ready check and the next-episode card read `state.roomSettings` directly.

## Source picker (`picker/`, Phase 4 + PLAN 6c)

- Mount once inside `RoomUiProvider`: `<SourcePicker room={room} />`. It renders the palette when
  `useRoomUi().pickerOpen` is true, shows the room-wide playback-issue toasts and fills `state.subtitleTracks`
  (auto subtitles, `useAutoSubtitles`) from `/addon/subtitles` while `state.videoMeta` is set.
- `useRoomUi()`: `openPicker(opts?)` (`{mode: "queue"}` makes Enter/primary buttons add to the queue; a click event
  is ignored, so `onClick={ui.openPicker}` is fine), `openPickerAt({kind: "search", query} | {kind: "streams",
videoMeta})` ("Pick another"), `pickerTarget`, `pickerMode`.
- `PickerPalette.tsx` is the testable view (props: `actions: PickerActions`, `target`, `mode`). `SourcePicker.tsx`
  maps the actions onto the room (`usePickerActions`): links use `cmd.setMedia` / `playlist.add` like the old toolbar,
  share actions open the existing `ScreenShareModal` / `FileShareModal` via `store.set`.
- Levels (a frame stack): root (empty state: share actions + recent sources; pasted link: type badge + Play now /
  Add to queue; text: chips All / Movies & Shows / YouTube, poster grid + YouTube list) → title (movie: header +
  streams; series/anime: season selector + episodes) → episode (header + subtitles found + streams). Esc goes back one
  level then closes, Backspace in an empty input goes back, breadcrumbs are buttons.
- Keyboard model (`options.tsx`): each row registers with `useOption(id, {primary, secondary})`, the input keeps
  focus with `aria-activedescendant`, ↑/↓ follow DOM order, Enter = primary, Shift+Enter = secondary.
- `api/addons.ts` is the typed `/addon/*` + `/youtube` client (AbortSignal everywhere, `createDebouncedSearch`
  250 ms, 503 `aiostreams_not_configured` hides Movies & Shows for the session). `useLoad.ts` caches results 5 min.
- **Playing a stream** hosts `withDisplayName(stream.url, "Title · S02E04")` (`logic/media.ts`: the name rides in
  the URL fragment, so `getMediaDisplayName`/`shortMediaTitle` show it and never the credential-bearing URL) and sends
  `cmd.setVideoMeta(url, meta)`. Queue items carry `{name, img, meta}` and restore the meta when played. Recent
  sources (`wp-recent-sources`) store AIOStreams picks as title/episode, never the playback URL.

## Auto-convert (PLAN 6c)

- `useConvert.playUrl(src, time)` handles every direct link (`REC:host`): with the per-device **"Auto-convert when
  needed"** setting on (`state.convertEnabled`, `localStorage` `wp-auto-convert`, default on), it calls
  `probeMedia(url)` (`utils/clientTranscode.ts`: mediabunny reads the container/tracks via range requests and
  measures `canPlayType` / `MediaSource.isTypeSupported` / WebCodecs decode+encode per track), then
  `decidePlayback()` (`logic/playback.ts`, pure) picks **direct**, **convert** (copy what plays, re-encode the rest,
  with `chooseAudioTrack`: original language, AAC/Opus > AC-3/E-AC-3 > DTS/TrueHD, no commentary) or **fail**.
  If the probe can't read the URL (no CORS, timeout) it plays directly. A decode error during direct play falls back
  to conversion when possible. With the setting off it plays directly and only reports failures.
- `state.playback` is the decision; `room.convert.status` (`getConvertStatus`) is `{label: "Converting · 34%
buffered", progress, heavy, reason}` or null; `picker/ConvertStatus.tsx` renders it as a pill for the player.
- Failures send `cmd.reportPlaybackIssue(reason)`; every client toasts "Alex can't play this stream: …" with
  "Pick another" (opens the picker on the same title's streams via `videoMeta`) and, for viewers whose device can play
  it, "Share converted stream" (`share.startUrlShare`: converts once and publishes it over the file-share pipeline,
  then re-attaches the `videoMeta` to the `fileshare://` media).

## Player (Phase 4 + PLAN 6a/6b/6d)

- `PlayerArea` is `position: absolute; inset: 0; container-type: size` inside the stage and is the **fullscreen
  target** (`player.toggleFullscreen()`; iOS without element fullscreen falls back to `webkitEnterFullscreen` on the
  video; phones lock to landscape where supported). Menus portal into it (phone outside fullscreen: bottom sheet in the
  body), so controls, menus, chat bubbles and quick chat work in fullscreen.
- Controls read the player through `usePlaybackState` (`<video>` events; YouTube polled every 250 ms). They auto-hide
  with the cursor after 2.5 s while playing (`IdleTimer`), and stay while paused, hovered, or a menu/quick chat is open.
- **Click** on the video = play/pause for everyone (others get "Alex paused": `REC:play`/`REC:pause` carry a
  `PlaybackActor`), **double-click** = fullscreen. Touch: tap = show/hide controls, double-tap left/right = ∓10 s with
  a ripple, centre = fullscreen. Speed and loop are room-wide (`CMD:playbackRate`, `CMD:loop`).
- Keys (window listener, ignored while typing or in a modal): space/k, ←/→, ↑/↓, m, f, c (quick chat in fullscreen or
  with the sidebar collapsed, otherwise `chatRef.current.focusInput()`), `[`/`]`, `?` (also `wp:show-shortcuts`).
- **Subtitles:** the selected TextTrack is kept in `hidden` mode and `SubtitleCues` draws the active cues (size S–XL in
  container units, background none/shadow/box, per device in `localStorage` `wp-subtitle-style`). The offset re-times
  cues from their original times (`retimeCues`), so nothing is re-downloaded. "Everyone" sends `CMD:subtitleOffset`
  (server: validated, ±30 s, 0.05 s steps, saved per video in `subtitle_offsets`, restored with `REC:host`
  `subtitleOffset`, chat line after 1.5 s idle); "Just me" is `state.localSubtitleOffset`. Agent C's auto subtitles go
  in `state.subtitleTracks` (`SubtitleTrackOption[]`, shown first with an Auto badge; picking one sets the room
  subtitle). The converter's audio tracks show in the same menu.
- **Sync (6d):** `usePlayer.onTsMap` runs `nextDriftAction` on every `REC:tsMap`: drift under 2 s nudges the playback
  rate proportionally (0.95–1.05× the room speed, start at 0.3 s, stop under 0.1 s), more seeks (3 s cooldown).
  YouTube only uses rates from `getAvailablePlaybackRates()` and otherwise seeks from 1 s. `state.syncStatus` is
  `in-sync` / `catching-up` (seconds behind) / `buffering` / `reconnecting`; `SyncIndicator({ room })` shows it.

## Ready check (PLAN 6d)

- Only while `state.roomSettings.readyCheck` is on, `hooks/useReadyCheck.ts` polls this device every 500 ms and sends `cmd.reportReadyState({ready, buffering, time})`
  only when `ready`/`buffering` change (and again on a new video, reconnect or when a check starts). Ready = no media
  / share / live / can't play, or ≥ 6 s buffered ahead (stays ready down to 2 s), buffered to the end, or
  `readyState >= HAVE_ENOUGH_DATA` (not while converting: the converter's MediaSource buffer is measured instead).
  YouTube uses its BUFFERING state and loaded fraction. `buffering` = stalled > 1.5 s while the room plays.
- The server (`server/readyCheck.ts`) decides when to pause/resume; `REC:readyCheck` lands in `state.readyCheck`.
  `player/ReadyCheckPill.tsx` ("Waiting for Sam…", avatars, Resume now → `room.readyCheck.skip()`) sits on the
  player, the People tab shows "Buffering…" for whoever is waited for, and toasts come from
  `describeReadyCheckChange`. The pause has no actor, so it doesn't show "Alex paused"; drift sync is off while paused.

## Notes for the redesign

- Build new views on `const room = useRoom(roomId)`: everything is on `room.state`, `room.player`, `room.cmd`,
  `room.share`, `room.convert`, `room.playlist`, `room.subtitles`, `room.chatRef`.
- The player depends on the element ids `leftVideo`/`leftYt` (`VIDEO_ELEMENT_ID`/`YOUTUBE_ELEMENT_ID` in
  `usePlayer.ts`). Keep them, or switch `HTML.ts` to a ref.
