import { useEffect, useState } from "react";
import { apiFetch } from "../../../utils/api";

let openSubtitlesProbe: Promise<boolean> | undefined;

/**
 * Whether the server has an OpenSubtitles API key (the file-name search routes answer 503
 * opensubtitles_not_configured without one). Checked once per page load; errors from an actual search still show as
 * errors in FileNameSearch.
 */
export function isOpenSubtitlesConfigured(): Promise<boolean> {
  openSubtitlesProbe ??= apiFetch("/searchSubtitles/status")
    .then((r) => (r.ok ? r.json() : { configured: true }))
    .then((j: { configured?: unknown }) => j.configured !== false)
    .catch(() => true);
  return openSubtitlesProbe;
}

/** Test helper */
export function resetOpenSubtitlesProbe() {
  openSubtitlesProbe = undefined;
}

/** False until the server says the OpenSubtitles API key works (so the secondary link doesn't flash in) */
export function useOpenSubtitlesAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    isOpenSubtitlesConfigured().then((ok) => live && setAvailable(ok));
    return () => {
      live = false;
    };
  }, []);
  return available;
}
