// Per-room guest access: the room password, whether it's required, the password epoch and revoked guest ids.
// Owners (instance session) always have access; guests need a grant (utils/guestToken.ts) whose epoch matches.
import { checkPassword } from "./utils/session.ts";
import type { GuestGrant } from "./utils/guestToken.ts";
import { makeRoomPassword } from "./utils/moniker.ts";

export const ROOM_PASSWORD_MIN = 4;
export const ROOM_PASSWORD_MAX = 64;
/** Kicked guest ids remembered per room (oldest dropped first). Bumping the epoch clears the list. */
export const MAX_REVOKED_GUESTS = 200;

/** Persisted with the room (Room.serialize). The password is a low-value shared secret owners read back. */
export interface RoomAccessData {
  password: string;
  enabled: boolean;
  epoch: number;
  revoked: string[];
}

// Control characters, line/paragraph separators and bidi overrides aren't allowed in a custom password
const UNSAFE_CHARS = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/** A custom room password: trimmed, 4–64 characters, no control characters. Undefined if invalid. */
export function normalizeRoomPassword(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > ROOM_PASSWORD_MAX * 4) {
    return undefined;
  }
  const pw = raw.trim();
  const length = Array.from(pw).length;
  if (
    length < ROOM_PASSWORD_MIN ||
    length > ROOM_PASSWORD_MAX ||
    UNSAFE_CHARS.test(pw)
  ) {
    return undefined;
  }
  return pw;
}

/** CMD:roomPassword: what an owner wants to change */
export type RoomPasswordCommand =
  | { action: "regenerate" }
  | { action: "set"; password: string }
  | { action: "enable"; enabled: boolean };

export function parseRoomPasswordCommand(
  raw: unknown,
): RoomPasswordCommand | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const data = raw as Record<string, unknown>;
  if (data.action === "regenerate") {
    return { action: "regenerate" };
  }
  if (data.action === "set") {
    const password = normalizeRoomPassword(data.password);
    return password === undefined ? undefined : { action: "set", password };
  }
  if (data.action === "enable" && typeof data.enabled === "boolean") {
    return { action: "enable", enabled: data.enabled };
  }
  return undefined;
}

/** What changed: drives the chat line, and whether connected guests lose access */
export type RoomAccessChange = "changed" | "on" | "off";

export class RoomAccess {
  public password: string;
  public enabled: boolean;
  public epoch: number;
  private revoked: string[];

  constructor(data: RoomAccessData) {
    this.password = data.password;
    this.enabled = data.enabled;
    this.epoch = data.epoch;
    this.revoked = data.revoked;
  }

  /** A fresh, password-protected access state (new rooms) */
  static create(generate: () => string = makeRoomPassword): RoomAccess {
    return new RoomAccess({
      password: generate(),
      enabled: true,
      epoch: 0,
      revoked: [],
    });
  }

  /**
   * From stored data. Anything missing or invalid (rooms from before room passwords) gets a generated password with
   * the password required, so old rooms don't become open.
   */
  static from(
    raw: unknown,
    generate: () => string = makeRoomPassword,
  ): RoomAccess {
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    const password = normalizeRoomPassword(d.password);
    if (password === undefined) {
      return RoomAccess.create(generate);
    }
    return new RoomAccess({
      password,
      enabled: d.enabled !== false,
      epoch:
        Number.isSafeInteger(d.epoch) && (d.epoch as number) >= 0
          ? (d.epoch as number)
          : 0,
      revoked: Array.isArray(d.revoked)
        ? d.revoked
            .filter((id): id is string => typeof id === "string")
            .slice(-MAX_REVOKED_GUESTS)
        : [],
    });
  }

  serialize(): RoomAccessData {
    return {
      password: this.password,
      enabled: this.enabled,
      epoch: this.epoch,
      revoked: [...this.revoked],
    };
  }

  /** Whether the join form's password is right (constant time). Always true while the password is off. */
  checkPassword(input: unknown): boolean {
    if (!this.enabled) {
      return true;
    }
    return checkPassword(input, this.password);
  }

  /** Whether a (signature-verified, unexpired) grant still gives access to this room */
  isGrantValid(grant: GuestGrant): boolean {
    return grant.epoch === this.epoch && !this.revoked.includes(grant.guestId);
  }

  isRevoked(guestId: string): boolean {
    return this.revoked.includes(guestId);
  }

  revoke(guestId: string) {
    if (!this.revoked.includes(guestId)) {
      this.revoked.push(guestId);
      if (this.revoked.length > MAX_REVOKED_GUESTS) {
        this.revoked.splice(0, this.revoked.length - MAX_REVOKED_GUESTS);
      }
    }
  }

  /** Every existing guest grant stops working (and the revoked list is no longer needed) */
  private bumpEpoch() {
    this.epoch += 1;
    this.revoked = [];
  }

  /**
   * Applies an owner's command. Returns what changed (undefined for a no-op). A new password or turning the
   * password on bumps the epoch, which revokes every guest; turning it off keeps existing grants.
   */
  apply(
    cmd: RoomPasswordCommand,
    generate: () => string = makeRoomPassword,
  ): RoomAccessChange | undefined {
    switch (cmd.action) {
      case "regenerate":
      case "set": {
        const password = cmd.action === "set" ? cmd.password : generate();
        if (password === this.password && this.enabled) {
          return undefined;
        }
        const wasEnabled = this.enabled;
        this.password = password;
        this.enabled = true;
        this.bumpEpoch();
        return wasEnabled ? "changed" : "on";
      }
      case "enable": {
        if (cmd.enabled === this.enabled) {
          return undefined;
        }
        this.enabled = cmd.enabled;
        if (cmd.enabled) {
          this.bumpEpoch();
          return "on";
        }
        return "off";
      }
    }
  }
}
