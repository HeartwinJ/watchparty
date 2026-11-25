import type React from "react";
import { Logo } from "../Brand/Brand";
import styles from "./StatusPage.module.css";

/**
 * A centred card on the app canvas, for simple full-page states (creating a room, not found,
 * checking the session, server unreachable). Also used by the login screen.
 */
export const StatusPage = ({
  icon,
  title,
  children,
  actions,
  glow,
  brand,
}: {
  icon?: React.ReactNode;
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  /** The copper glow at the top of the page (login) */
  glow?: boolean;
  /** Logo + "WatchParty" at the top of the card */
  brand?: boolean;
}) => (
  <div className={styles.page} data-glow={glow || undefined}>
    <div className={styles.card}>
      {brand && (
        <div className={styles.brand}>
          <Logo />
          <span>WatchParty</span>
        </div>
      )}
      {icon && <div className={styles.icon}>{icon}</div>}
      {title && <h1 className={styles.title}>{title}</h1>}
      {children}
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  </div>
);

export const statusStyles = styles;
