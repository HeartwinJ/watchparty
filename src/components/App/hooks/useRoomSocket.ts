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

/**
 * Every server event the room listens to. A Record (not an array) so TypeScript fails when an event is added to
 * ServerToClientEvents but not here, which would otherwise silently drop it.
 */
const SERVER_EVENT_SET: Record<keyof ServerToClientEvents, true> = {
  errorMessage: true,
  successMessage: true,
  kicked: true,
  "REC:play": true,
  "REC:pause": true,
  "REC:seek": true,
  "REC:playbackRate": true,
  "REC:subtitle": true,
  "REC:subtitleOffset": true,
  "REC:loop": true,
  "REC:host": true,
  "REC:chat": true,
  "REC:addReaction": true,
  "REC:removeReaction": true,
  "REC:tsMap": true,
  "REC:nameMap": true,
  "REC:pictureMap": true,
  roster: true,
  chatinit: true,
  playlist: true,
  "REC:videoMeta": true,
  "REC:playbackIssue": true,
  "REC:nextEpisode": true,
  signalSS: true,
  "REC:roomSettings": true,
  "REC:readyCheck": true,
  "REC:roomAccess": true,
  "REC:accessRevoked": true,
};
export const SERVER_EVENTS = Object.keys(
  SERVER_EVENT_SET,
) as (keyof ServerToClientEvents)[];

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
        // Our session or room access expired or was revoked: AuthGate shows the instance login (owners) or the
        // room password screen (guests)
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
