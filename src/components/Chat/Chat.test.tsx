import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Chat } from "./Chat";

afterEach(cleanup);

const renderChat = (chat: ChatMessage[] = []) => {
  const cmd = {
    sendChat: vi.fn(),
    sendChatV2: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
  };
  render(
    <MantineProvider>
      <Chat
        chat={chat}
        nameMap={{ u1: "Alex" }}
        pictureMap={{}}
        cmd={cmd}
        scrollTimestamp={0}
        getMediaDisplayName={(s) => s ?? ""}
      />
    </MantineProvider>,
  );
  return cmd;
};

describe("Chat", () => {
  it("sends a message on Enter and clears the input", () => {
    const cmd = renderChat();
    const input = screen.getByPlaceholderText(
      "Enter a message...",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(cmd.sendChat).toHaveBeenCalledWith("hello");
    expect(input.value).toBe("");
  });

  it("doesn't send empty messages", () => {
    const cmd = renderChat();
    const input = screen.getByPlaceholderText("Enter a message...");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(cmd.sendChat).not.toHaveBeenCalled();
  });

  it("renders messages with names, system commands and safe links", () => {
    renderChat([
      {
        id: "u1",
        timestamp: new Date(0).toISOString(),
        msg: "look at https://example.com",
      },
      {
        id: "u1",
        timestamp: new Date(1).toISOString(),
        cmd: "playbackRate",
        msg: "0",
      },
    ]);
    expect(screen.getAllByText("Alex")).toHaveLength(2);
    const link = screen.getByRole("link", { name: "https://example.com" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("set the playback rate to auto")).toBeTruthy();
  });

  it("toggles a reaction off when we already reacted", () => {
    const me = window.localStorage.getItem("watchparty-clientid")!;
    const cmd = renderChat([
      {
        id: "u1",
        timestamp: "t1",
        msg: "hi",
        reactions: { "👍": [me] },
      },
    ]);
    fireEvent.click(screen.getByText("👍"));
    expect(cmd.removeReaction).toHaveBeenCalledWith({
      value: "👍",
      msgId: "u1",
      msgTimestamp: "t1",
    });
  });
});
