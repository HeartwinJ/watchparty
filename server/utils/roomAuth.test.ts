import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { RoomAccess } from "../roomAccess.ts";
import { createAuth } from "./auth.ts";
import {
  GUEST_COOKIE,
  GUEST_TTL_MS,
  signGuestGrants,
  verifyGuestGrants,
} from "./guestToken.ts";
import { createRoomAuth } from "./roomAuth.ts";
import { parseCookies } from "./session.ts";

const servers: http.Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
});

async function setup(
  opts: { password?: string; joinMax?: number; roomJoinMax?: number } = {},
) {
  const auth = createAuth({
    password: opts.password ?? "instance-pw",
    sessionSecret: "test-secret",
  });
  const rooms = new Map<string, { access: RoomAccess; title: string }>();
  rooms.set("/locked-room-here", {
    access: RoomAccess.create(() => "otter-maple-42"),
    title: "Movie night",
  });
  const open = RoomAccess.create(() => "open-sesame-11");
  open.apply({ action: "enable", enabled: false });
  rooms.set("/open-room-here", { access: open, title: "" });
  let now = 1_000_000;
  const roomAuth = createRoomAuth({
    auth,
    guestKey: auth.guestKey,
    getRoom: (id) => rooms.get(id),
    joinMax: opts.joinMax ?? 3,
    roomJoinMax: opts.roomJoinMax ?? 5,
    now: () => now,
  });
  const app = express();
  // Lets the tests pretend to be different IPs
  app.set("trust proxy", true);
  app.use(express.json());
  auth.register(app, { guestRooms: roomAuth.guestRooms });
  roomAuth.register(app);
  app.get("/member", roomAuth.requireMember, (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/owner", roomAuth.requireOwner, (_req, res) => {
    res.json({ ok: true });
  });
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (
    method: string,
    path: string,
    o: { cookie?: string; body?: unknown; ip?: string } = {},
  ) => {
    const resp = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": o.ip ?? "10.0.0.1",
        ...(o.cookie ? { cookie: o.cookie } : {}),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const text = await resp.text();
    return {
      status: resp.status,
      body: text ? JSON.parse(text) : null,
      setCookie: resp.headers.get("set-cookie") ?? "",
      retryAfter: resp.headers.get("retry-after"),
    };
  };
  const join = (
    room: string,
    password?: unknown,
    o: { cookie?: string; ip?: string } = {},
  ) =>
    call("POST", `/rooms/${room}/join`, {
      ...o,
      body: password === undefined ? {} : { password },
    });
  const cookieOf = (setCookie: string) => setCookie.split(";")[0];
  const ownerCookie = async () => {
    const resp = await fetch(base + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "instance-pw" }),
    });
    return cookieOf(resp.headers.get("set-cookie") ?? "");
  };
  return {
    auth,
    roomAuth,
    rooms,
    call,
    join,
    cookieOf,
    ownerCookie,
    tick: (ms: number) => (now += ms),
    now: () => now,
  };
}

describe("GET /rooms/:roomId/info", () => {
  it("says whether a password is needed, with the title and nothing else", async () => {
    const t = await setup();
    expect((await t.call("GET", "/rooms/locked-room-here/info")).body).toEqual({
      title: "Movie night",
      passwordRequired: true,
    });
    expect((await t.call("GET", "/rooms/open-room-here/info")).body).toEqual({
      title: "",
      passwordRequired: false,
    });
    expect((await t.call("GET", "/rooms/nope-nope-nope/info")).status).toBe(
      404,
    );
    expect((await t.call("GET", "/rooms/bad%20id/info")).status).toBe(404);
  });
});

