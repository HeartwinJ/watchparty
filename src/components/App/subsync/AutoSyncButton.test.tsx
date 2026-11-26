import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Room } from "../hooks/useRoom";
import { AutoSyncButton } from "./AutoSyncButton";

afterEach(() => cleanup());

function fakeRoom(
  opts: {
    reason?: string | null;
    job?: { auto: boolean; progress: number } | null;
    remote?: { by: string } | null;
  } = {},
) {
  const subsync = {
    syncNow: vi.fn(),
    cancel: vi.fn(),
    unavailableReason: () => opts.reason ?? null,
  };
  const room = {
    subsync,
    state: {
      subtitleSyncJob: opts.job ?? null,
      subtitleSyncRemote: opts.remote ?? null,
    },
  } as unknown as Room;
  return { room, subsync };
}

describe("AutoSyncButton", () => {
  it("starts a sync", () => {
    const { room, subsync } = fakeRoom();
    render(<AutoSyncButton room={room} hasTrack />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-sync/ }));
    expect(subsync.syncNow).toHaveBeenCalled();
  });

  it("is disabled with the reason when it can't run", () => {
    const { room, subsync } = fakeRoom({
      reason: "Not available for YouTube videos",
    });
    render(<AutoSyncButton room={room} hasTrack />);
    const btn = screen.getByRole("button", { name: /Auto-sync/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.textContent).toContain("Not available for YouTube videos");
    fireEvent.click(btn);
    expect(subsync.syncNow).not.toHaveBeenCalled();
  });

  it("needs a subtitle track", () => {
    const { room } = fakeRoom();
    render(<AutoSyncButton room={room} hasTrack={false} />);
    expect(
      screen.getByRole("button", { name: /Auto-sync/ }).textContent,
    ).toContain("Pick a subtitle track first");
  });

  it("shows progress and cancels; closing the menu cancels too", () => {
    const { room, subsync } = fakeRoom({ job: { auto: false, progress: 0.4 } });
    const view = render(<AutoSyncButton room={room} hasTrack />);
    expect(screen.getByRole("status").textContent).toContain("Listening… 40%");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(subsync.cancel).toHaveBeenCalledWith("manual");
    subsync.cancel.mockClear();
    view.unmount();
    expect(subsync.cancel).toHaveBeenCalledWith("manual");
  });

  it("shows the room's auto-sync without a cancel button", () => {
    const { room } = fakeRoom({ job: { auto: true, progress: 1 } });
    render(<AutoSyncButton room={room} hasTrack />);
    expect(screen.getByRole("status").textContent).toContain(
      "Auto-syncing for the room",
    );
    expect(screen.getByRole("status").textContent).toContain("Matching…");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("says who else is syncing", () => {
    const { room } = fakeRoom({ remote: { by: "Bob" } });
    render(<AutoSyncButton room={room} hasTrack />);
    expect(
      screen.getByText("Bob is syncing subtitles for the room…"),
    ).toBeTruthy();
  });
});
