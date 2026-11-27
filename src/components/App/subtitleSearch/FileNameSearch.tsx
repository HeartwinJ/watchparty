import { useCallback, useEffect, useRef, useState } from "react";
import { Loader } from "@mantine/core";
import { IconChevronRight, IconFileSearch } from "@tabler/icons-react";
import { apiFetch } from "../../../utils/api";
import { serverPath } from "../../../utils/utils";
import { toast } from "../ui/toast";
import {
  ErrorState,
  LoadingState,
  PaletteFoot,
  PaletteHead,
  PaletteModal,
  arrowKeysBetweenRows,
  LoadHint,
  cx,
  picker,
  styles,
  useEscape,
  usePhone,
} from "./palette";

/** One OpenSubtitles.com API result (the fields we show; GET /searchSubtitles passes the API's `data` through) */
export interface OpenSubtitlesResult {
  id: string;
  attributes: {
    release?: string;
    language?: string;
    download_count?: number;
    hearing_impaired?: boolean;
    fps?: number;
    ai_translated?: boolean;
    machine_translated?: boolean;
    files?: { file_id: number; file_name?: string }[];
  };
}

function subtitleErrorMessage(body: unknown): string {
  const b = body as { error?: string; message?: string } | null;
  if (b?.error === "opensubtitles_not_configured") {
    return "Subtitle search isn't set up on this server (OPENSUBTITLES_KEY).";
  }
  return `OpenSubtitles: ${b?.message ?? "request failed"}`;
}

/** "Some.Movie.WEB" · "English · HI · 23.976 fps · 1.2k downloads" */
export function describeResult(r: OpenSubtitlesResult) {
  const a = r.attributes;
  const file = a.files?.[0];
  const title = a.release?.trim() || file?.file_name || "Untitled subtitle";
  let language = a.language ?? "";
  try {
    language =
      (a.language &&
        new Intl.DisplayNames(["en"], { type: "language" }).of(a.language)) ||
      language;
  } catch {
    // Not a valid language tag: keep the code
  }
  const n = a.download_count ?? 0;
  const meta = [
    language,
    a.hearing_impaired && "Hearing impaired",
    (a.ai_translated || a.machine_translated) && "Machine translated",
    a.fps ? `${a.fps} fps` : "",
    n > 0 &&
      `${n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : n} downloads`,
  ].filter(Boolean);
  return {
    title,
    meta: meta.join(" · "),
    lang: (a.language?.split("-")[0] || "?").toUpperCase(),
    fileId: file?.file_id,
  };
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; results: OpenSubtitlesResult[]; query: string }
  | { status: "error"; message: string };

/**
 * "Search by file name (OpenSubtitles API)": the second step of "Search subtitles…", for releases the title search
 * doesn't match. Searches OpenSubtitles.com with the server's key (GET /searchSubtitles, pre-filled with the video's
 * name and run on open); picking a result downloads it to our server (GET /downloadSubtitles, which counts against
 * the key's daily quota) and makes it the room subtitle. Same palette as the title search.
 */
export function FileNameSearch(props: {
  opened: boolean;
  onClose: () => void;
  /** Back to the title search */
  onBack: () => void;
  initialQuery: string;
  /** Sets the room subtitle (CMD:subtitle) */
  setRoomSubtitle: (url: string) => void;
}) {
  const phone = usePhone();
  return (
    <PaletteModal
      opened={props.opened}
      onClose={props.onClose}
      label="Search OpenSubtitles by file name"
      phone={phone}
    >
      <FileNameSearchBody {...props} phone={phone} />
    </PaletteModal>
  );
}