describe("POST /rooms/:roomId/join", () => {
  it("sets a signed, httpOnly guest cookie for the right password", async () => {
    const t = await setup();
    const resp = await t.join("locked-room-here", "otter-maple-42");
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ ok: true });
    expect(resp.setCookie).toMatch(new RegExp(`^${GUEST_COOKIE}=g1\\.`));
    expect(resp.setCookie).toMatch(/HttpOnly/i);
    expect(resp.setCookie).toMatch(/SameSite=Lax/i);
    expect(resp.setCookie).toMatch(/Path=\//);
    // Plain http, so not Secure
    expect(resp.setCookie).not.toMatch(/Secure/i);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(resp.setCookie)?.[1]);
    expect(maxAge).toBe(GUEST_TTL_MS / 1000);
    const grants = verifyGuestGrants(
      t.auth.guestKey,
      parseCookies(t.cookieOf(resp.setCookie))[GUEST_COOKIE],
      t.now(),
    );
    expect(grants).toEqual([
      {
        roomId: "/locked-room-here",
        epoch: 0,
        guestId: expect.any(String),
        expiresAt: t.now() + GUEST_TTL_MS,
      },
    ]);
    // The password never appears in the cookie
    expect(resp.setCookie).not.toContain("otter");
  });

  it("rejects a wrong password, unknown rooms and bad ids", async () => {
    const t = await setup();
    const bad = await t.join("locked-room-here", "wrong");
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: "invalid_password" });
    expect(bad.setCookie).toBe("");
    expect((await t.join("locked-room-here")).status).toBe(401);
    expect(
      (await t.join("no-such-room", "x", { ip: "10.0.0.9" })).body,
    ).toEqual({ error: "not_found" });
    expect((await t.join("bad%20id", "x")).status).toBe(400);
  });

  it("joins an open room without a password", async () => {
    const t = await setup();
    const resp = await t.join("open-room-here");
    expect(resp.status).toBe(200);
    expect(resp.setCookie).toMatch(/^wp_guest=/);
  });

  it("rate limits wrong passwords per IP, with retryAfter, then lets the IP try again", async () => {
    const t = await setup({ joinMax: 3, roomJoinMax: 100 });
    for (let i = 0; i < 3; i++) {
      expect((await t.join("locked-room-here", "nope")).status).toBe(401);
    }
    // Even the right password is refused while locked out
    const limited = await t.join("locked-room-here", "otter-maple-42");
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(limited.body.retryAfter).toBeGreaterThan(0);
    expect(limited.retryAfter).toBe(String(limited.body.retryAfter));
    // Another IP isn't affected
    expect(
      (await t.join("locked-room-here", "otter-maple-42", { ip: "10.0.0.2" }))
        .status,
    ).toBe(200);
    t.tick(10 * 60 * 1000);
    expect((await t.join("locked-room-here", "otter-maple-42")).status).toBe(
      200,
    );
  });

  it("rate limits wrong passwords per room across IPs", async () => {
    const t = await setup({ joinMax: 100, roomJoinMax: 4 });
    for (let i = 0; i < 4; i++) {
      await t.join("locked-room-here", "nope", { ip: `10.1.0.${i}` });
    }
    expect(
      (await t.join("locked-room-here", "otter-maple-42", { ip: "10.2.0.1" }))
        .status,
    ).toBe(429);
    // Other rooms are fine
    expect(
      (await t.join("open-room-here", undefined, { ip: "10.2.0.1" })).status,
    ).toBe(200);
  });

  it("counts unknown rooms against the IP (no fast room-name probing)", async () => {
    const t = await setup({ joinMax: 2 });
    await t.join("guess-one-x");
    await t.join("guess-two-x");
    expect((await t.join("guess-three-x")).status).toBe(429);
  });

  it("owners don't need a guest cookie", async () => {
    const t = await setup();
    const cookie = await t.ownerCookie();
    const resp = await t.join("locked-room-here", undefined, { cookie });
    expect(resp.status).toBe(200);
    expect(resp.setCookie).toBe("");
  });

  it("keeps grants for other rooms in the same cookie", async () => {
    const t = await setup();
    const a = t.cookieOf((await t.join("open-room-here")).setCookie);
    const b = await t.join("locked-room-here", "otter-maple-42", { cookie: a });
    const session = await t.call("GET", "/session", {
      cookie: t.cookieOf(b.setCookie),
    });
    expect(session.body).toEqual({
      authenticated: false,
      authRequired: true,
      guestRooms: expect.arrayContaining([
        "open-room-here",
        "locked-room-here",
      ]),
    });
  });

  it("refuses a kicked guest until the password changes", async () => {
    const t = await setup();
    const cookie = t.cookieOf(
      (await t.join("locked-room-here", "otter-maple-42")).setCookie,
    );
    const [grant] = verifyGuestGrants(
      t.auth.guestKey,
      parseCookies(cookie)[GUEST_COOKIE],
      t.now(),
    );
    const room = t.rooms.get("/locked-room-here")!;
    room.access.revoke(grant.guestId);
    const kicked = await t.join("locked-room-here", "otter-maple-42", {
      cookie,
    });
    expect(kicked.status).toBe(403);
    expect(kicked.body).toEqual({ error: "kicked" });
    room.access.apply({ action: "set", password: "new-password" });
    expect(
      (await t.join("locked-room-here", "new-password", { cookie })).status,
    ).toBe(200);
  });
  it("refuses a guest kicked while the password is off until it's turned on", async () => {
    const t = await setup();
    const join = await t.join("open-room-here");
    expect(join.status).toBe(200);
    const cookie = t.cookieOf(join.setCookie);
    const [grant] = verifyGuestGrants(
      t.auth.guestKey,
      parseCookies(cookie)[GUEST_COOKIE],
      t.now(),
    );
    const room = t.rooms.get("/open-room-here")!;
    room.access.revoke(grant.guestId);
    // No way back in from this browser: not by joining again, not over the socket
    const kicked = await t.join("open-room-here", undefined, { cookie });
    expect(kicked.status).toBe(403);
    expect(kicked.body).toEqual({ error: "kicked" });
    expect(t.roomAuth.admitSocket(cookie, "/open-room-here")).toBeNull();
    expect((await t.call("GET", "/member", { cookie })).status).toBe(401);
    // Other guests of the open room are unaffected
    const other = t.cookieOf((await t.join("open-room-here")).setCookie);
    expect(t.roomAuth.admitSocket(other, "/open-room-here")).toEqual({
      owner: false,
      guestId: expect.any(String),
    });
    // Turning the password on starts a new epoch: the kicked guest can join with it
    room.access.apply({ action: "enable", enabled: true });
    expect(
      (await t.join("open-room-here", "wrong-password", { cookie })).status,
    ).toBe(401);
    const back = await t.join("open-room-here", "open-sesame-11", { cookie });
    expect(back.status).toBe(200);
    expect(
      t.roomAuth.admitSocket(t.cookieOf(back.setCookie), "/open-room-here"),
    ).toEqual({ owner: false, guestId: expect.any(String) });
  });
});

