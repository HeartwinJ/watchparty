import { Loader, Tooltip } from "@mantine/core";
import type { ConvertStatus as Status } from "../hooks/useConvert";
import styles from "./SourcePicker.module.css";

/**
 * Small "Converting · 34% buffered" pill for the player or top bar. Pass `room.convert.status`; renders nothing
 * when this device isn't converting.
 */
export function ConvertStatus({ status }: { status: Status | null }) {
  if (!status) {
    return null;
  }
  return (
    <Tooltip
      label={`${status.reason}.${status.heavy ? " The video is re-encoded on this device." : ""}`}
      multiline
      w={260}
    >
      <span className={styles.convertPill} role="status" aria-live="polite">
        <Loader size={10} color="gray" />
        {status.label}
      </span>
    </Tooltip>
  );
}
