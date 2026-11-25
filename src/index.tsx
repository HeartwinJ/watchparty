import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./theme/tokens.css";
import "./index.css";

import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./components/App/App";
import { Home } from "./components/Home/Home";
import { TopBar } from "./components/TopBar/TopBar";
import { cssVariablesResolver, theme } from "./theme/theme";
import { Notifications } from "@mantine/notifications";
import { Create } from "./components/Create/Create";
import { AuthGate } from "./components/AuthGate/AuthGate";
import { Anchor, MantineProvider, Stack, Title } from "@mantine/core";
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
      return (
        <React.Fragment>
          <TopBar hideNewRoom />
          <Home />
        </React.Fragment>
      );
    case "create":
      return <Create />;
    case "watch":
      return <App key={route.roomId} urlRoomId={route.roomId} />;
    case "notFound":
      return (
        <React.Fragment>
          <TopBar />
          <Stack align="center" mt="xl">
            <Title order={2}>Page not found</Title>
            <Anchor href="/">Go home</Anchor>
          </Stack>
        </React.Fragment>
      );
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
