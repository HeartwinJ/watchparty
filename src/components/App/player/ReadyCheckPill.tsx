import { Button } from "@mantine/core";
import { AvatarStack } from "../../Avatar/Avatar";
import { waitingLabel } from "../logic/readyCheck";
import styles from "./ReadyCheck.module.css";

/**
 * "Waiting for Sam, Alex…" with their avatars and a "Resume now" button, shown on the player while the room is
 * paused by the ready check. Renders nothing otherwise.
 */
export function ReadyCheckPill({
  state,
  nameMap,
  pictureMap,
  clientId,
  onSkip,
}: {
  state: ReadyCheckState | null;
  nameMap: StringDict;
  pictureMap: StringDict;
  clientId: string;
  onSkip: () => void;
}) {
  if (!state?.active) {
    return null;
  }
  const users = state.waitingFor.map((id) => ({
    id,
    name: id === clientId ? "You" : nameMap[id],
    picture: pictureMap[id] || undefined,
  }));
  return (
    <div className={styles.pill} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      {users.length > 0 && <AvatarStack users={users} max={3} size={22} />}
      <span className={styles.label}>
        {waitingLabel(state, nameMap, clientId)}
      </span>
      <Button
        size="compact-sm"
        radius="xl"
        onClick={(e) => {
          e.stopPropagation();
          onSkip();
        }}
      >
        Resume now
      </Button>
    </div>
  );
}
