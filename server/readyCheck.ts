// Ready check: when someone buffers or joins mid-play, pause the room until every viewer has enough
// buffered, then resume. This module is the pure state machine; Room (room.ts) feeds it events and applies the
// effects it returns (pause/seek/play broadcasts and REC:readyCheck).

/** What a client reports with CMD:readyState */
export interface ReadyReport {
  /** Enough buffered ahead to play (or nothing that could block: no media, screen/file share, live) */
  ready: boolean;
  /** Stalled during playback for longer than the client's debounce (~1.5 s) */
  buffering: boolean;
  /** The client's room time when it reported (used to line everyone up at the stalled viewer's position) */
  time?: number;
}

export interface ReadyCheckTiming {
  /** Resume anyway after this long */
  timeoutMs: number;
  /** Viewers who haven't reported within this long after the check started (or after joining) stop blocking */
  graceMs: number;
  /** After a check ends, ignore new buffering triggers for this long, so a slow viewer can't pause-loop the room */
  cooldownMs: number;
  /** Longer cooldown after a timeout or "Resume now": someone can't keep up and people chose to carry on */
  giveUpCooldownMs: number;
  /** A reconnect within this long of a "ready" report doesn't count as joining mid-play */
  rejoinMs: number;
}

export const READY_CHECK_TIMING: ReadyCheckTiming = {
  timeoutMs: 30_000,
  graceMs: 5_000,
  cooldownMs: 5_000,
  giveUpCooldownMs: 60_000,
  rejoinMs: 15_000,
};

/** Whether the room could start a check right now (the Room decides: setting on, a video, playing, not a share) */
export interface ReadyCheckContext {
  eligible: boolean;
  /** Everyone in the room (clientIds) */
  members: string[];
  now: number;
}

export type ReadyCheckEffect =
  | {
      type: "start";
      reason: ReadyCheckReason;
      trigger: string;
      /** Seek everyone here (the stalled viewer's position), if known */
      seekTo?: number;
    }
  | { type: "update" }
  | {
      type: "end";
      outcome: ReadyCheckOutcome;
      /** Whether the room should play again (false when someone paused manually or the video changed) */
      resume: boolean;
    };

interface ActiveCheck {
  reason: ReadyCheckReason;
  trigger: string;
  startedAt: number;
  deadline: number;
  waitingFor: string[];
  /** When each waiting viewer that hasn't reported yet started counting against the grace period */
  pendingSince: Map<string, number>;
}

/** Pure ready-check state machine. Every method that changes something returns the effect to apply, or null. */
export class ReadyCheck {
  private timing: ReadyCheckTiming;
  private reports = new Map<string, ReadyReport & { at: number }>();
  /** When each viewer last disconnected (to tell a quick reconnect from joining) */
  private leftAt = new Map<string, number>();
  private active: ActiveCheck | null = null;
  private cooldownUntil = 0;
  /** The last check's outcome, so REC:readyCheck can say how it ended */
  private lastOutcome: ReadyCheckOutcome | undefined;
  private lastActor: string | undefined;

  constructor(timing: Partial<ReadyCheckTiming> = {}) {
    this.timing = { ...READY_CHECK_TIMING, ...timing };
  }

  isActive() {
    return this.active !== null;
  }

  /** The wire state for REC:readyCheck */
  getState(): ReadyCheckState {
    if (this.active) {
      return {
        active: true,
        waitingFor: [...this.active.waitingFor],
        deadline: this.active.deadline,
        reason: this.active.reason,
        trigger: this.active.trigger,
      };
    }
    return {
      active: false,
      waitingFor: [],
      ...(this.lastOutcome ? { outcome: this.lastOutcome } : {}),
      ...(this.lastActor ? { actorId: this.lastActor } : {}),
    };
  }

  /** CMD:readyState */
  report(
    clientId: string,
    report: ReadyReport,
    ctx: ReadyCheckContext,
  ): ReadyCheckEffect | null {
    this.reports.set(clientId, { ...report, at: ctx.now });
    const check = this.active;
    if (check) {
      check.pendingSince.delete(clientId);
      const waiting = check.waitingFor.includes(clientId);
      if (report.ready && waiting) {
        check.waitingFor = check.waitingFor.filter((id) => id !== clientId);
        return this.finishIfDone(ctx.now) ?? { type: "update" };
      }
      if (!report.ready && !waiting && ctx.members.includes(clientId)) {
        // e.g. someone seeked while we wait: they need to buffer too (the deadline stays)
        check.waitingFor.push(clientId);
        return { type: "update" };
      }
      return null;
    }
    if (
      report.buffering &&
      !report.ready &&
      ctx.eligible &&
      ctx.now >= this.cooldownUntil
    ) {
      return this.start("buffering", clientId, ctx, report.time);
    }
    return null;
  }

