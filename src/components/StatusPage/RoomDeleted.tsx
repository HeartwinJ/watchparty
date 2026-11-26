import { Button } from "@mantine/core";
import { IconHome, IconTrash } from "@tabler/icons-react";
import { navigate } from "../../router";
import { StatusPage, statusStyles } from "./StatusPage";

/**
 * Shown to everyone who was in a room when an owner deleted it (REC:roomDeleted). A link to a room that doesn't
 * exist (anymore) shows the usual not-found state instead. Guests can't go Home, so only owners get the button.
 */
export const RoomDeleted = ({
  by,
  canGoHome,
}: {
  /** Who deleted it, when known */
  by: string | null;
  canGoHome: boolean;
}) => (
  <StatusPage
    icon={<IconTrash size={22} />}
    title="This room was deleted"
    actions={
      canGoHome ? (
        <Button
          leftSection={<IconHome size={16} />}
          onClick={() => navigate("/")}
        >
          Go home
        </Button>
      ) : undefined
    }
  >
    <p className={statusStyles.text}>
      {by ? `${by} deleted this room` : "An owner deleted this room"}, so its
      link doesn't work anymore.
    </p>
  </StatusPage>
);
