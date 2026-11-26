import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader, Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChevronRight,
  IconFileSearch,
  IconMovie,
  IconSearch,
  IconSubtitles,
} from "@tabler/icons-react";
import {
  AddonApiError,
  createDebouncedSearch,
  isAbortError,
  getMeta,
  getSubtitles,
  searchTitles,
  type ContentType,
  type Episode,
  type Meta,
  type SearchResults,
  type Subtitle,
  type TitleRef,
} from "../../../api/addons";
import { toast } from "../ui/toast";
import {
  episodeCode,
  findGuessedEpisode,
  groupSubtitlesByLanguage,
  guessSubtitleSearch,
  subtitleTargetLabel,
  type TitleGuess,
} from "./guessTitle";
import { useOpenSubtitlesAvailable } from "./openSubtitlesStatus";
import { shareSubtitleFromUrl } from "./shareSubtitle";
import styles from "./SubtitleSearch.module.css";

type SubtitlesTarget = {
  type: ContentType;
  id: string;
  /** "Breaking Bad · S02E04" */
  label: string;
  /** "episode" or "movie", for the empty state */
  noun: "episode" | "movie";
};

type View =
  | { kind: "search" }
  | { kind: "title"; item: TitleRef }
  | ({ kind: "subtitles" } & SubtitlesTarget);

type Async<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; data: T }
  | { status: "error"; message: string };

/** Error text for a failed lookup ("search" = Cinemeta/Kitsu, "meta" = episodes, "subtitles" = OpenSubtitles) */
function errorText(e: unknown, what: "search" | "meta" | "subtitles"): string {
  if (e instanceof AddonApiError) {
    if (e.code === "upstream_error" || e.code === "upstream_timeout") {
      const source =
        what === "subtitles" ? "OpenSubtitles" : "The title search";
      return e.code === "upstream_timeout"
        ? `${source} took too long to answer`
        : `${source} didn't answer`;
    }
    return e.message;
  }
  return (e as Error)?.message || "Something went wrong";
}

/** Loads `fn()` whenever `key` changes (null = don't load); aborts the previous load. */
function useAsync<T>(
  key: string | null,
  what: "meta" | "subtitles",
  fn: (signal: AbortSignal) => Promise<T>,
): Async<T> & { retry: () => void } {
  const [state, setState] = useState<Async<T>>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (key === null) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fnRef.current(controller.signal).then(
      (data) =>
        !controller.signal.aborted && setState({ status: "done", data }),
      (e) =>
        !controller.signal.aborted &&
        setState({ status: "error", message: errorText(e, what) }),
    );
    return () => controller.abort();
  }, [key, what, attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, retry };
}

/**
 * "Search subtitles…": keyless subtitle search for the room's video. Search a title (Cinemeta + Kitsu via
 * /addon/search), pick a series' season/episode, then a subtitle (OpenSubtitles v3 via /addon/subtitles). The chosen
 * file is stored on our server (POST /subtitle) and set as the room subtitle for everyone (`setRoomSubtitle`, i.e.
 * CMD:subtitle). Pre-filled from what's playing (guessSubtitleSearch); AIOStreams picks open on their subtitles.
 */
export function SubtitleSearch(props: {
  opened: boolean;
  onClose: () => void;
  /** The room's current media URL (only its `#wp-name=` / file name is used, never shown) */
  mediaUrl: string;
  videoMeta: VideoMeta | null;
  /** Sets the room subtitle (CMD:subtitle) */
  setRoomSubtitle: (url: string) => void;
  /** Opens the OpenSubtitles API (file name) search; only offered when the server has a key */
  openFileNameSearch?: () => void;
}) {
  const isPhone = useMediaQuery("(max-width: 768px)", false, {
    getInitialValueInEffect: false,
  });
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title="Search subtitles"
      centered={!isPhone}
      radius="xl"
      size={isPhone ? "100%" : 520}
      zIndex={400}
      transitionProps={isPhone ? { transition: "slide-up" } : undefined}
      classNames={{
        content: isPhone ? `${styles.content} ${styles.sheet}` : styles.content,
        inner: isPhone ? styles.sheetInner : undefined,
        header: styles.header,
        title: styles.title,
        body: styles.body,
      }}
    >
      {props.opened && <SubtitleSearchBody {...props} />}
    </Modal>
  );
}

