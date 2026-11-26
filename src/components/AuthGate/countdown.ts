import { useEffect, useState } from "react";

/** "0:42" */
export function formatCountdown(totalSec: number): string {
  const sec = Math.max(0, Math.ceil(totalSec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** Seconds left until `until` (ms), ticking once a second; 0 once it has passed. */
export function useCountdown(until: number | null): number {
  const remaining = () =>
    until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const [left, setLeft] = useState(remaining);
  useEffect(() => {
    setLeft(remaining());
    if (until === null) {
      return;
    }
    const timer = window.setInterval(() => {
      const next = remaining();
      setLeft(next);
      if (next <= 0) {
        window.clearInterval(timer);
      }
    }, 1000);
    return () => window.clearInterval(timer);
    // remaining only depends on until
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  return left;
}
