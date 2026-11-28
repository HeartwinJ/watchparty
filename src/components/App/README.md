# Room page (`/watch/:roomId`)

`App.tsx` is a thin layout. State and behavior live in hooks, pure logic lives in `logic/` with unit tests. The room
shell (top bar, sidebar, bottom sheet, settings) lives in `shell/`; the player is in
`player/` (re-exported from `PlayerArea.tsx`), the source picker in `picker/`.

## Data flow

```
useRoom(roomId)                          hooks/useRoom.ts: composes everything below
 ├ useStore(createInitialRoomState)      one RoomState (roomState.ts), get() is synchronous
 ├ useRoomSocket                         socket.io connection, auth handling, typed CMD:* emitters (cmd)
 ├ usePlayer                             HTML.ts / YouTube.ts, play/pause/seek/rate/loop, drift sync, fullscreen, CMD:ts loop (+ CMD:duration)
 ├ useConvert                            probe → direct/convert/fail per device (auto-convert), audio tracks
 ├ useShare                              screen + file share over WebRTC (/iceServers), signalSS
 ├ useChat / usePlaylist / useSubtitles  REC:* handlers and actions for each feature
 ├ useSubtitleSync (subsync/)            subtitle auto-sync: the wand + room claims
 ├ useReadyCheck                         ready-state polling/reporting, REC:readyCheck
 ├ useCall (call/)                       voice/video call: membership, mic, camera, peer connections, speaking, ducking
 └ handlers                              maps every server event to the hooks above (REC:host loads media)
```

`useNextEpisode` isn't part of `useRoom`: it runs inside `NextEpisodeCard`.

- **Store** (`hooks/useStore.ts`): socket handlers, timers and player callbacks run outside React's render, so they
  read state with `store.get()` (always current, even right after `store.set()`) instead of a stale closure. Rendering
  uses the `state` snapshot. `store.set(patch)` shallow-merges and re-renders.
- **Socket** (`socketEvents.ts`): `ServerToClientEvents`/`ClientToServerEvents` type every event. Names and payloads
  match `server/room.ts` exactly. Use `room.cmd.*` (e.g. `cmd.play()`, `cmd.setMedia(url)`, `cmd.sendChat(msg)`) and
  never emit raw strings. Child components get `cmd` (or one function from it), not the socket.
- **Auth**: `useRoomSocket` handles `connect_error: "unauthorized"` by calling `notifyUnauthorized()`; `AuthGate`
  sends owners to the instance login and guests to the room password screen. `useAuth().role` is `"owner"` or
  `"guest"` (a guest has access to this room only). Guests can do everything in the room except manage it: no
  room-wide settings, room password or "Remove from room" (the server refuses those commands too), no Home link,
  "Leave room" or "Log out". `kicked` and `REC:accessRevoked` call `useAuth().roomAccessLost(roomId, reason)` for
  guests (owners who are kicked go to `/`).
- **Stop video** (anyone): ⋯ menu → "Stop video" or the picker's "Stop video" row → `room.cmd.stopVideo()`, an empty
  `CMD:host` (the same server path as ending a share). Everyone's player clears, the chat says "stopped the video" and
  the queue is untouched. Hidden for screen/file shares, which only the sharer ends ("Stop sharing").
- **Deleting the room** (owners): ⋯ menu → "Delete room" → `DeleteRoomModal` (`components/DeleteRoomModal/`) →
  `room.cmd.deleteRoom()`. `REC:roomDeleted {by}` removes the room from this device's recent rooms; the owner who
  deleted it goes Home, everyone else gets `state.roomDeleted` and `App` renders `StatusPage/RoomDeleted` instead of
  the room. Home's recent rooms have the same delete (× → modal → `deleteRoom()` in `utils/rooms.ts`,
  `DELETE /rooms/:roomId`).
- **Chat lines without a person** (`id: ""`, `isPersonlessLine`): the server's `nowPlaying` lines for automatic video
  changes ("Now playing Spring (from the queue)", "… (next episode)"). `Chat` and `ChatOverlay` show them without a
  name, avatar or reaction button.
- **Room password**: `state.roomAccess` is the latest `REC:roomAccess` (`{enabled, password?}`; only owners ever get
  `password`, null until it arrives). Owners change it with `room.cmd.setRoomPassword({action: "regenerate"} |
{action: "set", password} | {action: "enable", enabled})` and remove people with `room.cmd.kickUser(clientId)`.
  The invite UI (`shell/invite.ts`: `inviteLink()`, `inviteLinkWithPassword(pw)` → `/watch/<room>#pw=<pw>`,
  `roomPassword(access)`) offers "Copy invite link" and, for owners while a password is required, "Copy link with
  password" (top bar Invite menu and the People panel).
- **Player**: `player.current()` is the active `Player` (YouTube iframe or `<video id="leftVideo">`). `local*` actions
  only affect this device, `room*` actions also tell the room. Hls.js and dash.js are imported lazily in `onHost`.
- **Share state** (`useShare.ts`, `ShareSession`): peer connections and the local stream are mutable, not React
  state. `state.isPublishing` drives the UI.

## Files

