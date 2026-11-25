import "@mantine/core/styles.css";
import "./index.css";

import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./components/App/App";
import { Home } from "./components/Home/Home";
import { TopBar } from "./components/TopBar/TopBar";
import { softWhite } from "./utils/utils";
import { Create } from "./components/Create/Create";
import { AuthGate } from "./components/AuthGate/AuthGate";
import {
  Anchor,
  createTheme,
  MantineProvider,
  Stack,
  Title,
  v8CssVariablesResolver,
} from "@mantine/core";
import { useRoute } from "./router";

const theme = createTheme({
  /** Your theme override here */
  white: softWhite,
  // Keep the Mantine 8 look until the Phase 4 redesign (9.0 changed the default radius to md)
  defaultRadius: "sm",
});

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
      // Mantine 9 made the light variant opaque; keep the 8.x colors until the redesign
      cssVariablesResolver={v8CssVariablesResolver}
    >
      <AuthGate>
        <Routes />
      </AuthGate>
    </MantineProvider>
  );
};
const container = document.getElementById("root");
const root = createRoot(container!);
root.render(<WatchParty />);
