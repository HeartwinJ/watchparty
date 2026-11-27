// The Audio menu: the converter's audio tracks, then volume boost / Night mode (not for YouTube).
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AudioMenu, hasAudioMenu } from "./AudioMenu";
import type { Room } from "../hooks/useRoom";
import {
  renderWithPlayerRoom,
  type RenderPlayerOptions,
} from "../../../test/playerRoom";

function setup(opts: RenderPlayerOptions = {}) {
  let room: Room | undefined;
  const r = renderWithPlayerRoom(
    (rm) => {
      room = rm;
      return <AudioMenu room={rm} />;
    },
    {
      ...opts,
      state: { roomMedia: "https://example.com/movie.mp4", ...opts.state },
    },
  );
  return { ...r, room: () => room! };
}

afterEach(cleanup);

describe("hasAudioMenu", () => {
  it("is offered for <video> media, and for YouTube only with several audio tracks", () => {
    expect(hasAudioMenu(setup().room())).toBe(true);
    cleanup();
    expect(
      hasAudioMenu(setup({ media: { youtube: true, native: false } }).room()),
    ).toBe(false);
  });
});

describe("AudioMenu audio tracks", () => {
  it("lists audio tracks when there are several", () => {
    const r = setup({
      state: {
        audioTracks: [
          { id: 1, label: "English 5.1" },
          { id: 2, label: "Commentary" },
        ] as any,
        audioTrackId: 1,
      },
    });
    const menu = screen.getByRole("menu", { name: "Audio tracks" });
    expect(
      within(menu)
        .getByRole("menuitemradio", { name: "English 5.1" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(
      within(menu).getByRole("menuitemradio", { name: "Commentary" }),
    );
    expect(r.convert.setAudioTrack).toHaveBeenCalledWith(2);
  });

  it("hides the section with a single track", () => {
    setup({ state: { audioTracks: [{ id: 1, label: "Only" }] as any } });
    expect(screen.queryByRole("menu", { name: "Audio tracks" })).toBeNull();
  });
});

describe("AudioMenu volume boost", () => {
  const boost = () => screen.getByRole("group", { name: "Boost" });
  const night = () => screen.getByRole("group", { name: "Night mode" });

  it("picks a boost level and Night mode for this device", () => {
    const r = setup({ state: { audioBoost: { level: 1.5, night: false } } });
    expect(
      within(boost())
        .getByRole("button", { name: "150%" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(boost()).getByRole("button", { name: "300%" }));
    expect(r.player.setAudioBoost).toHaveBeenCalledWith({ level: 3 });
    fireEvent.click(within(boost()).getByRole("button", { name: "Off" }));
    expect(r.player.setAudioBoost).toHaveBeenLastCalledWith({ level: 1 });
    expect(
      within(night())
        .getByRole("button", { name: "Off" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(night()).getByRole("button", { name: "On" }));
    expect(r.player.setAudioBoost).toHaveBeenLastCalledWith({ night: true });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("explains when it's waiting for a click or can't be used", () => {
    const r = setup({ state: { audioBoostStatus: "pending" } });
    expect(screen.getByRole("status").textContent).toMatch(/next click/);
    r.setState({ audioBoostStatus: "unavailable" });
    expect(screen.getByRole("status").textContent).toMatch(/Not available/);
  });

  it("isn't offered for YouTube", () => {
    setup({ media: { youtube: true, native: false } });
    expect(screen.queryByRole("group", { name: "Boost" })).toBeNull();
  });
});
