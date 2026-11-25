# Room page (`/watch/:roomId`)

`App.tsx` is a thin layout. State and behavior live in hooks, pure logic lives in `logic/` with unit tests. The
visuals are still the pre-redesign ones. Phase 4 should replace the view components and keep the hooks.

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

| File                                 | What                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `App.tsx`                            | Layout: top bar, left column (toolbar, player, controls), sidebar                        |
| `RoomMessages.tsx`                   | Modals (share, subtitles, settings), loading/error overlays, alert toasts                |
| `RoomToolbar.tsx`                    | URL bar (`ComboBox`), share buttons, playlist menu, Convert switch                       |
| `PlayerArea.tsx`                     | `PlayerArea` (iframe + `<video>` + overlays) and `PlayerControls` (wraps `Controls`)     |
| `RoomSidebar.tsx`                    | Name input, invite, People, Settings, Chat                                               |
| `roomState.ts`                       | `RoomState` type and initial values (incl. localStorage-backed prefs)                    |
| `socketEvents.ts`                    | Typed socket events and `createRoomCommands`                                             |
| `Player.ts`, `HTML.ts`, `YouTube.ts` | Player implementations (unchanged)                                                       |
| `logic/sync.ts`                      | Leader time (median/max), catch-up playback rate, live-edge offsets, seek targets        |
| `logic/media.ts`                     | `classifyMedia(url)`, display names, sharer lookup                                       |
| `logic/chat.ts`                      | Immutable chat updates (append with 100 cap, reactions), chat sound rule                 |
| `logic/playlist.ts`                  | What happens when a video ends (loop / playlist next / next fileIndex)                   |
| `logic/sdp.ts`                       | SDP tweaks for WebRTC (Safari offer fix, stereo/multichannel Opus)                       |
| `hooks/useRoom.test.ts`              | Integration test with a fake socket: connect, auth, REC:* events, sync rate, CMD:* emits |

## Notes for the redesign

- Build new views on `const room = useRoom(roomId)`: everything is on `room.state`, `room.player`, `room.cmd`,
  `room.share`, `room.convert`, `room.playlist`, `room.subtitles`, `room.chatRef`.
- The player depends on the element ids `leftVideo`/`leftYt` (`VIDEO_ELEMENT_ID`/`YOUTUBE_ELEMENT_ID` in
  `usePlayer.ts`). Keep them, or switch `HTML.ts` to a ref.
- `Controls` is remounted via `state.controlsTimestamp` to re-read the player. The redesign's overlay controls
  should subscribe to `<video>` events instead.
- Smoother sync (6d) belongs in `logic/sync.ts` (`getCatchUpPlaybackRate`) and `usePlayer.autoSyncRate`.
