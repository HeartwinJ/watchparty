// The player lives in player/ (see README.md). This module keeps the old import path working.
import type { Room } from "./hooks/useRoom";
import { PlayerArea as Player } from "./player/PlayerArea";

export { SyncIndicator } from "./player/SyncIndicator";

/**
 * The player in a box that works both in the pre-redesign flex column (grows to fill it) and in the redesigned stage
 * (fills a `position: relative` parent). The player itself (`player/PlayerArea`) is `position: absolute; inset: 0`.
 */
export const PlayerArea = ({ room }: { room: Room }) => (
  <div
    style={{
      position: "relative",
      flex: "1 1 auto",
      minHeight: 0,
      height: "100%",
      width: "100%",
    }}
  >
    <Player room={room} />
  </div>
);

/**
 * @deprecated The controls are now overlaid inside <PlayerArea>. Kept as a no-op so the pre-redesign layout still
 * compiles until the new shell stops rendering it.
 */
export const PlayerControls = (_props: { room: Room }) => null;
