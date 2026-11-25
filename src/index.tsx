import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./theme/tokens.css";
import "./index.css";

import { createRoot } from "react-dom/client";

import { App } from "./components/App/App";
import { Home } from "./components/Home/Home";
import { cssVariablesResolver, theme } from "./theme/theme";
import { Notifications } from "@mantine/notifications";
import { Create } from "./components/Create/Create";
import { AuthGate } from "./components/AuthGate/AuthGate";
import { MantineProvider } from "@mantine/core";
import { NotFound } from "./components/StatusPage/NotFound";
import { useRoute } from "./router";

// Redirect old-style URLs
if (window.location.hash && window.location.pathname === "/") {
  const hashRoomId = window.location.hash.substring(1);
  window.location.href = "/watch/" + hashRoomId;
}

const Routes = () => {
  const route = useRoute();
  switch (route.name) {
    case "home":
      return <Home />;
    case "create":
      return <Create />;
    case "watch":
      return <App key={route.roomId} urlRoomId={route.roomId} />;
    case "notFound":
      return <NotFound />;
  }
};

const WatchParty = () => {
  return (
    <MantineProvider
      theme={theme}
      forceColorScheme="dark"
      cssVariablesResolver={cssVariablesResolver}
    >
      <Notifications position="top-center" limit={3} zIndex={500} />
      <AuthGate>
        <Routes />
      </AuthGate>
    </MantineProvider>
  );
};
const container = document.getElementById("root");
const root = createRoot(container!);
root.render(<WatchParty />);
