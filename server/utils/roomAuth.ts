import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import type { Server } from "socket.io";
import type { RoomAccess } from "../roomAccess.ts";
import {
  GUEST_COOKIE,
  GUEST_TTL_MS,
  addGuestGrant,
  newGuestId,
  signGuestGrants,
  verifyGuestGrants,
  type GuestGrant,
} from "./guestToken.ts";
import { createRateLimiter, parseCookies } from "./session.ts";

/**
 * Owners vs guests.
 * - Owner: a valid instance session (wp_session), or anyone while APP_PASSWORD is blank. Can do everything.
 * - Guest: holds a valid grant for one room (POST /rooms/:roomId/join with that room's password, or without one when
 *   the room's password is off). Guests reach that room's socket and the "member" HTTP APIs the room page uses, never
 *   Home, history or room creation, and can't manage the room (enforced in room.ts via socket.data.owner).
 */

export interface RoomLookup {
  access: RoomAccess;
  title: string;
}

/** What a socket connecting to a room's namespace is: an owner, a guest (with their grant's id), or refused */
export type SocketAdmission =
  { owner: true } | { owner: false; guestId: string | null } | null;

/** Room ids in URLs: the generated names are adjective-noun-verb, older ones may use other word characters */
const ROOM_ID_RE = /^[\w.~-]{1,200}$/;

