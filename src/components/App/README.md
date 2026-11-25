# Room page (`/watch/:roomId`)

`App.tsx` is a thin layout. State and behavior live in hooks, pure logic lives in `logic/` with unit tests. The room
shell (top bar, sidebar, bottom sheet, settings) is the Phase 4 redesign and lives in `shell/`; the player is in
`PlayerArea.tsx` (player work), the source picker in `picker/` (picker work).

## Data flow

```
useRoom(roomId)                          hooks/useRoom.ts: composes everything below
 ├ useStore(createInitialRoomState)      one RoomState (roomState.ts), get() is synchronous
 ├ useRoomSocket                         socket.io connection, auth handling, typed CMD:* emitters (cmd)
 ├ usePlayer                             HTML.ts / YouTube.ts, play/pause/seek/rate/loop, sync, keyboard, CMD:ts loop
 ├ useConvert                            clientTranscode.ts (lazy mediabunny), Convert toggle, audio tracks
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

| File                                 | What                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `App.tsx`                            | Layout: CSS grid (top bar / stage / sidebar), phone layout with the bottom sheet           |
| `RoomMessages.tsx`                   | Share/subtitle modals, loading + error overlays, reconnecting banner, error/success toasts |
| `PlayerArea.tsx`                     | `PlayerArea` (iframe + `<video>` + overlays) and `PlayerControls` (wraps `Controls`)       |
| `ui/RoomUi.tsx`                      | `useRoomUi()`: picker open, sidebar collapsed, chat overlay, settings modal                |
| `ui/toast.tsx`                       | `toast(message, {tone, action})`                                                           |
| `shell/RoomTopBar.tsx`               | Logo, room name, picker trigger, sync slot, avatars, invite, sidebar toggle, ⋯ menu        |
| `shell/SidePanels.tsx`               | Chat / Queue / People tabs (shared by the sidebar and the bottom sheet), unread badge      |
| `shell/QueuePanel.tsx`               | Now playing + playlist: drag to reorder, play now/next, move, remove, empty state          |
| `shell/PeoplePanel.tsx`              | Invite box, roster (avatar colour, sharing, playback drift), rename popover                |
| `shell/SidebarResize.tsx`            | Drag/keyboard resize of the desktop sidebar (`sidebarWidth.ts`: clamp + localStorage)      |
| `shell/BottomSheet.tsx`              | Phone sheet snap points min/docked/full (`sheet.ts`: pure snap logic)                      |
| `shell/NowPlayingStrip.tsx`          | Phone: title + "Change" under the video                                                    |
| `shell/RoomSettingsModal.tsx`        | Per-device settings (message sound, chat bubbles, auto-convert); room-wide ones are TODO   |
| `shell/shortcuts.ts`                 | `/` opens the picker; `wp:show-shortcuts` event for the shortcuts overlay                  |
| `shell/invite.ts`, `roomInfo.ts`     | Copy invite link + toast; short media titles, per-person playback state                    |
| `roomState.ts`                       | `RoomState` type and initial values (incl. localStorage-backed prefs)                      |
| `socketEvents.ts`                    | Typed socket events and `createRoomCommands`                                               |
| `Player.ts`, `HTML.ts`, `YouTube.ts` | Player implementations (unchanged)                                                         |
| `logic/sync.ts`                      | Leader time (median/max), catch-up playback rate, live-edge offsets, seek targets          |
| `logic/media.ts`                     | `classifyMedia(url)`, display names, sharer lookup                                         |
| `logic/chat.ts`                      | Immutable chat updates (append with 100 cap, reactions), chat sound rule                   |
| `logic/playlist.ts`                  | What happens when a video ends (loop / playlist next / next fileIndex)                     |
| `logic/sdp.ts`                       | SDP tweaks for WebRTC (Safari offer fix, stereo/multichannel Opus)                         |
| `hooks/useRoom.test.ts`              | Integration test with a fake socket: connect, auth, REC:* events, sync rate, CMD:* emits   |

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
  The picker opens via `useRoomUi().openPicker()` (top bar trigger, `/`, phone "Change", queue "Add to queue").
- `PlayerControls` is still rendered under `PlayerArea` in the stage until the overlay controls replace it.

## Notes for the redesign

- Build new views on `const room = useRoom(roomId)`: everything is on `room.state`, `room.player`, `room.cmd`,
  `room.share`, `room.convert`, `room.playlist`, `room.subtitles`, `room.chatRef`.
- The player depends on the element ids `leftVideo`/`leftYt` (`VIDEO_ELEMENT_ID`/`YOUTUBE_ELEMENT_ID` in
  `usePlayer.ts`). Keep them, or switch `HTML.ts` to a ref.
- `Controls` is remounted via `state.controlsTimestamp` to re-read the player. The redesign's overlay controls
  should subscribe to `<video>` events instead.
- Smoother sync (6d) belongs in `logic/sync.ts` (`getCatchUpPlaybackRate`) and `usePlayer.autoSyncRate`.
