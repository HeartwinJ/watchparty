import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth.ts";

async function startApp(auth: ReturnType<typeof createAuth>) {
  const app = express();
  app.use(express.json());
  auth.register(app);
  app.get("/protected", auth.requireAuth, (_req, res) => {
    res.json({ ok: true });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

const login = (base: string, password: unknown) =>
  fetch(base + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

describe("auth routes", () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    ({ server, base } = await startApp(
      createAuth({ password: "pw", sessionSecret: "s", loginMax: 3 }),
    ));
  });
  afterAll(() => {
    server.close();
  });

  it("reports session state and protects routes", async () => {
    const session = await (await fetch(base + "/session")).json();
    expect(session).toEqual({ authenticated: false, authRequired: true });
    const resp = await fetch(base + "/protected");
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: "unauthorized" });
  });

  it("logs in, sets an httpOnly cookie and logs out", async () => {
    const resp = await login(base, "pw");
    expect(resp.status).toBe(204);
    const setCookie = resp.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^wp_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    // Plain http, so not Secure
    expect(setCookie).not.toMatch(/Secure/i);
    const cookie = setCookie.split(";")[0];
    expect(
      (await fetch(base + "/protected", { headers: { cookie } })).status,
    ).toBe(200);
    expect(
      await (await fetch(base + "/session", { headers: { cookie } })).json(),
    ).toEqual({ authenticated: true, authRequired: true });
    const out = await fetch(base + "/logout", { method: "POST" });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/wp_session=;/);
  });

  it("rejects bad passwords and rate limits", async () => {
    // One attempt was used by the successful login above (max 3)
    const bad = await login(base, "nope");
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid_password" });
    expect((await login(base, "nope")).status).toBe(401);
    const limited = await login(base, "pw");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });
});

describe("auth disabled", () => {
  it("lets everything through when no password is set", async () => {
    const { server, base } = await startApp(
      createAuth({ password: "", sessionSecret: "" }),
    );
    try {
      expect(await (await fetch(base + "/session")).json()).toEqual({
        authenticated: true,
        authRequired: false,
      });
      expect((await fetch(base + "/protected")).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
