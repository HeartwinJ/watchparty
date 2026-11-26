import type React from "react";
import { IconPlayerPlayFilled } from "@tabler/icons-react";
import { navigate } from "../../router";
import styles from "./Brand.module.css";

/** The copper play-button logo. */
export const Logo = ({ size = 28 }: { size?: number }) => (
  <span
    className={styles.logo}
    style={{ width: size, height: size }}
    aria-hidden="true"
  >
    <IconPlayerPlayFilled size={Math.round(size / 2)} />
  </span>
);

/** Logo + "WatchParty", linking home (client-side navigation). `link={false}` (room guests) is just the logo. */
export const Brand = ({
  showWord = true,
  className,
  link = true,
}: {
  showWord?: boolean;
  className?: string;
  link?: boolean;
}) => {
  if (!link) {
    return (
      <span className={`${styles.brand} ${className ?? ""}`}>
        <Logo />
        {showWord && <span className={styles.word}>WatchParty</span>}
      </span>
    );
  }
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate("/");
  };
  return (
    <a
      href="/"
      onClick={onClick}
      className={`${styles.brand} ${className ?? ""}`}
      aria-label="WatchParty home"
    >
      <Logo />
      {showWord && <span className={styles.word}>WatchParty</span>}
    </a>
  );
};
