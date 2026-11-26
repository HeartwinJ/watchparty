import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.fn();
vi.mock("../ui/toast", () => ({
  toast: (...a: unknown[]) => toastMock(...a),
}));

const {
  copyInviteLink,
  copyText,
  inviteLink,
  inviteLinkWithPassword,
  roomPassword,
} = await import("./invite");

const loc = {
  origin: "https://watch.example.com",
  pathname: "/watch/brave-otter-sings",
};

describe("invite links", () => {
  it("the plain link has no query or fragment", () => {
    expect(inviteLink(loc)).toBe(
      "https://watch.example.com/watch/brave-otter-sings",
    );
  });

  it("uses the current page by default", () => {
    expect(inviteLink()).toBe(
      window.location.origin + window.location.pathname,
    );
  });

  it("puts the password in the fragment, encoded", () => {
    expect(inviteLinkWithPassword("otter-maple-42", loc)).toBe(
      "https://watch.example.com/watch/brave-otter-sings#pw=otter-maple-42",
    );
    expect(inviteLinkWithPassword("a b&c#d", loc)).toBe(
      "https://watch.example.com/watch/brave-otter-sings#pw=a%20b%26c%23d",
    );
  });

  it("only offers the password while it's required and known (owners)", () => {
    expect(roomPassword({ enabled: true, password: "pw12" })).toBe("pw12");
    expect(roomPassword({ enabled: false, password: "pw12" })).toBeUndefined();
    expect(roomPassword({ enabled: true })).toBeUndefined();
    expect(roomPassword(null)).toBeUndefined();
  });
});

describe("copying", () => {
  const setClipboard = (writeText?: (t: string) => Promise<void>) =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: writeText ? { writeText } : undefined,
    });
  beforeEach(() => toastMock.mockClear());
  afterEach(() => setClipboard(undefined));

  it("copies the link and confirms", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    setClipboard(writeText);
    expect(await copyInviteLink("https://w.example.com/watch/x")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://w.example.com/watch/x");
    expect(toastMock).toHaveBeenCalledWith("Link copied", {
      id: "invite-copied",
      tone: "success",
    });
  });

  it("shows the link to share by hand when copying fails", async () => {
    setClipboard(async () => {
      throw new Error("denied");
    });
    expect(await copyInviteLink("https://w.example.com/watch/x")).toBe(false);
    expect(toastMock.mock.calls[0][0]).toBe(
      "Couldn't copy the link. Share it manually: https://w.example.com/watch/x",
    );
    expect(toastMock.mock.calls[0][1]).toMatchObject({ tone: "danger" });
  });

  it("falls back to execCommand without the Clipboard API", async () => {
    setClipboard(undefined);
    const exec = vi.fn(() => true);
    (document as any).execCommand = exec;
    expect(await copyText("otter-42", "Password")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
    expect(toastMock).toHaveBeenLastCalledWith("Password copied", {
      id: "invite-copied",
      tone: "success",
    });
    exec.mockReturnValue(false);
    expect(await copyText("otter-42", "Password")).toBe(false);
    expect(toastMock).toHaveBeenLastCalledWith(
      "Couldn't copy the password.",
      expect.objectContaining({ tone: "danger" }),
    );
  });
});