describe("guest access to the APIs", () => {
  it("member routes accept owners and valid guests; owner routes only owners", async () => {
    const t = await setup();
    expect((await t.call("GET", "/member")).status).toBe(401);
    expect((await t.call("GET", "/owner")).status).toBe(401);

    const guest = t.cookieOf(
      (await t.join("locked-room-here", "otter-maple-42")).setCookie,
    );
    expect((await t.call("GET", "/member", { cookie: guest })).status).toBe(
      200,
    );
    expect((await t.call("GET", "/owner", { cookie: guest })).status).toBe(401);
    expect((await t.call("GET", "/session", { cookie: guest })).body).toEqual({
      authenticated: false,
      authRequired: true,
      guestRooms: ["locked-room-here"],
    });

    const owner = await t.ownerCookie();
    expect((await t.call("GET", "/member", { cookie: owner })).status).toBe(
      200,
    );
    expect((await t.call("GET", "/owner", { cookie: owner })).status).toBe(200);
  });

  it("changing the password revokes every guest", async () => {
    const t = await setup();
    const guest = t.cookieOf(
      (await t.join("locked-room-here", "otter-maple-42")).setCookie,
    );
    t.rooms
      .get("/locked-room-here")!
      .access.apply({ action: "regenerate" }, () => "brand-new-pass");
    expect((await t.call("GET", "/member", { cookie: guest })).status).toBe(
      401,
    );
    expect(
      (await t.call("GET", "/session", { cookie: guest })).body.guestRooms,
    ).toEqual([]);
  });

  it("turning the password on after it was off revokes guests who joined while it was open", async () => {
    const t = await setup();
    const guest = t.cookieOf((await t.join("open-room-here")).setCookie);
    expect((await t.call("GET", "/member", { cookie: guest })).status).toBe(
      200,
    );
    t.rooms
      .get("/open-room-here")!
      .access.apply({ action: "enable", enabled: true });
    expect((await t.call("GET", "/member", { cookie: guest })).status).toBe(
      401,
    );
  });

  it("grants expire after 30 days", async () => {
    const t = await setup();
    const guest = t.cookieOf(
      (await t.join("locked-room-here", "otter-maple-42")).setCookie,
    );
    t.tick(GUEST_TTL_MS - 1);
    expect((await t.call("GET", "/member", { cookie: guest })).status).toBe(
      200,
    );
    t.tick(1);
    expect((await t.call("GET", "/member", { cookie: guest })).status).toBe(
      401,
    );
  });

  it("a grant for a deleted/unknown room doesn't count", async () => {
    const t = await setup();
    const token = signGuestGrants(t.auth.guestKey, [
      {
        roomId: "/gone-room-x",
        epoch: 0,
        guestId: "abcdefgh1234",
        expiresAt: t.now() + 1000,
      },
    ]);
    expect(
      (await t.call("GET", "/member", { cookie: `${GUEST_COOKIE}=${token}` }))
        .status,
    ).toBe(401);
  });

  it("a forged guest cookie is rejected", async () => {
    const t = await setup();
    const other = createAuth({ password: "x", sessionSecret: "other-secret" });
    const token = signGuestGrants(other.guestKey, [
      {
        roomId: "/locked-room-here",
        epoch: 0,
        guestId: "abcdefgh1234",
        expiresAt: t.now() + 1000,
      },
    ]);
    const cookie = `${GUEST_COOKIE}=${token}`;
    expect((await t.call("GET", "/member", { cookie })).status).toBe(401);
    // ...and a guest cookie is never an owner session
    expect(
      (await t.call("GET", "/owner", { cookie: `wp_session=${token}` })).status,
    ).toBe(401);
  });
});

