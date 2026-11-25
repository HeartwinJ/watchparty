import type React from "react";
import { avatarColor, initials } from "./avatar";
import styles from "./Avatar.module.css";

/**
 * A round user avatar: the picture if there is one, otherwise initials on a colour derived from the
 * user id (`--wp-avatar-*`).
 */
export const UserAvatar = ({
  id,
  name,
  picture,
  size = 28,
  presence,
  className,
}: {
  id: string;
  name?: string;
  picture?: string;
  size?: number;
  /** Shows a small green presence dot */
  presence?: boolean;
  className?: string;
}) => {
  const style = {
    "--av-c": avatarColor(id),
    width: size,
    height: size,
    fontSize: Math.max(10, Math.round(size * 0.4)),
  } as React.CSSProperties;
  return (
    <span
      className={`${styles.avatar} ${className ?? ""}`}
      style={style}
      aria-hidden="true"
    >
      {picture ? (
        <img src={picture} alt="" className={styles.img} />
      ) : (
        initials(name)
      )}
      {presence && <span className={styles.presence} />}
    </span>
  );
};

/** Overlapping avatars with a "+N" for the rest. */
export const AvatarStack = ({
  users,
  max = 4,
  size = 26,
}: {
  users: { id: string; name?: string; picture?: string }[];
  max?: number;
  size?: number;
}) => {
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return (
    <span
      className={styles.stack}
      title={users.map((u) => u.name || u.id).join(", ")}
    >
      {shown.map((u) => (
        <UserAvatar
          key={u.id}
          id={u.id}
          name={u.name}
          picture={u.picture}
          size={size}
          className={styles.stacked}
        />
      ))}
      {rest > 0 && (
        <span
          className={`${styles.avatar} ${styles.stacked} ${styles.more}`}
          style={{ width: size, height: size }}
          aria-hidden="true"
        >
          +{rest}
        </span>
      )}
    </span>
  );
};
