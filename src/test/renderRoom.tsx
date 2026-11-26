// Rendering room UI pieces without a socket: `fakeRoom()` builds a `Room` whose commands and actions are mocks and
// whose state is a real `createInitialRoomState()` plus overrides; `renderUi()` wraps in Mantine, auth and RoomUi.
import { render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { vi, type Mock } from "vitest";
import type React from "react";
import { AuthContext } from "../components/AuthGate/AuthGate";
import { RoomUiProvider } from "../components/App/ui/RoomUi";
import type { Room } from "../components/App/hooks/useRoom";
import {
  createInitialRoomState,
  type RoomState,
} from "../components/App/roomState";

/** A record whose every property is a vi.fn() (created on first access, so any command name works) */
function mockRecord(): Record<string, Mock> {
  const fns: Record<string, Mock> = {};
  return new Proxy(fns, {
    get(target, key: string) {
      if (typeof key !== "string" || key === "then") return undefined;
      if (!target[key]) target[key] = vi.fn();
      return target[key];
    },
  });
}

/** Every function property of T is also a Mock of itself */
type Mocked<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? T[K] & Mock<(...args: A) => R>
    : T[K];
};

export type FakeRoom = Room & {
  cmd: Mocked<Room["cmd"]>;
  playlist: Mocked<Room["playlist"]>;
  player: Mocked<Room["player"]>;
  share: Mocked<Room["share"]>;
  subtitles: Mocked<Room["subtitles"]>;
  convert: Mocked<Room["convert"]>;
  call: Mocked<Room["call"]>;
  store: { get: () => RoomState; set: Mock };
  updateName: Room["updateName"] & Mock<Room["updateName"]>;
  getMediaDisplayName: Room["getMediaDisplayName"] &
    Mock<Room["getMediaDisplayName"]>;
};

export function fakeRoom(
  over: Partial<RoomState> = {},
  extra: Record<string, unknown> = {},
): FakeRoom {
  let state: RoomState = { ...createInitialRoomState(), ...over };
  const store = {
    get: () => state,
    set: vi.fn((patch: any) => {
      const changes = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...changes };
      room.state = state;
    }),
  };
  const room: any = {
    state,
    store,
    clientId: "me",
    cmd: mockRecord(),
    socket: undefined,
    chatRef: { current: null },
    player: mockRecord(),
    convert: Object.assign(mockRecord(), { status: null }),
    share: mockRecord(),
    playlist: mockRecord(),
    subtitles: mockRecord(),
    subsync: mockRecord(),
    readyCheck: mockRecord(),
    call: mockRecord(),
    showError: vi.fn(),
    updateName: vi.fn(),
    getMediaDisplayName: vi.fn((url: string) => url),
    ...extra,
  };
  return room as FakeRoom;
}

export interface RenderUiOptions {
  role?: "owner" | "guest";
  authRequired?: boolean;
  /** Wrap in RoomUiProvider (default true) */
  roomUi?: boolean;
  logout?: () => Promise<void>;
  roomAccessLost?: (roomId: string, reason: string) => void;
}

export function Providers({
  children,
  role = "owner",
  authRequired = true,
  roomUi = true,
  logout = async () => {},
  roomAccessLost = () => {},
}: RenderUiOptions & { children: React.ReactNode }) {
  return (
    <MantineProvider env="test">
      <Notifications />
      <AuthContext.Provider
        value={{ authRequired, role, logout, roomAccessLost } as any}
      >
        {roomUi ? <RoomUiProvider>{children}</RoomUiProvider> : children}
      </AuthContext.Provider>
    </MantineProvider>
  );
}

/** render() inside MantineProvider (env="test": no transitions), Notifications, AuthContext and RoomUiProvider */
export function renderUi(ui: React.ReactElement, opts: RenderUiOptions = {}) {
  const result = render(ui, {
    wrapper: ({ children }) => <Providers {...opts}>{children}</Providers>,
  });
  return result;
}