export function createRoomAuth(opts: {
  auth: {
    authRequired: boolean;
    isAuthenticated: (cookieHeader: string | undefined) => boolean;
    requireAuth: RequestHandler;
  };
  guestKey: Buffer;
  /** Finds a room by namespace id ("/name"), loading it from the database if needed */
  getRoom: (roomId: string) => RoomLookup | undefined;
  /** Wrong passwords (and unknown rooms) per IP before a lockout */
  joinMax?: number;
  /** Wrong passwords per room (any IP) before a lockout */
  roomJoinMax?: number;
  joinWindowMs?: number;
  /** GET /rooms/:roomId/info requests per IP */
  infoMax?: number;
  now?: () => number;
}) {
  const { auth, guestKey, getRoom } = opts;
  const now = opts.now ?? Date.now;
  const windowMs = opts.joinWindowMs ?? 10 * 60 * 1000;
  const ipLimiter = createRateLimiter({ max: opts.joinMax ?? 10, windowMs });
  const roomLimiter = createRateLimiter({
    max: opts.roomJoinMax ?? 30,
    windowMs,
  });
  const infoLimiter = createRateLimiter({ max: opts.infoMax ?? 120, windowMs });

  const isOwner = (cookieHeader: string | undefined) =>
    !auth.authRequired || auth.isAuthenticated(cookieHeader);

  const grantsFrom = (cookieHeader: string | undefined): GuestGrant[] =>
    verifyGuestGrants(
      guestKey,
      parseCookies(cookieHeader)[GUEST_COOKIE],
      now(),
    );

  const validGrant = (
    grant: GuestGrant | undefined,
  ): RoomLookup | undefined => {
    if (!grant) {
      return undefined;
    }
    const room = getRoom(grant.roomId);
    return room && room.access.isGrantValid(grant) ? room : undefined;
  };

  /** Room ids (without the slash) this request is a guest of */
  const guestRooms = (cookieHeader: string | undefined): string[] =>
    grantsFrom(cookieHeader)
      .filter((g) => validGrant(g))
      .map((g) => g.roomId.slice(1));

  /** Owners, or guests with a valid grant for any room: the APIs the room page needs */
  const requireMember: RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const cookie = req.headers.cookie;
    if (isOwner(cookie) || grantsFrom(cookie).some((g) => validGrant(g))) {
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  };

  /** Socket.IO admission to the namespace `roomId` ("/name") */
  const admitSocket = (
    cookieHeader: string | undefined,
    roomId: string,
  ): SocketAdmission => {
    if (isOwner(cookieHeader)) {
      return { owner: true };
    }
    const room = getRoom(roomId);
    if (!room) {
      return null;
    }
    const grant = grantsFrom(cookieHeader).find((g) => g.roomId === roomId);
    if (grant && room.access.isGrantValid(grant)) {
      return { owner: false, guestId: grant.guestId };
    }
    // An open room lets anyone with the link in, except a guest whose grant was revoked (kicked)
    if (
      !room.access.enabled &&
      !(
        grant &&
        grant.epoch === room.access.epoch &&
        room.access.isRevoked(grant.guestId)
      )
    ) {
      return { owner: false, guestId: null };
    }
    return null;
  };

  const roomIdParam = (req: Request): string | undefined => {
    const raw = req.params.roomId;
    return typeof raw === "string" && ROOM_ID_RE.test(raw)
      ? "/" + raw
      : undefined;
  };

  const register = (app: Express) => {
    // Public: the join screen's heading and whether it needs a password. Nothing else about the room.
    app.get("/rooms/:roomId/info", (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const ipKey = req.ip ?? "unknown";
      if (!infoLimiter.hit(ipKey, now())) {
        const retryAfter = Math.max(1, infoLimiter.retryAfterSec(ipKey, now()));
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({ error: "rate_limited", retryAfter });
        return;
      }
      const roomId = roomIdParam(req);
      const room = roomId ? getRoom(roomId) : undefined;
      if (!room) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        title: room.title,
        passwordRequired: auth.authRequired && room.access.enabled,
      });
    });

    app.post("/rooms/:roomId/join", (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const roomId = roomIdParam(req);
      if (!roomId) {
        res.status(400).json({ error: "invalid_params" });
        return;
      }
      const t = now();
      const ipKey = req.ip ?? "unknown";
      const roomKey = roomId;
      const wait = Math.max(
        ipLimiter.blockedSec(ipKey, t),
        roomLimiter.blockedSec(roomKey, t),
      );
      if (wait > 0) {
        // The join form shows a countdown from this
        res.setHeader("Retry-After", String(wait));
        res.status(429).json({ error: "rate_limited", retryAfter: wait });
        return;
      }
      const room = getRoom(roomId);
      if (!room) {
        // Counts against the IP, so room names can't be probed quickly
        ipLimiter.hit(ipKey, t);
        res.status(404).json({ error: "not_found" });
        return;
      }
      const cookie = req.headers.cookie;
      if (isOwner(cookie)) {
        // Owners already have access everywhere
        res.json({ ok: true });
        return;
      }
      const grants = grantsFrom(cookie);
      const existing = grants.find((g) => g.roomId === roomId);
      if (
        existing &&
        existing.epoch === room.access.epoch &&
        room.access.isRevoked(existing.guestId)
      ) {
        // Kicked: blocked from this browser until an owner changes the password
        res.status(403).json({ error: "kicked" });
        return;
      }
      if (!room.access.checkPassword(req.body?.password)) {
        ipLimiter.hit(ipKey, t);
        roomLimiter.hit(roomKey, t);
        res.status(401).json({ error: "invalid_password" });
        return;
      }
      const grant: GuestGrant = {
        roomId,
        epoch: room.access.epoch,
        guestId: newGuestId(),
        expiresAt: t + GUEST_TTL_MS,
      };
      const next = addGuestGrant(grants, grant);
      res.cookie(GUEST_COOKIE, signGuestGrants(guestKey, next), {
        httpOnly: true,
        sameSite: "lax",
        // req.secure honors X-Forwarded-Proto from a trusted proxy (cloudflared)
        secure: req.secure,
        maxAge: Math.max(...next.map((g) => g.expiresAt)) - t,
        path: "/",
      });
      res.json({ ok: true });
    });
  };

  return {
    isOwner,
    requireOwner: auth.requireAuth,
    requireMember,
    guestRooms,
    admitSocket,
    register,
  };
}

/**
 * Socket.IO admission. The main namespace is for owners only; each room's namespace (created later, so call this
 * before creating any room and its middleware runs first) admits owners, guests with a valid grant for that room,
 * and anyone while the room's password is off. Sets socket.data.owner / socket.data.guestId, which room.ts uses to
 * decide who may manage the room. Refused sockets get a connect_error with message "unauthorized".
 */
export function admitRoomSockets(
  io: Server,
  roomAuth: Pick<ReturnType<typeof createRoomAuth>, "isOwner" | "admitSocket">,
) {
  io.use((socket, next) => {
    if (roomAuth.isOwner(socket.request.headers.cookie)) {
      socket.data.owner = true;
      next();
    } else {
      next(new Error("unauthorized"));
    }
  });
  io.on("new_namespace", (nsp) =>
    nsp.use((socket, next) => {
      const admission = roomAuth.admitSocket(
        socket.request.headers.cookie,
        nsp.name,
      );
      if (!admission) {
        next(new Error("unauthorized"));
        return;
      }
      socket.data.owner = admission.owner;
      socket.data.guestId = admission.owner ? null : admission.guestId;
      next();
    }),
  );
}
