import { useEffect, useRef, useState } from "react";
import { ActionIcon, Button, Menu, Select, Switch } from "@mantine/core";
import {
  IconDots,
  IconHeadphones,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneOff,
  IconRefresh,
} from "@tabler/icons-react";
import { UserAvatar } from "../../Avatar/Avatar";
import { useAuth } from "../../AuthGate/AuthGate";
import type { Room } from "../hooks/useRoom";
import { inCall, memberConnection } from "./callReducer";
import { joinMuted, MIC_ERROR_TEXT, PTT_KEY } from "./logic";
import styles from "./Call.module.css";

/**
 * The call panel: who's in the call, the microphone (picker + live level), and either Join (pre-join: errors,
 * "headphones recommended") or the in-call controls (mute, ducking, push-to-talk, leave).
 */
export const CallPanel = ({ room }: { room: Room }) => {
  const { state, clientId, call } = room;
  const c = state.call;
  const joined = inCall(c);
  const isOwner = useAuth().role === "owner";
  const mics = useMics(room);

  // Pre-join: open the mic while the panel is open, so the level meter works and labels show up
  const micsRef = useRef(mics);
  micsRef.current = mics;
  useEffect(() => {
    if (inCall(room.store.get().call)) {
      return;
    }
    call.startPreview().then(() => micsRef.current.refresh());
    return () => call.stopPreview();
  }, [call, room.store]);

  const memberName = (id: string) => state.nameMap[id] || "Someone";
  const willJoinMuted = joinMuted(state) && !c.pushToTalk;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.title}>Voice call</span>
        <span className={styles.sub}>
          {c.members.length
            ? `${c.members.length} in the call`
            : "Nobody's in the call yet"}
        </span>
      </div>

      {c.members.length > 0 && (
        <ul className={styles.members} aria-label="In the call">
          {c.members.map((m) => {
            const isMe = m.clientId === clientId;
            const conn = memberConnection(c, m, clientId);
            const muted = isMe && joined ? c.muted && !c.pttHeld : m.muted;
            return (
              <li key={m.clientId} className={styles.member}>
                <UserAvatar
                  id={m.clientId}
                  name={memberName(m.clientId)}
                  picture={state.pictureMap[m.clientId]}
                  size={28}
                  speaking={c.speaking.includes(m.clientId)}
                />
                <span className={styles.memberName}>
                  {memberName(m.clientId)}
                  {isMe && <small> (you)</small>}
                  {conn !== "connected" && joined && (
                    <span className={styles.memberState}>
                      {conn === "reconnecting"
                        ? "Reconnecting…"
                        : "Connecting…"}
                    </span>
                  )}
                </span>
                {muted && (
                  <IconMicrophoneOff
                    size={16}
                    className={styles.mutedIcon}
                    aria-label="Muted"
                  />
                )}
                {!isMe && isOwner && (
                  <MemberMenu
                    name={memberName(m.clientId)}
                    muted={m.muted}
                    onMute={() => call.moderate(m.clientId, "mute")}
                    onRemove={() => call.moderate(m.clientId, "remove")}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {c.micError ? (
        <div className={styles.error} role="alert">
          <div className={styles.errorTitle}>
            {MIC_ERROR_TEXT[c.micError].title}
          </div>
          <div className={styles.errorHint}>
            {MIC_ERROR_TEXT[c.micError].hint}
          </div>
          <Button
            mt="xs"
            size="compact-sm"
            variant="light"
            leftSection={<IconRefresh size={14} />}
            onClick={() => call.startPreview().then(mics.refresh)}
          >
            Try again
          </Button>
        </div>
      ) : (
        <div>
          <Select
            label="Microphone"
            size="sm"
            data={mics.options}
            value={mics.current}
            placeholder="Default microphone"
            onChange={(v) => v && call.setDevice(v).then(mics.refresh)}
            allowDeselect={false}
            comboboxProps={{ withinPortal: false }}
          />
          <LevelMeter room={room} />
        </div>
      )}

      {!joined ? (
        <>
          <div className={styles.note}>
            <IconHeadphones size={16} aria-hidden="true" />
            <span>
              Headphones recommended, so the movie doesn't echo into the call.
            </span>
          </div>
          {willJoinMuted && (
            <div className={styles.sub}>
              The video is playing, so you'll join muted.
            </div>
          )}
          <Button
            fullWidth
            leftSection={<IconMicrophone size={16} />}
            loading={c.busy}
            disabled={Boolean(c.micError)}
            onClick={() => call.join()}
          >
            Join voice call
          </Button>
        </>
      ) : (
        <>
          <Switch
            label="Lower the movie while people talk"
            description="Only on this device"
            checked={c.ducking}
            onChange={(e) => call.setDucking(e.currentTarget.checked)}
          />
          <Switch
            label={`Push to talk (hold ${PTT_KEY.toUpperCase()})`}
            description="Your mic is only on while you hold the key or the mic button"
            checked={c.pushToTalk}
            onChange={(e) => call.setPushToTalk(e.currentTarget.checked)}
          />
          <div className={styles.actions}>
            {!c.pushToTalk && (
              <Button
                variant="default"
                leftSection={
                  c.muted ? (
                    <IconMicrophone size={16} />
                  ) : (
                    <IconMicrophoneOff size={16} />
                  )
                }
                onClick={() => call.toggleMute()}
              >
                {c.muted ? "Unmute" : "Mute"}
              </Button>
            )}
            <Button
              color="var(--wp-danger)"
              variant="light"
              leftSection={<IconPhoneOff size={16} />}
              onClick={call.leave}
            >
              Leave call
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

/** Owners: ask someone to mute (they mute themselves; nobody can unmute you), or remove them from the call */
const MemberMenu = ({
  name,
  muted,
  onMute,
  onRemove,
}: {
  name: string;
  muted: boolean;
  onMute: () => void;
  onRemove: () => void;
}) => (
  <Menu position="bottom-end" width={220} withinPortal={false}>
    <Menu.Target>
      <ActionIcon
        variant="subtle"
        color="gray"
        size={28}
        aria-label={`Call options for ${name}`}
      >
        <IconDots size={16} />
      </ActionIcon>
    </Menu.Target>
    <Menu.Dropdown>
      <Menu.Item
        leftSection={<IconMicrophoneOff size={16} />}
        disabled={muted}
        onClick={onMute}
      >
        Mute in call
      </Menu.Item>
      <Menu.Item
        color="var(--wp-danger)"
        leftSection={<IconPhoneOff size={16} />}
        onClick={onRemove}
      >
        Remove from call
      </Menu.Item>
    </Menu.Dropdown>
  </Menu>
);

/** The mic's live level, drawn straight to the DOM every frame (no React state) */
const LevelMeter = ({ room }: { room: Room }) => {
  const fill = useRef<HTMLDivElement>(null);
  const { call } = room;
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      if (fill.current) {
        fill.current.style.transform = `scaleX(${call.getLevel()})`;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [call]);
  const c = room.state.call;
  const muted = inCall(c) && (c.pushToTalk ? !c.pttHeld : c.muted);
  return (
    <div style={{ marginTop: "var(--wp-sp-2)" }}>
      <div className={styles.meterLabel}>
        <span>Mic level</span>
        <span>{muted ? "Muted" : "Say something to test"}</span>
      </div>
      <div className={styles.meter} role="presentation">
        <div ref={fill} className={styles.meterFill} />
      </div>
    </div>
  );
};

/** The microphones for the picker, refreshed when devices change (labels appear once mic access is granted) */
function useMics(room: Room) {
  const { call } = room;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const refresh = async () => {
    setDevices(await call.listMics());
    setCurrent(call.currentDeviceId());
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    refreshRef.current();
    const onChange = () => refreshRef.current();
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () =>
      navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
  }, []);
  useEffect(() => {
    refreshRef.current();
  }, [room.state.call.status]);
  const options = devices
    .filter((d) => d.deviceId)
    .map((d, i) => ({
      value: d.deviceId,
      label: d.label || `Microphone ${i + 1}`,
    }));
  return {
    options,
    current: options.some((o) => o.value === current) ? current : null,
    refresh,
  };
}
