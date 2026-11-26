// The entry point: mounts into #root, routes by path behind the AuthGate, and redirects old /#room links.
import { act, screen, waitFor } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("./components/App/App", () => ({
  App: ({ urlRoomId }: { urlRoomId: string }) => <div>room {urlRoomId}</div>,
}));
vi.mock("./components/Home/Home", () => ({ Home: () => <div>home page</div> }));
vi.mock("./components/Create/Create", () => ({
  Create: () => <div>create page</div>,
}));
vi.mock("./components/AuthGate/AuthGate", () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterAll(() => window.history.replaceState(null, "", "/"));

// The first import pulls in Mantine and the stylesheets, which is slow on a cold cache (hence the 60 s timeouts)
describe("index", () => {
  it("renders the route for the current path and follows navigation", async () => {
    window.history.replaceState(null, "", "/watch/brave-otter");
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      await import("./index");
    });
    await waitFor(() =>
      expect(screen.getByText("room brave-otter")).toBeTruthy(),
    );
    const { navigate } = await import("./router");
    act(() => navigate("/"));
    expect(screen.getByText("home page")).toBeTruthy();
    act(() => navigate("/create"));
    expect(screen.getByText("create page")).toBeTruthy();
    act(() => navigate("/nope/nope"));
    expect(screen.getByText("Page not found")).toBeTruthy();
  }, 60_000);

  it("redirects old /#room links to /watch/room", async () => {
    vi.resetModules();
    window.history.replaceState(null, "", "/#old-room");
    const original = window.location;
    const loc = { ...original, hash: "#old-room", pathname: "/", href: "" };
    Object.defineProperty(window, "location", {
      configurable: true,
      value: loc,
    });
    document.body.innerHTML = '<div id="root"></div>';
    try {
      await act(async () => {
        await import("./index");
      });
      expect(loc.href).toBe("/watch/old-room");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    }
  }, 60_000);
});
