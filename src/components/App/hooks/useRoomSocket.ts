import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import io from "socket.io-client";
import { notifyUnauthorized } from "../../../utils/api";
import { getOrCreateSessionId, serverPath } from "../../../utils/utils";
import {
  createRoomCommands,
  type RoomSocket,
  type ServerToClientEvents,
} from "../socketEvents";

export type RoomSocketHandlers = ServerToClientEvents & {
  connect: () => void;
  /** Connection errors other than "unauthorized", which this hook handles by returning to the login screen */
  connectError: (err: Error) => void;
  disconnect: (reason: string) => void;
};

const SERVER_EVENTS: (keyof ServerToClientEvents)[] = [
  "errorMessage",
  "successMessage",
  "kicked",
  "REC:play",
  "REC:pause",
  "REC:seek",
  "REC:playbackRate",
  "REC:subtitle",
  "REC:subtitleOffset",
  "REC:loop",
  "REC:host",
  "REC:chat",
  "REC:addReaction",
  "REC:removeReaction",
  "REC:tsMap",
  "REC:nameMap",
  "REC:pictureMap",
  "roster",
  "chatinit",
  "playlist",
  "signalSS",
];

/**
 * The room's Socket.IO connection (one namespace per room). Connects once `enabled`, disconnects on unmount.
 * Handlers are read from `handlersRef` at call time, so they always see the latest closures.
 * Returns the socket (undefined until created) and typed CMD:* emitters.
 */
export function useRoomSocket(
  roomId: string,
  clientId: string,
  enabled: boolean,
  handlersRef: RefObject<RoomSocketHandlers | null>,
) {
  const socketRef = useRef<RoomSocket | undefined>(undefined);
  const [socket, setSocket] = useState<RoomSocket | undefined>(undefined);
  const cmd = useMemo(() => createRoomCommands(() => socketRef.current), []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const s: RoomSocket = io(serverPath + "/" + roomId, {
      transports: ["websocket"],
      // Send the session cookie (the dev client runs on a different port than the server)
      withCredentials: true,
      query: { clientId, roomId },
      auth: { sessionId: getOrCreateSessionId() },
    });
    socketRef.current = s;
    setSocket(s);
    const handlers = () => handlersRef.current!;
    s.on("connect", () => handlers().connect());
    s.on("connect_error", (err) => {
      console.error(err);
      if (err.message === "unauthorized") {
        // Our session expired or was revoked: go back to the login screen
        s.disconnect();
        notifyUnauthorized();
      } else {
        handlers().connectError(err);
      }
    });
    s.on("disconnect", (reason) => handlers().disconnect(reason));
    for (const event of SERVER_EVENTS) {
      s.on(event, (...args: unknown[]) =>
        (handlers()[event] as (...a: unknown[]) => void)(...args),
      );
    }
    return () => {
      s.disconnect();
      socketRef.current = undefined;
    };
  }, [roomId, clientId, enabled, handlersRef]);

  return { socket, cmd };
}
