import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatOverlay } from "./ChatOverlay";

afterEach(cleanup);

const props = {
  nameMap: { a: "Alex" },
  clientId: "me",
  mediaName: (u?: string) => u ?? "",
  chatting: false,
};

describe("ChatOverlay", () => {
  it("shows lines without a person without a name", () => {
    const { rerender, container } = render(
      <ChatOverlay {...props} chat={[]} />,
    );
    rerender(
      <ChatOverlay
        {...props}
        chat={[
          {
            id: "",
            cmd: "nowPlaying",
            msg: JSON.stringify({ via: "queue", title: "Spring" }),
            timestamp: "t1",
          },
          { id: "a", msg: "hi", timestamp: "t2" },
        ]}
      />,
    );
    expect(
      screen.getByText("Now playing Spring (from the queue)"),
    ).toBeTruthy();
    const names = [...container.querySelectorAll("b")].map(
      (b) => b.textContent,
    );
    expect(names).toEqual(["Alex"]);
  });
});
