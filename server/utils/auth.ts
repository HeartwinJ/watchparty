import crypto from "node:crypto";
import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  checkPassword,
  createRateLimiter,
  parseCookies,
  signSession,
  verifySession,
} from "./session.ts";

/**
 * Instance password auth. With no password configured, everything is open.
 */
export function createAuth(opts: {
  password: string;
  sessionSecret: string;
  loginMax?: number;
  loginWindowMs?: number;
}) {
  const authRequired = Boolean(opts.password);
  const secret = opts.sessionSecret || crypto.randomBytes(32).toString("hex");
  const limiter = createRateLimiter({
    max: opts.loginMax ?? 10,
    windowMs: opts.loginWindowMs ?? 10 * 60 * 1000,
  });

  const isAuthenticated = (cookieHeader: string | undefined) =>
    !authRequired ||
    verifySession(secret, parseCookies(cookieHeader)[SESSION_COOKIE]);

  const requireAuth: RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (isAuthenticated(req.headers.cookie)) {
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  };

  const register = (app: Express) => {
    app.get("/session", (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({
        authenticated: isAuthenticated(req.headers.cookie),
        authRequired,
      });
    });

    app.post("/login", (req, res) => {
      const key = req.ip ?? "unknown";
      if (!limiter.hit(key)) {
        // The login form shows a countdown from this
        const retryAfter = Math.max(1, limiter.retryAfterSec(key));
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({ error: "rate_limited", retryAfter });
        return;
      }
      if (authRequired && !checkPassword(req.body?.password, opts.password)) {
        res.status(401).json({ error: "invalid_password" });
        return;
      }
      res.cookie(SESSION_COOKIE, signSession(secret), {
        httpOnly: true,
        sameSite: "lax",
        // req.secure honors X-Forwarded-Proto from a trusted proxy (cloudflared)
        secure: req.secure,
        maxAge: SESSION_TTL_MS,
        path: "/",
      });
      res.status(204).end();
    });

    app.post("/logout", (req, res) => {
      res.clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure,
        path: "/",
      });
      res.status(204).end();
    });
  };

  return { authRequired, isAuthenticated, requireAuth, register };
}