| File                                      | What                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `App.tsx`                                 | Layout: CSS grid (top bar / stage / sidebar), phone layout with the bottom sheet                                    |
| `RoomMessages.tsx`                        | Share/subtitle modals, loading + error overlays, reconnecting banner, error/success toasts                          |
| `PlayerArea.tsx`                          | Re-exports `PlayerArea` and `SyncIndicator` from `player/`                                                          |
| `player/PlayerArea.tsx`                   | The player: media, cues, gestures, auto-hide, keyboard, OSD, chat overlay/panel, quick chat, call tiles, cards      |
| `player/ControlBar.tsx`                   | Overlay controls + speed menu; `SeekBar.tsx`, `SubtitlesMenu.tsx`, `AudioMenu.tsx`, `PlayerMenu.tsx` (portal)       |
| `player/SyncIndicator.tsx`                | Sync pill + popover (per-person drift, "Resync me"); `variant="mini"` in the control bar                            |
| `player/SubtitleCues.tsx`                 | Renders the cues at the video's current time (`cuesAt`, not stale-prone `activeCues`) with the device's style       |
| `player/ChatOverlay.tsx`, `QuickChat.tsx` | Chat bubbles over the video (8 s + 600 ms fade, max 4) and the `c` input (closes after 5 s empty)                   |
| `player/ChatPanel.tsx`, `chatPanel.ts`    | The full chat over the video (fullscreen / sidebar collapsed), `useChatPanel`; pure: availability, width, unread    |
| `player/ShortcutsOverlay.tsx`             | The `?` shortcuts overlay (`ReadyCheckPill.tsx`: the ready-check pill)                                              |
| `player/use*.ts`                          | `usePlaybackState` (control state), `useTextTracks`, `useSubtitleStyle` (per device), `useChatPanel`                |
| `player/quickChatIdle.ts`                 | Quick chat's 5 s empty auto-close (pure)                                                                            |
| `player/formatChat.ts`                    | `describeChatCommand(cmd, msg)`: system line text incl. `subtitleOffset`, `roomSettings`, `nowPlaying`              |
| `ui/RoomUi.tsx`                           | `useRoomUi()`: picker open, sidebar collapsed, chat overlay, settings modal                                         |
| `ui/toast.tsx`                            | `toast(message, {tone, action})`                                                                                    |
| `shell/RoomTopBar.tsx`                    | Logo, room name, picker trigger, sync slot, avatars, invite, sidebar toggle, ⋯ menu                                 |
| `shell/SidePanels.tsx`                    | Chat / Queue / People tabs (shared by the sidebar and the bottom sheet), unread badge                               |
| `shell/QueuePanel.tsx`                    | Now playing + playlist: drag to reorder, play now/next, move, remove, empty state                                   |
| `shell/PeoplePanel.tsx`                   | Invite box, roster (+ voice call icons, speaking ring), rename popover, owners: call moderation, "Remove from room" |
| `shell/SidebarResize.tsx`                 | Drag/keyboard resize of the desktop sidebar (`sidebarWidth.ts`: clamp + localStorage)                               |
| `shell/BottomSheet.tsx`                   | Phone sheet snap points min/docked/full (`sheet.ts`: pure snap logic)                                               |
| `shell/NowPlayingStrip.tsx`               | Phone: title + "Change" under the video                                                                             |
| `shell/RoomSettingsModal.tsx`             | Per-device + room-wide settings (owners: title, ready check, auto-sync, next-episode, skip intro, room password)    |
| `shell/shortcuts.ts`                      | `/` opens the picker; `wp:show-shortcuts` event for the shortcuts overlay                                           |
| `shell/invite.ts`, `roomInfo.ts`          | Invite links (+ `#pw=`), copy + toast; short media titles, per-person playback state                                |
| `shell/roomSettingsForm.ts`               | Pure helpers for the settings form (title, next-episode seconds, room password, skip intro chips/custom)            |
| `hooks/`                                  | `useRoom` and the hooks it composes (see Data flow), `useStore`, `useReadyCheck`                                    |
| `picker/`                                 | Source picker (see below)                                                                                           |
| `roomState.ts`                            | `RoomState` type and initial values (incl. localStorage-backed prefs)                                               |
| `socketEvents.ts`                         | Typed socket events and `createRoomCommands`                                                                        |
| `Player.ts`, `HTML.ts`, `YouTube.ts`      | Player implementations (HTML.ts: subtitle track selection + cue re-timing)                                          |
| `audioBoost.ts`                           | Volume boost / Night mode through Web Audio (`AudioBoost`, used by HTML.ts); see Player                             |
| `logic/sync.ts`                           | Leader time, drift controller (`nextDriftAction`), sync status, live-edge offsets, seeks                            |
| `subtitleSearch/`                         | "Search subtitles…" modal, title/episode guessing from file names, sharing a found subtitle                         |
| `logic/subtitles.ts`                      | Offset step/format/normalize, `retimeCues`, SRT → WebVTT, subtitle style sizes                                      |
| `logic/subtitleCarry.ts`                  | Keeping a viewer's subtitles on (same language) or off when the video changes to the next episode                   |
| `logic/subtitleText.ts`                   | Subtitle file decoding (UTF-8/UTF-16/Windows-1252) and clean-up: mojibake repair (`â™ª` → `♪`), ASS tags stripped   |
| `logic/autoHide.ts`                       | `IdleTimer`: 2.5 s auto-hide with holds (paused, hover, menu, quick chat, chat panel)                               |
| `logic/gestures.ts`                       | Tap zones (40/20/40) and `TapDetector` (single vs double tap/click)                                                 |
| `logic/shortcuts.ts`                      | `resolveShortcut(event)` (ignored while typing / in modals) and the overlay's rows                                  |
| `logic/media.ts`                          | `classifyMedia(url)`, display names, sharer lookup                                                                  |
| `logic/chat.ts`                           | Immutable chat updates (append with 100 cap, reactions), chat sound rule                                            |
| `logic/playlist.ts`                       | What happens when a video ends (loop / playlist next / next fileIndex)                                              |
| `logic/playback.ts`                       | `decidePlayback()`: direct / convert / fail per device, `chooseAudioTrack` (auto-convert)                           |
| `logic/durationReport.ts`                 | When to send `CMD:duration` (watch history's finished flag): media change or every 30 s                             |
| `logic/readyCheck.ts`                     | Ready check: buffered-ahead readiness, stall tracking (`StallTracker`), pill/toast text                             |
| `nextEpisode/`                            | "Up next" card over the player, `useNextEpisode` (offers + toasts), pure logic                                      |
| `introSkip/`, `logic/introSkip.ts`        | "Skipped intro (1:30) · Watch from start" notice over the player; m:ss format, presets, when the notice shows       |
| `subsync/`                                | Subtitle auto-sync: signal processing, worker, `useSubtitleSync`, the wand (`AutoSyncButton`)                       |
| `logic/sdp.ts`                            | SDP tweaks for WebRTC (Safari offer fix, stereo/multichannel Opus)                                                  |
| `call/`                                   | Voice/video call: `useCall`, `CallControl` (top bar), `CallPanel`, `VideoTiles`, transport, pure logic (see below)  |
| `hooks/useRoom.test.ts`                   | Integration test with a fake socket: connect, auth, REC:* events, sync rate, CMD:* emits                            |
| `roomRoles.test.tsx`                      | Owner vs guest room page: settings, room password, remove person, invite links                                      |

## Room shell

- **Desktop:** `App.module.css` grid: top bar (`--wp-topbar-h`, 52px) over the black stage, plus the sidebar column
  (`--room-sidebar-w`). The width is clamped to 280–560px, remembered in `localStorage` (`wp-sidebar-width`), and
  shrunk on narrow windows so the video keeps 400px. Collapsing animates the column to 0 (`useRoomUi().toggleSidebar`).
- **Phone (≤ 768px):** top bar 48px, 16:9 stage, `NowPlayingStrip`, then the sidebar becomes a fixed bottom sheet. Its
  height comes from the snap point (`sheet.ts`); drag the handle, tap it to toggle docked/full, or use ↑/↓.
- The panels stay at the same place in the React tree at every breakpoint, so `Chat` (and `room.chatRef`) keeps its
  state. `SidePanels` sets `state.currentTab` to the visible tab or `"none"` so `useChat` counts unread messages.
- Breakpoints: ≤ 1100px hides the avatars, ≤ 960px turns Invite into an icon, ≤ 768px is the phone layout.
- `<SyncIndicator room={room} />` sits at the start of the top bar's right-hand group (`RoomTopBar.tsx`) and
  `<SourcePicker room={room} />` at the end of `RoomLayout` in `App.tsx`. The picker opens via `useRoomUi().openPicker()` (top bar trigger, `/`, phone "Change"); the Queue tab's "Add to
  queue" uses `openPicker({ mode: "queue" })`.
- **Room settings:** `state.roomSettings` (`RoomSettings`: `title`, `readyCheck`, `nextEpisodeOffset`, `autoSyncSubtitles`, `skipIntro`) comes
  from `REC:roomSettings` (on connect and after every change) and starts as `DEFAULT_ROOM_SETTINGS` (`roomState.ts`).
  Change it with `room.cmd.setRoomSettings(patch)`; the server normalizes, broadcasts to everyone and posts a debounced
  `roomSettings` chat line. The settings modal sends the title on blur/Enter, the ready check switch immediately and the
  next-episode seconds 500 ms after the last change. Skip intro (`SkipIntroSetting`) is a row of chips (Off, 15s, 30s,
  45s, 1:00, 1:30, 2:00) sent on click, plus Custom with a seconds input (1–600, shown as m:ss) sent like the offset;
  `roomSettingsForm.ts` has `skipIntroToSend`/`skipIntroChip`. `roomDisplayName(roomId, title)` names the room in the top bar,
  the tab title and recent rooms. Ready check and the next-episode card read `state.roomSettings` directly.
  The "Everyone in this room" section (and its `RoomPasswordSettings`: masked password with show/copy, Regenerate,
  Set your own, "Require a password" switch) is only rendered for owners; guests see a note (plus the current skip
  intro, read-only).

## Source picker (`picker/`)

- Mount once inside `RoomUiProvider`: `<SourcePicker room={room} />`. It renders the palette when
  `useRoomUi().pickerOpen` is true, shows the room-wide playback-issue toasts and fills `state.subtitleTracks`
  (auto subtitles, `useAutoSubtitles`) from `/addon/subtitles` while `state.videoMeta` is set.
- `useRoomUi()`: `openPicker(opts?)` (`{mode: "queue"}` makes Enter/primary buttons add to the queue; a click event
  is ignored, so `onClick={ui.openPicker}` is fine), `openPickerAt({kind: "search", query} | {kind: "streams",
videoMeta})` ("Pick another"), `pickerTarget`, `pickerMode`.
- `PickerPalette.tsx` is the testable view (props: `actions: PickerActions`, `target`, `mode`). `SourcePicker.tsx`
  maps the actions onto the room (`usePickerActions`): links use `cmd.setMedia` / `playlist.add` like the old toolbar,
  share actions open the existing `ScreenShareModal` / `FileShareModal` via `store.set`.
- Levels (a frame stack): root (empty state: "Stop video" while a non-share video plays (not in queue mode), share
  actions + recent sources; pasted link: type badge + Play now /
  Add to queue; text: chips All / Movies & Shows / YouTube, poster grid + YouTube list) → title (movie: header +
  streams; series/anime: season selector + episodes) → episode (header + subtitles found + streams). Esc goes back one
  level then closes, Backspace in an empty input goes back, breadcrumbs are buttons.
- Keyboard model (`options.tsx`): each row registers with `useOption(id, {primary, secondary})`, the input keeps
  focus with `aria-activedescendant`, ↑/↓ follow DOM order, Enter = primary, Shift+Enter = secondary.
- `api/addons.ts` is the typed `/addon/*` + `/youtube` client (AbortSignal everywhere, `createDebouncedSearch`
  250 ms; `GET /addon/status` `{streams: false}` or a 503 `aiostreams_not_configured` hides Movies & Shows for the
  session, since title search itself works without AIOStreams). `useLoad.ts` caches results 5 min.
- **Playing a stream** hosts `withDisplayName(stream.url, "Title · S02E04")` (`logic/media.ts`: the name rides in
  the URL fragment, so `getMediaDisplayName`/`shortMediaTitle` show it and never the credential-bearing URL) and sends
  `cmd.setVideoMeta(url, meta)`. Queue items carry `{name, img, meta}` and restore the meta when played. Recent
  sources (`wp-recent-sources`) store AIOStreams picks as title/episode, never the playback URL.

## Auto-convert

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

## Next episode

- Server-authoritative (`server/nextEpisodeController.ts`). `useNextEpisode` sends `cmd.nextEpisode({action: "offer",
url, time, duration})` every 5 s while this player is within `state.roomSettings.nextEpisodeOffset` seconds of the end
  of an AIOStreams episode with an empty queue and no loop (`shouldOfferNextEpisode`); `usePlayer.onVideoEnded` sends
  `{action: "ended", url}`. `state.nextEpisode` is the latest `REC:nextEpisode` (+ `at`).
- `NextEpisodeCard` (mounted in `PlayerArea`, so it shows in fullscreen) renders `offered`: thumbnail/poster, "Up next ·
  S01E03 · Title", the countdown (`startAt - this player's currentTime`, so it pauses with the room) and Play now /
  Cancel (room-wide). `cancelled`/`starting`/`failed` become a toast + the player OSD; `failed` offers "Open picker"
  (on the next episode's streams when it's known). No Esc shortcut: Esc already exits fullscreen/menus.
- The card never gets a URL: the server keeps the stream and hosts it with `withDisplayName` + `videoMeta`.

## Skip intro

- Server-authoritative (`server/introSkip.ts`): with `roomSettings.skipIntro` set, a new video's `REC:host` already
  carries `videoTS = skipIntro`, so the normal load path (`setSrcAndTime`/`playUrl(src, time)`, the `canplay` join
  seek via `getJoinSeekTarget`) starts everyone there; there is no client-side skipping.
- `REC:introSkip {seconds}` follows `REC:host` when a skip happened; `useRoom` stores it as `state.introSkip` (+ `at`)
  and clears it on every `REC:host`. `IntroSkipNotice` (mounted in `PlayerArea`, bottom-right above the controls, so
  it shows in fullscreen) shows "Skipped intro (1:30) · Watch from start" for 10 s (`showIntroSkipNotice`: not for
  live streams). The button is `player.roomSeek(0)`, a normal seek with a chat line; the server then sends
  `REC:introSkip null` to everyone, which hides it.
- Too short for the skip (a `CMD:duration` under 5 min or under 2× the skip, while nobody has played/paused/seeked
  and the room is within 30 s of the skip point): the server clears `tsMap` and sends `REC:introSkip null`,
  `REC:seek 0` and, if the room is playing, `REC:play`. The undo often reaches players that are still loading: the
  `canplay` join seek starts from `roomPositionRef` (REC:host's start, replaced by every `REC:seek`), so it lands at 0
  and not past the end. `state.introSkipStart` (the skip point, kept after the notice is hidden, cleared by any seek
  or video change) makes `onVideoEnded` ignore the "ended" of a start past the end, and so does a player that's no
  longer near its end (an "ended" queued before the join seek moved it back).

## Player

- `PlayerArea` is `position: absolute; inset: 0; container-type: size` inside the stage and is the **fullscreen
  target** (`player.toggleFullscreen()`; iOS without element fullscreen falls back to `webkitEnterFullscreen` on the
  video; phones lock to landscape where supported). Menus portal into it (phone outside fullscreen: bottom sheet in the
  body), so controls, menus, chat bubbles and quick chat work in fullscreen.
- Controls read the player through `usePlaybackState` (`<video>` events; YouTube polled every 250 ms). They auto-hide
  with the cursor after 2.5 s while playing (`IdleTimer`), and stay while paused, hovered, or a menu/quick chat is open.
- **Click** on the video = play/pause for everyone (others get "Alex paused": `REC:play`/`REC:pause` carry a
  `PlaybackActor`), **double-click** = fullscreen. Touch: tap = show/hide controls, double-tap left/right = ∓10 s with
  a ripple, centre = fullscreen. Speed and loop are room-wide (`CMD:playbackRate`, `CMD:loop`).
- Keys (window listener, ignored while typing, in a modal or inside a `data-no-shortcuts` area such as the chat panel;
  Esc always reaches it): space/k (Space toggles on release; held for 300 ms while playing a video with a duration it
  sets the room to 2× via `CMD:playbackRate (2, {hold: true})` and restores the previous rate on release or window
  blur, `logic/spaceHold.ts`; hold changes post no chat line), ←/→, ↑/↓, m (the mic while in a voice call), v (the camera, only in a call), f, c
  (the open chat panel's input, else quick chat in fullscreen or with the sidebar collapsed, else
  `chatRef.current.focusInput()`; `chatKeyTarget`), Shift+C (the chat panel), `[`/`]`, `?` (also `wp:show-shortcuts`).
- **Quick chat** (`QuickChat.tsx`, `c`): a one-line input over the video. Enter sends and closes it, and it closes on blur when empty; Esc closes it
  outside fullscreen (in fullscreen the browser takes Esc and exits fullscreen). Backspace in the already empty input
  closes it too (not the Backspace that deletes the last character, not a held-down repeat, not with the emoji picker
  open). It also closes by itself after
  **5 s empty** (`quickChatIdle.ts`, pure): the countdown starts when it opens and again whenever the input becomes
  empty, and any text (not just spaces) cancels it. A small ring next to the input empties over those 5 s (`aria-hidden`; a still ring
  with reduced motion) and is hidden while there's text. The bar shows only an Enter hint. The emoji button ("Insert
  emoji") opens the Chat's emoji-mart picker (`Chat/EmojiPicker.tsx`), portaled into the player container (the
  fullscreen element) above the bar; it shrinks to fit short players and shows 7 per row on phones. Picks go in at the
  caret (replacing a selection, `insertText.ts`, pure), focus stays in the input and the picker stays open for more.
  While it's open the countdown is paused and the ring hidden; closing it with the input empty restarts the full 5 s
  (`emptySinceAfterPicker`). Esc closes only the picker first (outside fullscreen), a click outside it (but not on the
  bar) closes it, and the picker is a `data-no-shortcuts` zone, so typing in its search box never triggers player
  shortcuts. Just above the bar, the **last 3 messages** people typed (older history too, oldest first, "You" for your
  own, clamped to 2 lines, same look as the bubbles) give context for the reply: `recentConversation()`
  (`quickChatPreview.ts`, pure) skips system and personless lines, so nothing shows without conversation. It's a
  labelled `role="log"` region, updates live (a new message pushes the oldest out), and goes away with the quick chat.
  While quick chat is open the 8 s bubbles (`ChatOverlay`) aren't shown, to avoid duplicates; they resume for new
  messages when it closes. The emoji picker opens over it.
- **Chat panel** (`ChatPanel.tsx`, `useChatPanel.ts`, pure logic in `chatPanel.ts`): the real `Chat` in a translucent
  panel over the right side of the video (the video doesn't shrink), between the fullscreen title bar and the control
  bar so both stay usable. Offered where quick chat is (`fullscreen || sidebarCollapsed`, not on the phone layout's
  page, and only on players ≥ 480 px wide: `chatPanelAllowed`); 40 % of the player, 260–380 px and at most the player width − 24 px (`chatPanelWidth`).
  **Starts collapsed every time** it becomes available and closes when it stops (`chatPanelReducer`; open state isn't
  remembered). Toggle: the control bar's chat button (auto-hides with the controls) or Shift+C (which acts like `c` where the
  panel isn't offered); close: its × button,
  clicking/tapping the video (that click doesn't pause), Esc outside fullscreen (Esc closes the shortcuts overlay, then quick chat, then an open emoji or reaction picker,
  then the panel, and never while a player menu is open; in fullscreen the browser takes Esc and
  exits fullscreen, which closes it too). Opening focuses its input (not on touch screens, where that would pop the
  keyboard over the video), hides the bubbles and closes quick chat; `c` then focuses its input. The panel's `Chat` has
  its own ref (`room.chatRef` stays the sidebar's) and its own draft; it's mounted on the first open and unmounted when
  the panel stops being available. Its Mantine hover cards portal into the player (`Chat` `portalTarget`): anything
  in `document.body` is invisible in element fullscreen; the emoji pickers render inside the panel (`compact`: 7 per
  line). The glass is a `::before` layer and the panel rests at `transform: none`, because `backdrop-filter`/`transform`
  on it would trap the reaction picker's `position: fixed`. On phones `visualViewport` lifts it above the on-screen
  keyboard (`keyboardInset`; the header hides while the keyboard is up). iPhone Safari has no element fullscreen (the
  video goes native fullscreen), so there's nothing to overlay there.
- **Unread badge** on the chat button (`updateUnread`): messages people typed (not your own, not system lines such as
  paused/changed the video/now playing, which the OSD and bubbles already show, and not reactions) that arrived since
  you last had the chat on screen (the open panel, or the sidebar's chat tab outside fullscreen). History loads
  (`chatinit`, also on reconnect; `state.chatInitCount`) never count. While the panel is open the sidebar tab's
  `unreadCount` is cleared too.
- **Making room for the open panel**: `PlayerArea` sets `--wp-chat-reserve` (panel + margin, `chatPanelReserve`; 0
  while closed) and `data-chat-panel="open"`. The video tiles get it as `stripInsets({reserve: {right}})` (a strip
  dragged to the right is clamped left of the panel; the default top-left doesn't move), the next-episode card moves
  left of it, and the ready-check pill, OSD and subtitles centre on the part of the video that's left. Player menus
  (z-popover) open above it.
- **Subtitles:** the selected TextTrack is kept in `hidden` mode and `SubtitleCues` draws the cues at the current time (`cuesAt`; browsers can leave re-timed cues in `activeCues`) (size S–XL in
  container units, background none/shadow/box, per device in `localStorage` `wp-subtitle-style`). The timing re-times
  cues from their original times (`retimeCues`: original × scale + offset, the scale corrects frame-rate drift), so
  nothing is re-downloaded. ±0.1 s, typing and the slider change only the offset (`subtitles.setOffset`, keeps the
  scale); `subtitles.setTiming(offset, scale)` sets both (auto-sync, Reset clears both). The menu shows the scale under
  the value when it isn't 1 ("speed 0.959 (23.976→25 fps)", `describeScale`). "Everyone" sends `CMD:subtitleOffset`
  (offset only) or `CMD:subtitleTiming {offset, scale}`
  (server: validated, no practical limit (±24 h sanity bound), 0.05 s steps, saved per video in `subtitle_offsets`, restored with `REC:host`
  `subtitleOffset`, chat line after 1.5 s idle); "Just me" is `state.localSubtitleOffset` + `localSubtitleScale`; the room's
  scale is `state.roomSubtitleScale`. The picker's auto subtitles go
  in `state.subtitleTracks` (`SubtitleTrackOption[]`, shown first with an Auto badge; picking one sets the room
  subtitle). With more than 8 subtitles (`GROUP_THRESHOLD`) the list gets a filter box and one row per language
  (`SubtitleChoiceList.tsx`, grouping in `subtitleChoices.ts`: auto and embedded tracks with the same language name
  share a row, which folds its subtitles and is open while it holds the selected one); Search / File / URL are one
  row of buttons under the list.
- **Subtitles carry over to the next episode** (`logic/subtitleCarry.ts`, pure; `useSubtitles.captureCarry`/`applyCarry`):
  on every `REC:host`, before the old video is cleared, each device remembers whether it was showing subtitles, which
  kind (the room subtitle or a track in the file) and in which language (the room subtitle's language comes from the
  auto track it was picked from; unknown otherwise, which takes the first, preferred one). Once `REC:videoMeta` says
  the new video is the same show (same series id or IMDb id; two plain links count too) and its tracks are in
  (`PlayerArea` calls `applyCarry` as tracks and state change), it picks the same language: the room subtitle via
  `CMD:subtitle` from the new title's auto subtitles (`state.subtitleTracksFor` must be the new `videoMeta.id`; not if
  someone already set one), or an embedded track on this device only (falling back to the other kind). A viewer who
  had the room subtitle off gets the next one turned off again. One try, within 60 s, never on YouTube or when joining.
  Several viewers may send the same `CMD:subtitle`; `onSubtitle` only re-selects an already loaded room track for the
  same URL, and `HTML.loadSubtitles` drops a download that a newer load or `clearState` overtook.
- **Audio menu** (headphones button, `player/AudioMenu.tsx`; hidden for YouTube unless there are several audio
  tracks): the converter's audio tracks, then volume boost / Night mode. The button shows pressed while the boost is on.
- **Volume boost / Night mode** (`audioBoost.ts`, `player/AudioBoostSection.tsx` in the Audio menu, non-YouTube): per
  device (`state.audioBoost {level: 1|1.5|2|3, night}`, `localStorage` `wp-volume-boost`/`wp-night-mode`), set with
  `player.setAudioBoost(patch)`. `HTML.boost` (`AudioBoost`) routes the `<video>` through Web Audio: source → night
  compressor (transparent when off) → gain (level × 2 for night) → limiter (−1 dB). Element volume, mute and call
  ducking still apply before it. Nothing changes until it's turned on. Two browser rules drive the design:
  `createMediaElementSource` is permanent for the element (anything it plays afterwards must be readable by Web Audio
  or it's silent), and an `AudioContext` only runs after a gesture (we never bind while it's suspended). So: it binds
  only once real media has loaded (`readyState ≥ 1`) from a readable source (same origin, blob/MSE, `srcObject`, or a
  link loaded with `crossorigin`); while it's on, `HTML.setSrcAndTime` loads cross-origin links in CORS mode when a
  1-byte CORS request succeeds (`corsReadable`); turning it on mid-video reloads a CORS-friendly link in CORS mode at
  the same time (`reloadWithCors`); native HLS (`.m3u8` without MSE) is never boosted. When the bound element must
  play something unreadable, `onBoostBlocked` reloads the page (a fresh element; toast after the reload via
  `sessionStorage` `wp-boost-reload`); a second one within 30 s turns the boost off first, so it can't loop.
  `state.audioBoostStatus`: `off`/`on`/`idle` (no video yet)/`pending` (waits for a click or key)/`unavailable`;
  the control bar shows a badge ("200% · Night") while `on`. `e2e/volume-boost.spec.ts` covers it in Chromium
  (`?nocors` on the e2e media server drops its CORS headers). **Firefox** (and forks like Zen) leaves gaps in
  _laced_ Matroska audio (several AAC frames per block) once the element goes through Web Audio, so the audio
  stutters. While the boost is on there (`stuttersOnLacedAudio()`), `useConvert` checks MKV/WebM links whose tracks
  copy as-is with `hasLacedAudio` (`utils/matroskaLacing.ts`, a few range reads) and plays laced ones through the
  converter (a copy into fragmented MP4, reason `REPACK_REASON`): at load in `playUrl` (even with auto-convert off),
  or from the current position when the boost is turned on mid-video (`repackForBoost`, an effect in `useRoom`).
- **Search subtitles** (`subtitleSearch/`): the menu's "Search subtitles…" (non-YouTube) calls
  `room.subtitles.openSearch()` (`state.isSubtitleSearchOpen`; `SubtitleSearch` is mounted in `RoomMessages`). It looks
  and works like the source picker and is built from its parts (`palette.tsx` over `picker/SourcePicker.module.css`: opaque palette over
  the scrim, full screen on phones, search field in the header with Back/Close, breadcrumbs, a scrolling list of rows
  at a fixed height, the poster header, pill season filters, the key-hint footer; ↑/↓ move between rows, Esc goes
  back one level then closes, typing or Enter from a deeper level searches again from the top). Search (pre-filled by `guessSubtitleSearch()` in
  `guessTitle.ts` from `videoMeta`, the `#wp-name=` name or the file name) → series season/episode (guessed one
  pre-selected) → subtitles grouped by language (language chip, "Load for everyone"). AIOStreams picks open straight on their episode's subtitles (Back
  searches the title). Picking one goes through `shareSubtitleFromUrl` (`shareSubtitle.ts`: download, `POST /subtitle`)
  and `cmd.setSubtitle`, with a toast either way. "Search by file name (OpenSubtitles API)" (in the footer, also on
  phones) opens `FileNameSearch` (`subtitles.openModal()`, `state.isSubtitleModalOpen`), only when the server has
  `OPENSUBTITLES_KEY`: the same palette (`palette.tsx`, shared by both dialogs), pre-filled with the video's name and
  searched on open (`GET /searchSubtitles`), release rows with language, hearing impaired / machine translated, fps
  and download count; a pick goes through `GET /downloadSubtitles` (counts against the key's daily quota),
  `cmd.setSubtitle` and closes. Back, its breadcrumb and Esc return to the title search. Turning subtitles off,
  loading a URL and uploading a file are in the subtitles menu (Off / URL / File), not here.
- **Sync (6d):** `usePlayer.onTsMap` runs `nextDriftAction` on every `REC:tsMap`: drift under 2 s nudges the playback
  rate proportionally (0.95–1.05× the room speed, start at 0.3 s, stop under 0.1 s), more seeks (3 s cooldown). A
  seek resets the server's `tsMap` (`REC:tsMap {}`) and ignores `CMD:ts` for 1 s, so nobody is pulled back to the old
  position.
  YouTube only uses rates from `getAvailablePlaybackRates()` and otherwise seeks from 1 s. `state.syncStatus` is
  `in-sync` / `catching-up` (seconds behind) / `buffering` / `reconnecting`; `SyncIndicator({ room })` shows it.

## Subtitle auto-sync (`subsync/`)

ffsubsync-style: line the selected subtitle track up with the speech in the audio, entirely in the browser.

- **Pipeline** (`subsync/signal.ts`, pure, no imports, tested with synthetic audio): `SpeechActivityMeter` (mono audio →
  300–3400 Hz band energy per 10 ms frame, two biquads each side, no resampling) → `speechActivity` (adaptive noise
  floor that drops at once and rises 1.5 dB/s, soft threshold 12 dB above it, 70 ms smoothing) and `cueSignal` (1 inside
  a cue at its ORIGINAL time, 0 outside) → `alignWindows`: per audio window, the activity is detrended (5 s) and
  FFT-cross-correlated with the cue signal over ±10 min, normalized per lag like a Pearson correlation (+ shrinkage, so a
  stretch with one stray cue can't win); the window curves are summed, the best lag is refined parabolically and
  rounded to 0.05 s. **Confidence:** `peakZ` (best vs. all lags in std devs) ≥ 6 and `confidence` = 1 − (runner-up − mean) /
  (best − mean) (runner-up outside ±1.5 s) ≥ 0.3, with at least two windows contributing (one when a short video is a
  single window); otherwise `offset` is null and nothing changes.
  **Drift** (`alignWithDrift`): every ratio in `DRIFT_SCALES` (1, 1000/1001, 1001/1000, 24/25, 25/24, 23.976/25,
  25/23.976; scale = subtitle fps / video fps) is tried on 50 ms frames with the cues stretched to original × scale;
  `pickScale` keeps 1 unless another scale's peakZ beats it by max(1, 10 %); the chosen scale is aligned again at
  10 ms for the offset. The result is `{offset, scale, confidence, peakZ, candidate}`;
  `syncResultToTiming()` (`logic.ts`) turns it into what the player applies. No piecewise mapping.
- **Audio** (`audio.ts` in `worker.ts`, started by `run.ts` `runAutoSync`, cancelled by terminating the worker):
  mediabunny reads the direct link via range requests (`UrlSource`, 3 retries, 20 s stall timeout) or the sharer's
  `File` (`BlobSource`); AC-3/E-AC-3 via `@mediabunny/ac3`. `planWindows` cuts the dialogue (first to last cue) into 4
  equal parts and puts a 90 s window in each where the cues have the most **speech edges** (a cue start after, or end
  before, ≥ 0.5 s of silence): that's what the alignment locks onto, while back-to-back dialogue matches poorly. Audio
  is interleaved with video, so listening costs about bitrate × seconds: `windowSecondsForBitrate` shortens the windows
  to stay near 300 MB, never below 4 × 60 s. The 4 windows are read **at the same time** (the download is the slow
  part) in `AUTO_SYNC_ROUNDS` = 3 rounds that each extend every window (30, 60, 90 s; a window stays one contiguous
  stretch, overlap between rounds is skipped). The worker aligns after every round and stops early on a clear match
  that the previous round already agreed on (`isClearMatch`: peakZ ≥ 8, confidence ≥ 0.45, offset within 0.05 s and
  the same scale as the round before; shorter listening alone was 0.05–0.25 s less precise). Then it reports 100%
  ("Matching…"), so the bar never sits part-way. The console line `[subsync] … read N ms (r of 3 rounds)` shows how much
  was needed. Worst case it hears exactly what a single 4 × 90 s pass would.
  While converting, it listens to the converter's audio track. The URL is
  never logged (AIOStreams playback URLs carry a credential).
- **Where:** direct links and (for the sharer only, via `ShareSession.file`) file shares. Not YouTube, screen share,
  HLS/DASH or live streams; `autoSyncAvailability()` gives the reason the wand shows instead. Needs `Worker` +
  WebCodecs `AudioDecoder`.
- **The wand** (`AutoSyncButton` in the subtitles menu's Timing offset section): `room.subsync.syncNow()` aligns the
  selected track's original cues (`HTML.getOriginalCues`) and applies offset and scale through `subtitles.setTiming`,
  so it respects Everyone / Just me; ±0.1 s then fine-tunes the offset and keeps the scale. For Everyone it sends
  `CMD:subtitleTiming` with `auto: true`, so the chat line reads "auto-synced the subtitles: …" rather than a manual
  offset change. Progress ("Listening… 40%") comes from `state.subtitleSyncJob`; closing the menu or a new video
  cancels it. The outcome ("Subtitles synced: +2.35 s", "Couldn't find a confident match, offset unchanged" or the
  error) is a toast and also stays under "Auto-sync" in the menu for 15 s (`state.subtitleSyncOutcome`), because toasts
  don't show in element fullscreen; room auto-sync results land there too.
- **Room auto-sync** (`roomSettings.autoSyncSubtitles`, owners, default off): whenever a subtitle with cues is
  selected (a room subtitle via `REC:subtitle`/`REC:host`, picking a track in the menu, or the setting turning on),
  `useSubtitleSync.evaluate()` waits for the cues (up to 20 s) and, if this device can compute it, sends a claim
  after a random 0–1.5 s. **The server picks the first claim** (`server/subtitleAutoSync.ts`), so exactly one device
  per (video, subtitle) does the work; everyone else sees "Bob is syncing subtitles for the room…"
  (`state.subtitleSyncRemote`). The result goes back to the server, which applies it room-wide unless an offset was
  set by hand (a saved non-zero offset or any manual change wins; the wand always works). A failed or departed
  claimer, or one with no result after 3 min, releases the job and the others claim again; after the 3rd attempt the
  server sends a final `done` with no offset. Either way `subtitleSyncRemote` clears.
- Tuned on Tears of Steel (CC-BY Blender Foundation, Wikimedia Commons subtitles): known shifts from −250 s to +480 s
  are found to within 0.1 s, and subtitles drifted by 25/23.976 or 23.976/25 get that exact scale (offset within
  0.05 s); reversed cues and Sintel (26 lines over a loud score) are refused.

## Voice and video call (`call/`)

Voice, plus an optional camera (see **Camera** below).

- **Membership** is the server's (`server/callState.ts`): `REC:callState` lands in `state.call.members` via
  `callReducer.ts` (pure, tested), which also holds this device's `status` (`idle` → `joining` → `joined`), `muted`,
  `pttHeld`, `camera`/`cameraBusy`/`cameraError`, `tilesHidden`, `audioBlocked`, `session`, `peers` (per-member `connecting`/`connected`/`reconnecting`), `speaking`, `micError`, `busy` and the
  per-device prefs (`pushToTalk`, `ducking`). We're `joined` once the server lists us with our session; a state
  without us while `joined` means we're out (timed out, removed, another tab).
- **`useCall`** (`room.call`): `join()`, `leave()`, `toggleMute()`/`setMuted()`, `pttDown()`/`pttUp()`,
  `setDevice(id)`, `setDucking()`/`setPushToTalk()`, `moderate(clientId, "mute"|"camera"|"remove")` (owners),
  `startPreview()`/`stopPreview()` (the pre-join panel opens the mic for the level meter; joining reuses that track),
  `getLevel()`, plus the camera API (see **Camera**) and device lists/checks. Socket handlers `onState`/`onSignal`/`onModerated`/`onConnect`/`onDisconnect` are wired in `useRoom`.
  Media lives in a mutable session, not in React state.
- **Joining**: `openMic()` (`audio.ts`: echo cancellation, noise suppression, auto gain; a remembered device that's
  gone falls back to the default) → `getIceServers()` → transport → `CMD:call join`. **Join-muted rule**
  (`joinMuted`, agreed default): muted if the room's video is playing at that moment, unmuted if paused or nothing
  plays; play/pause never changes it later. Mic errors (`classifyMicError`: blocked, in use, no device, unsupported)
  show in the panel with a hint and "Try again". The chosen mic is remembered (`wp-call-mic`).
- **Transport** (`transport.ts`, `CallTransport` interface, mesh today): one RTCPeerConnection per other member, created
  when they appear (not while they're `reconnecting`), closed when they leave or their session changes. Perfect
  negotiation (`negotiation.ts`: polite = smaller clientId, `offerDecision`), signals handled one at a time per peer.
  **Only the impolite side offers**: it adds an audio and a video transceiver (sendrecv) when the connection is
  created, and the polite side adopts them from that offer (`adoptTransceivers`) instead of adding its own. Two
  colliding first offers made Chrome roll one back, and with a video m-line that connection never got ICE candidates
  for its answer and its remote video stayed muted (no camera video). Rollback on collision stays as a safety net;
  `REC:callSignal` for another session is dropped. `PeerRecovery`: ICE restart when a connection stays
  `disconnected` 3 s, `failed`, or never connects in 10 s (only the offering side sends the restart offer); backoff
  1–16 s with jitter; relay-only after 2 restarts when TURN is configured; an unanswered offer is rolled back first. Opus gets DTX, FEC and 32 kbps (`tuneVoiceSdp`
  on remote descriptions, plus `maxBitrate` on the sender).
- **Audio** (`audio.ts`, `CallAudio`): remote audio plays through `<audio>` elements (autoplay blocked → toast "Play
  call audio"); AnalyserNodes measure every source each 60 ms; `SpeakingDetector` (`speaking.ts`: start above
  −48 dBFS for 80 ms, stop below −56 dBFS for 500 ms) drives the speaking rings. Nothing goes over the network.
- **Ducking** (`ducking.ts`, per device `wp-call-ducking`, off by default): while a remote member speaks the movie
  plays at ×0.6 (fade down 200 ms, hold 400 ms, fade up 1.2 s) through `Player.setDuck` (HTML.ts / YouTube.ts multiply
  the viewer's own volume; `getVolume` still returns it). iOS ignores `video.volume`, so no ducking there.
- **Keys**: `M` toggles the mic while in a call (PlayerArea; otherwise it mutes the video); `V` toggles the camera while
  in a call (nothing otherwise). Push-to-talk (per device
  `wp-call-ptt`, off by default): hold `T`, or hold the mic button (touch); not while typing or in a dialog; window
  blur releases it. Mute state updates are throttled to one per 200 ms.
- **Reconnects**: a socket reconnect re-sends `join` with the same session (peer connections keep running); the
  server keeps us for 12 s. A reload rejoins from the `sessionStorage` marker `wp-call:<roomId>` (per tab) with the
  previous mute state. `io server disconnect` (another tab took over, kicked) ends the call in this tab. Unmount /
  room change sends `leave` (layout effect, before the socket closes).
- **UI**: `CallControl` in the top bar ("Voice" + call avatars with speaking rings; when joined a mic button, a camera
  button on desktop, and a warning dot while reconnecting) opens `CallPanel` (popover; bottom drawer on phones): members (speaking ring, muted
  icon, "Reconnecting…", owners' ⋯ Mute in call / Turn off camera / Remove from call), mic picker + live level, "Headphones
  recommended", Join (joining times out after 8 s), and in the call: ducking and push-to-talk switches, Mute, Leave call. The People panel shows a
  headset / muted-mic icon per call member and the speaking ring; owners' person menu has "Mute in call", "Turn off
  camera" and "Remove from call". `REC:callModerated` toasts "Alex muted you…" (you mute yourself) or "…removed you from the voice call".
- **Camera** (`video.ts`, `videoStreams.ts`): off by default. `room.call.setCamera(on)` / `toggleCamera()` (V, the
  desktop top-bar camera button, the call panel) open `openCamera()` (720p ideal, the remembered `wp-call-camera` or the
  front camera; a device that's gone falls back to the default). Before joining the panel's "Turn camera on" is a live
  mirrored preview and you join with it on (`join` carries `camera`); closing the panel turns it off. Off **stops**
  the track (camera light off) and `setLocalTrack("video", null)` (`replaceTrack(null)`); on, later toggles and
  device switches (`setCameraDevice`) are `replaceTrack` on the video sender every connection has from the start, so
  the camera never renegotiates. Errors (`cameraError`, `CAMERA_ERROR_TEXT`) show in the
  panel and as a toast and never block joining with audio. `devicechange`/`ended` turn the camera off with a toast. A
  socket reconnect keeps the camera; a reload rejoins with it off. An owner's "Turn off camera"
  (`REC:callModerated {action: "camera"}`) turns it off with a toast.
- **Video only to viewers showing the tiles** (`wantsVideo`): a viewer wants video while the tiles show: not hidden
  (`tilesHidden`), the strip not collapsed (`tilesCollapsed`, in `state.call` so the call knows; saved with the strip
  position in `wp-call-tiles`) and the tab visible (`document.visibilityState`); an enlarged tile counts. `wantsVideo()`
  (`logic.ts`, pure) decides it; `useCall` sends it with `join` and as `CMD:call {action: "state", wantsVideo}` through
  `createDebouncedFlag` (150 ms to show, 500 ms to hide, a change back in between sends nothing). The server keeps it
  per member in `REC:callState`; `useCall` passes it to `transport.setPeers`, and the mesh sends our camera only to
  peers with `sendsVideoTo()` (`video.ts`: `wantsVideo !== false`, so older clients get video): the others get
  `replaceTrack(null)` on their video sender, the camera again when they show the tiles (no renegotiation, voice
  untouched, frames within about a second; the tile shows the avatar until then). `MeshPeer.sending` remembers what
  each sender was asked to send, so a quick off/on isn't skipped while `replaceTrack` is still pending. A reconnect
  re-sends it with `join`, a reload or a late joiner builds peers from the current state, and a camera switch only
  goes to peers that want it.
- **Video bandwidth** (`transport.ts` `applyParams`, `videoCapsForPeers`): each video sender is capped by how many peers
  actually receive our camera (those showing the tiles; 1 → 720p / 1.2 Mbps / 30 fps, 2 → 540p / 700 kbps, 3–4 → 360p / 400 kbps / 24 fps, more → 240p / 200 kbps /
  15 fps) via `maxBitrate`, `maxFramerate`, `scaleResolutionDownBy` and `degradationPreference: "maintain-framerate"`
  (camera tracks get `contentHint = "motion"`). Video encodings get `priority`/`networkPriority: "low"`, audio
  `"high"`, so a congested uplink drops video first. Re-applied (serialized per peer, only when it changes) when the
  call size or who wants video changes, the camera changes, a connection connects or negotiation settles.
- **Tiles** (`VideoTiles.tsx`, `tileLayout.ts`, pure and tested): incoming video tracks go to `CallVideo` (mutable;
  `useCallVideo` re-renders on changes, with `live` = frames arriving). `VideoTiles` is rendered inside PlayerArea
  (the fullscreen target) and shows only while we're in the call and someone has `camera` on (`videoMembers`; our own
  tile follows our local camera state). A column of 4:3 tiles (wrapping into more columns; the grid never has more
  rows than tiles, or the strip would be too tall to move), draggable (5 px threshold so a click still enlarges; the
  move and release are followed on `window`, so a quick drag that leaves the strip keeps going), collapsible into a pill (which fades out with the player's controls while idle, via the player root's `data-idle`, unless it's focused), with a hover header (always visible on touch). Position is stored
  per device (`wp-call-tiles`: fractions of the safe area, so it keeps its corner when resizing or going fullscreen);
  the default is top-left so a fullscreen chat panel sliding in from the right stays clear: change
  `DEFAULT_STRIP_POSITION`, or reserve an edge with `stripInsets({reserve})`. The safe area avoids the fullscreen title
  bar and the control bar. Tiles: speaking ring, muted icon, name, "Reconnecting…", mirrored self view, avatar until
  frames arrive; click to enlarge (`object-fit: contain`). Video elements are `muted playsInline autoPlay` (audio plays
  through `CallAudio`, so autoplay never blocks them). "Hide video tiles" (strip header, with a "Show again" button
  on its toast, or the call panel's "Show video tiles" switch) is per device (`wp-call-tiles-hidden`); hidden or collapsed tiles don't receive video (see
  **Video only to viewers showing the tiles**). The People panel keeps
  avatars.

## Ready check

- Only while `state.roomSettings.readyCheck` is on, `hooks/useReadyCheck.ts` polls this device every 500 ms and sends `cmd.reportReadyState({ready, buffering, time})`
  only when `ready`/`buffering` change (and again on a new video, reconnect or when a check starts). Ready = no media
  / share / live / can't play, or ≥ 6 s buffered ahead (stays ready down to 2 s), buffered to the end, or
  `readyState >= HAVE_ENOUGH_DATA` (not while converting: the converter's MediaSource buffer is measured instead).
  YouTube uses its BUFFERING state and loaded fraction. `buffering` = stalled > 1.5 s while the room plays (stalled =
  `waiting`/YouTube BUFFERING, or a playing `<video>` with `readyState < HAVE_FUTURE_DATA`; `StallTracker`). Such a
  stall also makes this device not ready, whatever `buffered` says (Chromium estimates it from bytes for plain `src=`
  playback, so it can claim 30 s ahead of a player stuck in `waiting`), until the player has data at the playhead
  again (`readyState >= HAVE_FUTURE_DATA`, or YouTube stops buffering), also while the check has paused the room.
- The server (`server/readyCheck.ts`) decides when to pause/resume; `REC:readyCheck` lands in `state.readyCheck`.
  `player/ReadyCheckPill.tsx` ("Waiting for Sam…", avatars, Resume now → `room.readyCheck.skip()`) sits on the
  player, the People tab shows "Buffering…" for whoever is waited for, and toasts come from
  `describeReadyCheckChange`. The pause has no actor, so it doesn't show "Alex paused"; drift sync is off while paused.

## Notes for the redesign

- Build new views on `const room = useRoom(roomId)`: everything is on `room.state`, `room.store`, `room.player`,
  `room.cmd`, `room.share`, `room.convert`, `room.playlist`, `room.subtitles`, `room.subsync`, `room.readyCheck`,
  `room.call`, `room.chatRef` (plus `clientId`, `socket`, `showError`, `updateName`, `getMediaDisplayName`).
- The player depends on the element ids `leftVideo`/`leftYt` (`VIDEO_ELEMENT_ID`/`YOUTUBE_ELEMENT_ID` in
  `usePlayer.ts`). Keep them, or switch `HTML.ts` to a ref.