function FileNameSearchBody({
  onClose,
  onBack,
  initialQuery,
  setRoomSubtitle,
  phone,
}: Parameters<typeof FileNameSearch>[0] & { phone: boolean }) {
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<State>({ status: "idle" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const search = useCallback(async (q: string) => {
    const mine = ++seq.current;
    if (!q.trim()) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    try {
      const resp = await apiFetch(
        "/searchSubtitles?title=" + encodeURIComponent(q.trim()),
      );
      const json = await resp.json().catch(() => null);
      if (!live.current || mine !== seq.current) {
        return;
      }
      if (!resp.ok || !Array.isArray(json)) {
        setState({ status: "error", message: subtitleErrorMessage(json) });
        return;
      }
      setState({ status: "done", results: json, query: q.trim() });
    } catch (e) {
      if (live.current && mine === seq.current) {
        setState({
          status: "error",
          message: (e as Error)?.message || "Something went wrong",
        });
      }
    }
  }, []);

  // Search for what's playing right away (searching doesn't count against the download quota)
  useEffect(() => {
    search(initialQuery);
    inputRef.current?.focus();
  }, [initialQuery, search]);

  useEscape(() => {
    onBack();
    return true;
  }, onClose);

  const pick = async (r: OpenSubtitlesResult) => {
    const { title, fileId } = describeResult(r);
    setBusyId(r.id);
    try {
      const resp = await apiFetch("/downloadSubtitles?file_id=" + fileId);
      const data = await resp.json().catch(() => null);
      if (!live.current) {
        return;
      }
      if (!resp.ok || !data?.link) {
        toast(subtitleErrorMessage(data), {
          tone: "danger",
          id: "subtitle-download",
        });
        setBusyId(null);
        return;
      }
      setRoomSubtitle(serverPath + data.link);
      toast(`“${title}” loaded for everyone`, {
        tone: "success",
        id: "subtitle-download",
      });
      onClose();
    } catch (e) {
      if (live.current) {
        toast(subtitleErrorMessage({ message: (e as Error)?.message }), {
          tone: "danger",
          id: "subtitle-download",
        });
        setBusyId(null);
      }
    }
  };

  return (
    <div
      className={picker.modalBody}
      onKeyDown={arrowKeysBetweenRows(listRef, inputRef)}
    >
      <PaletteHead
        inputRef={inputRef}
        value={query}
        onChange={setQuery}
        onSubmit={() => search(query)}
        onBack={onBack}
        onClose={onClose}
        busy={state.status === "loading"}
        label="File or release name"
        placeholder="Search OpenSubtitles by file or release name"
      />
      <nav className={picker.crumbs} aria-label="Breadcrumbs">
        <button type="button" className={picker.crumb} onClick={onBack}>
          Search by title
        </button>
        <IconChevronRight size={14} aria-hidden />
        <span className={picker.crumbCurrent} aria-current="page">
          By file name
        </span>
      </nav>
      <div ref={listRef} className={picker.body}>
        {state.status === "idle" && (
          <div className={picker.hint}>
            Type the video's file or release name and press Enter.
          </div>
        )}
        {state.status === "loading" && (
          <LoadingState text="Searching OpenSubtitles…" />
        )}
        {state.status === "error" && (
          <ErrorState message={state.message} onRetry={() => search(query)} />
        )}
        {state.status === "done" && state.results.length === 0 && (
          <div className={picker.empty}>
            No subtitles found for “{state.query}”.
          </div>
        )}
        {state.status === "done" && state.results.length > 0 && (
          <>
            <div className={styles.quota}>
              Each pick downloads from OpenSubtitles.com, which allows only a
              few downloads a day.
            </div>
            <div className={picker.groupLabel}>
              <IconFileSearch size={14} aria-hidden /> Releases
              <span className={styles.count}>{state.results.length}</span>
            </div>
            <ul className={styles.list} aria-label="Subtitles">
              {state.results.map((r) => {
                const d = describeResult(r);
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      data-row
                      className={cx(picker.item, styles.row)}
                      disabled={busyId !== null || d.fileId === undefined}
                      aria-busy={busyId === r.id || undefined}
                      onClick={() => pick(r)}
                    >
                      <span
                        className={cx(picker.lead, styles.lang)}
                        aria-hidden
                      >
                        {d.lang}
                      </span>
                      <span className={cx(picker.grow, styles.lines)}>
                        <span className={picker.title} title={d.title}>
                          {d.title}
                        </span>
                        {d.meta && (
                          <span className={picker.meta}>{d.meta}</span>
                        )}
                      </span>
                      {busyId === r.id ? <Loader size="xs" /> : <LoadHint />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      {!phone && (
        <PaletteFoot phone={phone} right="Subtitles from OpenSubtitles.com" />
      )}
    </div>
  );
}
