import { Button } from "@mantine/core";
import { IconHome, IconMapQuestion } from "@tabler/icons-react";
import { navigate } from "../../router";
import { StatusPage, statusStyles } from "./StatusPage";

/** Unknown routes. */
export const NotFound = () => (
  <StatusPage
    icon={<IconMapQuestion size={22} />}
    title="Page not found"
    actions={
      <Button
        leftSection={<IconHome size={16} />}
        onClick={() => navigate("/")}
      >
        Go home
      </Button>
    }
  >
    <p className={statusStyles.text}>
      There's nothing at this address. Room links look like{" "}
      <code>/watch/brave-otter-sings</code>.
    </p>
  </StatusPage>
);
