import { describe, expect, it } from "vitest";
import { inviteLink, inviteLinkWithPassword, roomPassword } from "./invite";

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
