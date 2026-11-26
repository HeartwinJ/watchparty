import config from "./config.ts";
import { createApp } from "./app.ts";
import { parseMaxIdleDays } from "./roomLifecycle.ts";

// Last-resort safety net: a stray rejected promise shouldn't take down every room.
// Socket handlers are individually guarded in room.ts, this catches anything we missed.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

const ROOM_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ROOM_MAX_IDLE_DAYS = parseMaxIdleDays(config.ROOM_MAX_IDLE_DAYS);

if (!config.APP_PASSWORD) {
  console.warn(
    "[auth] APP_PASSWORD is not set: authentication is DISABLED and anyone who can reach this server can use it",
  );
}
if (config.APP_PASSWORD && !config.SESSION_SECRET) {
  console.warn(
    "[auth] SESSION_SECRET is not set: using a random secret, so sessions reset when the server restarts",
  );
}
// Routes, Socket.IO and the in-memory rooms live in app.ts
const { server, rooms, persist, prune, sweepRooms, saveAndClose } = createApp();

// Persist active rooms every second, and unload rooms that are empty and idle (roomLifecycle.ts).
// Unloaded rooms are reloaded from SQLite when someone connects (see io.engine.use in app.ts).
const saveInterval = setInterval(persist, 1000);
const pruneInterval = setInterval(prune, 60 * 60 * 1000);

// Delete rooms nobody has been in for ROOM_MAX_IDLE_DAYS: at startup, then daily
let sweepInterval: NodeJS.Timeout | undefined;
if (ROOM_MAX_IDLE_DAYS > 0) {
  sweepRooms(ROOM_MAX_IDLE_DAYS);
  sweepInterval = setInterval(
    () => sweepRooms(ROOM_MAX_IDLE_DAYS),
    ROOM_SWEEP_INTERVAL_MS,
  );
  sweepInterval.unref();
}

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("[shutdown] %s received, saving %s rooms", signal, rooms.size);
  clearInterval(saveInterval);
  clearInterval(pruneInterval);
  clearInterval(sweepInterval);
  saveAndClose();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(Number(config.PORT), config.HOST, () => {
  console.log("listening on %s:%s", config.HOST, config.PORT);
});