/** The views inside the modal (exported for tests) */
export function SubtitleSearchBody({
  onClose,
  mediaUrl,
  videoMeta,
  setRoomSubtitle,
  openFileNameSearch,
}: Parameters<typeof SubtitleSearch>[0]) {
  // Guessed once when the view opens, so a video change underneath doesn't reset what the user is doing
  const [start] = useState(() => guessSubtitleSearch(mediaUrl, videoMeta));
  const guess: TitleGuess = start.guess;
  const [views, setViews] = useState<View[]>(() =>
    start.kind === "subtitles"
      ? [
          { kind: "search" },
          {
            kind: "subtitles",
            type: start.type,
            id: start.id,
            label: start.label,
            noun: start.guess.episode !== null ? "episode" : "movie",
          },
        ]
      : [{ kind: "search" }],
  );
  const view = views[views.length - 1];
  const push = (v: View) => setViews((vs) => [...vs, v]);
  const back = () => setViews((vs) => (vs.length > 1 ? vs.slice(0, -1) : vs));
  const fileNameSearchAvailable = useOpenSubtitlesAvailable();

  return (
    <div className={styles.root}>
      {views.length > 1 && (
        <button type="button" className={styles.back} onClick={back}>
          <IconArrowLeft size={16} aria-hidden />
          Back
        </button>
      )}
      {/* The search stays mounted so its query and results survive going deeper and back */}
      <div hidden={view.kind !== "search"}>
        <SearchView
          initialQuery={guess.query}
          active={view.kind === "search"}
          onPick={(item) =>
            item.type === "movie"
              ? push({
                  kind: "subtitles",
                  type: item.kind,
                  id: item.id,
                  label: item.year ? `${item.name} (${item.year})` : item.name,
                  noun: "movie",
                })
              : push({ kind: "title", item })
          }
        />
      </div>
      {view.kind === "title" && (
        <TitleView
          item={view.item}
          guess={guess}
          onPick={(meta, ep) =>
            push({
              kind: "subtitles",
              type: view.item.kind,
              id: ep.id,
              label: subtitleTargetLabel(meta.name, ep.season, ep.episode),
              noun: "episode",
            })
          }
        />
      )}
      {view.kind === "subtitles" && (
        <SubtitlesView
          target={view}
          onLoaded={(url) => {
            setRoomSubtitle(url);
            onClose();
          }}
        />
      )}
      {openFileNameSearch && fileNameSearchAvailable && (
        <div className={styles.foot}>
          <button
            type="button"
            className={styles.link}
            onClick={openFileNameSearch}
          >
            <IconFileSearch size={14} aria-hidden />
            Search by file name (OpenSubtitles API)
          </button>
        </div>
      )}
    </div>
  );
}

const TYPE_LABEL: Record<ContentType, string> = {
  movie: "Movie",
  series: "Show",
  anime: "Anime",
};