  /** A viewer connected. Joining mid-play (not a quick reconnect) starts a check that waits for them. */
  join(clientId: string, ctx: ReadyCheckContext): ReadyCheckEffect | null {
    const previous = this.reports.get(clientId);
    const left = this.leftAt.get(clientId);
    const quickRejoin =
      previous?.ready === true &&
      left !== undefined &&
      ctx.now - left < this.timing.rejoinMs;
    this.reports.delete(clientId);
    this.leftAt.delete(clientId);
    const check = this.active;
    if (check) {
      if (!check.waitingFor.includes(clientId)) {
        check.waitingFor.push(clientId);
        check.pendingSince.set(clientId, ctx.now);
        return { type: "update" };
      }
      return null;
    }
    const others = ctx.members.filter((id) => id !== clientId);
    if (
      !ctx.eligible ||
      quickRejoin ||
      others.length === 0 ||
      ctx.now < this.cooldownUntil
    ) {
      return null;
    }
    return this.start("join", clientId, ctx);
  }

  /** A viewer disconnected: they don't block anymore */
  leave(clientId: string, now: number): ReadyCheckEffect | null {
    this.leftAt.set(clientId, now);
    const check = this.active;
    if (!check || !check.waitingFor.includes(clientId)) {
      return null;
    }
    check.waitingFor = check.waitingFor.filter((id) => id !== clientId);
    check.pendingSince.delete(clientId);
    return this.finishIfDone(now) ?? { type: "update" };
  }

  /** CMD:readyCheckSkip: "Resume now" */
  skip(actorId: string, now: number): ReadyCheckEffect | null {
    if (!this.active) {
      return null;
    }
    return this.end("skipped", true, now, actorId);
  }

  /** Someone paused/played manually: stop waiting without touching playback (their command already did) */
  cancel(now: number): ReadyCheckEffect | null {
    if (!this.active) {
      return null;
    }
    return this.end("cancelled", false, now);
  }

  /** The ready check was turned off: stop waiting and play again */
  disable(now: number): ReadyCheckEffect | null {
    if (!this.active) {
      return null;
    }
    return this.end("cancelled", true, now);
  }

  /** The video changed: forget every report (they were about the old video) and stop any check */
  reset(now: number): ReadyCheckEffect | null {
    this.reports.clear();
    this.leftAt.clear();
    const effect = this.cancel(now);
    this.cooldownUntil = 0;
    return effect;
  }

  /** Called about once a second: timeout and the grace period for viewers who never report */
  tick(now: number, members: string[]): ReadyCheckEffect | null {
    // Forget viewers who left a while ago
    for (const [id, at] of this.leftAt) {
      if (now - at >= this.timing.rejoinMs && !members.includes(id)) {
        this.leftAt.delete(id);
        this.reports.delete(id);
      }
    }
    const check = this.active;
    if (!check) {
      return null;
    }
    if (now >= check.deadline) {
      return this.end("timeout", true, now);
    }
    const before = check.waitingFor.length;
    check.waitingFor = check.waitingFor.filter((id) => {
      if (!members.includes(id)) {
        return false;
      }
      const since = check.pendingSince.get(id);
      return since === undefined || now - since < this.timing.graceMs;
    });
    if (check.waitingFor.length !== before) {
      return this.finishIfDone(now) ?? { type: "update" };
    }
    return null;
  }

  private start(
    reason: ReadyCheckReason,
    trigger: string,
    ctx: ReadyCheckContext,
    seekTo?: number,
  ): ReadyCheckEffect {
    const pendingSince = new Map<string, number>();
    const waitingFor = [trigger];
    for (const id of ctx.members) {
      if (id === trigger) {
        continue;
      }
      const r = this.reports.get(id);
      if (!r) {
        // Hasn't reported (yet): waits only for the grace period
        pendingSince.set(id, ctx.now);
        waitingFor.push(id);
      } else if (!r.ready) {
        waitingFor.push(id);
      }
    }
    if (reason === "join") {
      pendingSince.set(trigger, ctx.now);
    }
    this.active = {
      reason,
      trigger,
      startedAt: ctx.now,
      deadline: ctx.now + this.timing.timeoutMs,
      waitingFor,
      pendingSince,
    };
    this.lastOutcome = undefined;
    this.lastActor = undefined;
    return {
      type: "start",
      reason,
      trigger,
      ...(typeof seekTo === "number" && Number.isFinite(seekTo) && seekTo >= 0
        ? { seekTo }
        : {}),
    };
  }

  private finishIfDone(now: number): ReadyCheckEffect | null {
    if (this.active && this.active.waitingFor.length === 0) {
      return this.end("ready", true, now);
    }
    return null;
  }

  private end(
    outcome: ReadyCheckOutcome,
    resume: boolean,
    now: number,
    actorId?: string,
  ): ReadyCheckEffect {
    this.active = null;
    this.lastOutcome = outcome;
    this.lastActor = actorId;
    this.cooldownUntil =
      now +
      (outcome === "timeout" || outcome === "skipped"
        ? this.timing.giveUpCooldownMs
        : this.timing.cooldownMs);
    return { type: "end", outcome, resume };
  }
}

/** Parses CMD:readyState (untrusted) */
export function parseReadyReport(raw: unknown): ReadyReport | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  if (typeof data.ready !== "boolean") {
    return null;
  }
  const time =
    typeof data.time === "number" && Number.isFinite(data.time)
      ? data.time
      : undefined;
  return {
    ready: data.ready,
    buffering: data.buffering === true,
    ...(time !== undefined ? { time } : {}),
  };
}