describe("admitSocket", () => {
  it("admits owners and valid guests of that room (also when it's open); refuses the rest", async () => {
    const t = await setup();
    const owner = await t.ownerCookie();
    expect(t.roomAuth.admitSocket(owner, "/locked-room-here")).toEqual({
      owner: true,
    });
    expect(t.roomAuth.admitSocket(undefined, "/locked-room-here")).toBeNull();
    // No grant: refused even while the password is off (the join screen gets one without a password)
    expect(t.roomAuth.admitSocket(undefined, "/open-room-here")).toBeNull();
    expect(t.roomAuth.admitSocket(undefined, "/unknown-room")).toBeNull();

    const guest = t.cookieOf(
      (await t.join("locked-room-here", "otter-maple-42")).setCookie,
    );
    const admitted = t.roomAuth.admitSocket(guest, "/locked-room-here");
    expect(admitted).toEqual({ owner: false, guestId: expect.any(String) });
    // A guest of one room isn't a guest of another
    const third = RoomAccess.create(() => "third-pass-03");
    t.rooms.set("/third-room-x", { access: third, title: "" });
    expect(t.roomAuth.admitSocket(guest, "/third-room-x")).toBeNull();

    // Kicked from an open room: refused while the grant is revoked
    const openGuest = t.cookieOf((await t.join("open-room-here")).setCookie);
    const admittedOpen = t.roomAuth.admitSocket(openGuest, "/open-room-here");
    expect(admittedOpen).toEqual({ owner: false, guestId: expect.any(String) });
    t.rooms
      .get("/open-room-here")!
      .access.revoke((admittedOpen as { guestId: string }).guestId);
    expect(t.roomAuth.admitSocket(openGuest, "/open-room-here")).toBeNull();
  });

  it("everyone is an owner while auth is disabled", async () => {
    const t = await setup({ password: "" });
    expect(t.roomAuth.admitSocket(undefined, "/locked-room-here")).toEqual({
      owner: true,
    });
    expect((await t.call("GET", "/member")).status).toBe(200);
    expect((await t.call("GET", "/rooms/locked-room-here/info")).body).toEqual({
      title: "Movie night",
      passwordRequired: false,
    });
    const joined = await t.join("locked-room-here");
    expect(joined.status).toBe(200);
    expect(joined.setCookie).toBe("");
  });
});