function SearchView({
  initialQuery,
  active,
  onPick,
}: {
  initialQuery: string;
  active: boolean;
  onPick: (item: TitleRef) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<Async<SearchResults>>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useMemo(() => createDebouncedSearch(searchTitles, 300), []);
  // Only the latest query's answer counts (an Enter search can race a debounced one)
  const seq = useRef(0);
  const immediate = useRef<AbortController | null>(null);
  const run = useCallback(
    (q: string, now = false) => {
      search.cancel();
      immediate.current?.abort();
      const mine = ++seq.current;
      if (!q.trim()) {
        setState({ status: "idle" });
        return;
      }
      setState({ status: "loading" });
      const onResult = (data: SearchResults) =>
        mine === seq.current && setState({ status: "done", data });
      const onError = (e: unknown) =>
        mine === seq.current &&
        !isAbortError(e) &&
        setState({ status: "error", message: errorText(e, "search") });
      if (now) {
        const controller = new AbortController();
        immediate.current = controller;
        searchTitles(q, controller.signal).then(onResult, onError);
        return;
      }
      search.run(q, onResult, onError);
    },
    [search],
  );
  // Search what's playing right away, but only once the search view is visible (AIOStreams picks start deeper)
  const started = useRef(false);
  useEffect(() => {
    if (active && !started.current) {
      started.current = true;
      if (initialQuery.trim()) {
        run(initialQuery, true);
      }
    }
    if (active) {
      inputRef.current?.focus();
    }
  }, [active, initialQuery, run]);
  useEffect(
    () => () => {
      search.cancel();
      immediate.current?.abort();
    },
    [search],
  );

  const items =
    state.status === "done"
      ? [...state.data.movies, ...state.data.series, ...state.data.anime]
      : [];
  return (
    <>
      <form
        className={styles.searchRow}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          run(query, true);
        }}
      >
        <IconSearch size={16} className={styles.searchIcon} aria-hidden />
        <input
          ref={inputRef}
          className={styles.input}
          type="search"
          aria-label="Movie or show title"
          placeholder="Movie or show title"
          value={query}
          maxLength={100}
          onChange={(e) => {
            setQuery(e.target.value);
            run(e.target.value);
          }}
        />
        {state.status === "loading" && <Loader size="xs" />}
      </form>
      {state.status === "error" && (
        <ErrorState message={state.message} onRetry={() => run(query, true)} />
      )}
      {state.status === "idle" && (
        <p className={styles.note}>
          Type the name of the movie or show that's playing.
        </p>
      )}
      {state.status === "done" && items.length === 0 && (
        <p className={styles.note}>No titles found for “{query.trim()}”.</p>
      )}
      {items.length > 0 && (
        <ul className={styles.list} aria-label="Titles">
          {items.map((item) => (
            <li key={`${item.kind}-${item.id}`}>
              <button
                type="button"
                className={styles.row}
                onClick={() => onPick(item)}
              >
                <Poster src={item.poster} />
                <span className={styles.grow}>
                  <span className={styles.rowTitle}>{item.name}</span>
                  <small className={styles.rowMeta}>
                    {[TYPE_LABEL[item.kind], item.year]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
                <IconChevronRight size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Poster({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className={styles.poster} aria-hidden>
        <IconMovie size={18} />
      </span>
    );
  }
  return (
    <img
      className={styles.poster}
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function TitleView({
  item,
  guess,
  onPick,
}: {
  item: TitleRef;
  guess: TitleGuess;
  onPick: (meta: Meta, ep: Episode) => void;
}) {
  const meta = useAsync(`${item.kind}:${item.id}`, "meta", (signal) =>
    getMeta(item.kind, item.id, signal),
  );
  const data = meta.status === "done" ? meta.data : null;
  const guessed = useMemo(
    () => (data ? findGuessedEpisode(data.seasons, guess) : null),
    [data, guess],
  );
  const [season, setSeason] = useState<number | null>(null);
  const shownSeason =
    season ??
    guessed?.season ??
    data?.seasons.find((s) => s.season > 0)?.season ??
    data?.seasons[0]?.season ??
    null;
  const episodes =
    data?.seasons.find((s) => s.season === shownSeason)?.episodes ?? [];
  const guessedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    guessedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [guessed]);

  return (
    <>
      <div className={styles.titleHead}>
        <Poster src={item.poster} />
        <div>
          <div className={styles.heading}>{item.name}</div>
          <small className={styles.rowMeta}>
            {[TYPE_LABEL[item.kind], item.year].filter(Boolean).join(" · ")}
          </small>
        </div>
      </div>
      {meta.status === "loading" && <LoadingState text="Loading episodes…" />}
      {meta.status === "error" && (
        <ErrorState message={meta.message} onRetry={meta.retry} />
      )}
      {data && data.seasons.length === 0 && (
        <p className={styles.note}>No episodes found for this show.</p>
      )}
      {data && data.seasons.length > 0 && (
        <>
          {data.seasons.length > 1 && (
            <div className={styles.chips} role="group" aria-label="Season">
              {data.seasons.map((s) => (
                <button
                  key={s.season}
                  type="button"
                  className={styles.chip}
                  aria-pressed={s.season === shownSeason}
                  onClick={() => setSeason(s.season)}
                >
                  {s.season === 0 ? "Specials" : `Season ${s.season}`}
                </button>
              ))}
            </div>
          )}
          <ul className={styles.list} aria-label="Episodes">
            {episodes.map((ep) => {
              const isGuess = guessed?.id === ep.id;
              return (
                <li key={ep.id}>
                  <button
                    type="button"
                    ref={isGuess ? guessedRef : undefined}
                    className={styles.row}
                    data-guess={isGuess || undefined}
                    aria-current={isGuess || undefined}
                    onClick={() => onPick(data, ep)}
                  >
                    <span className={styles.code}>
                      {episodeCode(ep.season, ep.episode)}
                    </span>
                    <span className={styles.grow}>
                      <span className={styles.rowTitle}>
                        {ep.title || `Episode ${ep.episode}`}
                      </span>
                    </span>
                    {isGuess && <span className={styles.badge}>Playing</span>}
                    <IconChevronRight size={16} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

function SubtitlesView({
  target,
  onLoaded,
}: {
  target: SubtitlesTarget;
  onLoaded: (url: string) => void;
}) {
  const subs = useAsync(`${target.type}:${target.id}`, "subtitles", (signal) =>
    getSubtitles(target.type, target.id, signal),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadController = useRef<AbortController | null>(null);
  useEffect(() => () => loadController.current?.abort(), []);
  const subData = subs.status === "done" ? subs.data : null;
  const groups = useMemo(
    () => (subData ? groupSubtitlesByLanguage(subData) : []),
    [subData],
  );

  const pick = async (sub: Subtitle) => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setBusyId(sub.id);
    try {
      const url = await shareSubtitleFromUrl(sub.url, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      toast(`${sub.label} subtitles loaded for everyone`, {
        tone: "success",
        id: "subtitle-search",
      });
      onLoaded(url);
    } catch (e) {
      if (controller.signal.aborted) {
        return;
      }
      toast(
        `${(e as Error)?.message || "Couldn't load the subtitles"}. Try another one.`,
        {
          tone: "danger",
          id: "subtitle-search",
        },
      );
      setBusyId(null);
    }
  };

  return (
    <>
      <div className={styles.titleHead}>
        <span className={styles.poster} aria-hidden>
          <IconSubtitles size={18} />
        </span>
        <div className={styles.heading}>{target.label}</div>
      </div>
      {subs.status === "loading" && <LoadingState text="Finding subtitles…" />}
      {subs.status === "error" && (
        <ErrorState message={subs.message} onRetry={subs.retry} />
      )}
      {subs.status === "done" && subs.data.length === 0 && (
        <p className={styles.note}>
          No subtitles found for this {target.noun}.
        </p>
      )}
      {groups.map((g) => (
        <section key={g.lang} aria-label={g.language}>
          <div className={styles.groupLabel}>
            {g.language}
            <span>{g.items.length}</span>
          </div>
          <ul className={styles.list}>
            {g.items.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={styles.row}
                  disabled={busyId !== null}
                  aria-busy={busyId === s.id || undefined}
                  onClick={() => pick(s)}
                >
                  <span className={styles.grow}>
                    <span className={styles.rowTitle}>{s.label}</span>
                    <small className={styles.rowMeta}>OpenSubtitles</small>
                  </span>
                  {busyId === s.id ? (
                    <Loader size="xs" />
                  ) : (
                    <span className={styles.action}>Load for everyone</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function LoadingState({ text }: { text: string }) {
  return (
    <div className={styles.state} role="status">
      <Loader size="sm" />
      <span>{text}</span>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className={styles.state} role="alert">
      <IconAlertTriangle size={18} className={styles.danger} aria-hidden />
      <span>{message}</span>
      <button type="button" className={styles.link} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
