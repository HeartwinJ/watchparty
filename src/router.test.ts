import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { matchRoute, navigate, useRoute } from "./router";

describe("matchRoute", () => {
  it.each([
    ["/", { name: "home" }],
    ["", { name: "home" }],
    ["/create", { name: "create" }],
    ["/create/", { name: "create" }],
    ["/watch/happy-red-fox", { name: "watch", roomId: "happy-red-fox" }],
    ["/watch/happy-red-fox/", { name: "watch", roomId: "happy-red-fox" }],
    ["/watch/a%20b", { name: "watch", roomId: "a b" }],
    ["/watch/%E0%A4%A", { name: "watch", roomId: "%E0%A4%A" }],
    ["/watch", { name: "notFound" }],
    ["/watch/a/b", { name: "notFound" }],
    ["/nope", { name: "notFound" }],
  ])("matches %s", (path, expected) => {
    expect(matchRoute(path)).toEqual(expected);
  });
});

describe("useRoute", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("follows navigate() and back/forward", () => {
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: "home" });

    act(() => navigate("/watch/room-1"));
    expect(result.current).toEqual({ name: "watch", roomId: "room-1" });
    expect(window.location.pathname).toBe("/watch/room-1");

    act(() => navigate("/create", { replace: true }));
    expect(result.current).toEqual({ name: "create" });

    act(() => {
      window.history.replaceState(null, "", "/somewhere");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current).toEqual({ name: "notFound" });
  });
});
