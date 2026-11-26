// Shared fake for socket.io-client in client tests. Use it from a mock factory so the test and the code under test
// share the same `sockets` list:
//
//   vi.mock("socket.io-client", async () => (await import("../../test/fakeSocket")).socketIoModule);
//   const { sockets, resetSockets } = await import("../../test/fakeSocket");
import { vi } from "vitest";

type Listener = (...args: any[]) => void;

export class FakeSocket {
  listeners = new Map<string, Listener[]>();
  emitted: [string, ...unknown[]][] = [];
  disconnected = false;
  connected = false;
  on(event: string, fn: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  off(event: string, fn?: Listener) {
    if (!fn) this.listeners.delete(event);
    else
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((f) => f !== fn),
      );
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.emitted.push([event, ...args]);
    return this;
  }
  disconnect() {
    this.disconnected = true;
    return this;
  }
  close() {
    return this.disconnect();
  }
  /** Simulates an event from the server (events nothing listens to are ignored) */
  receive(event: string, ...args: unknown[]) {
    if (event === "connect") this.connected = true;
    if (event === "disconnect") this.connected = false;
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }
  /** Whether anything subscribed to `event` */
  listens(event: string) {
    return Boolean(this.listeners.get(event)?.length);
  }
  /** The argument lists of every emit of `event` */
  emits(event: string) {
    return this.emitted.filter(([e]) => e === event).map(([, ...a]) => a);
  }
  /** The argument list of the last emit of `event` */
  lastEmit(event: string) {
    return this.emits(event).at(-1);
  }
}

/** Every socket created through the mocked `io()`, oldest first. Clear it with `resetSockets()` in `beforeEach`. */
export const sockets: FakeSocket[] = [];

export const ioMock = vi.fn((..._args: unknown[]) => {
  const s = new FakeSocket();
  sockets.push(s);
  return s;
});

/** The module shape for `vi.mock("socket.io-client", ...)` */
export const socketIoModule = { default: ioMock, io: ioMock };

export function resetSockets() {
  sockets.length = 0;
  ioMock.mockClear();
}
