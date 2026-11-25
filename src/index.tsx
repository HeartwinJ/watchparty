import "@mantine/core/styles.css";
import "./index.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route } from "react-router-dom";

import { App } from "./components/App/App";
import { Home } from "./components/Home/Home";
import { TopBar } from "./components/TopBar/TopBar";
import { softWhite } from "./utils/utils";
import { Create } from "./components/Create/Create";
import { AuthGate } from "./components/AuthGate/AuthGate";
import { createTheme, MantineProvider } from "@mantine/core";

const theme = createTheme({
  /** Your theme override here */
  white: softWhite,
});

// Redirect old-style URLs
if (window.location.hash && window.location.pathname === "/") {
  const hashRoomId = window.location.hash.substring(1);
  window.location.href = "/watch/" + hashRoomId;
}

const WatchParty = () => {
  return (
    // <React.StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <AuthGate>
        <BrowserRouter>
          <Route
            path="/"
            exact
            render={() => {
              return (
                <React.Fragment>
                  <TopBar hideNewRoom />
                  <Home />
                </React.Fragment>
              );
            }}
          />
          <Route
            path="/create"
            exact
            render={() => {
              return <Create />;
            }}
          />
          <Route
            path="/watch/:roomId"
            exact
            render={(props) => {
              return <App urlRoomId={props.match.params.roomId} />;
            }}
          />
        </BrowserRouter>
      </AuthGate>
    </MantineProvider>
    // </React.StrictMode>
  );
};
const container = document.getElementById("root");
const root = createRoot(container!);
root.render(<WatchParty />);
