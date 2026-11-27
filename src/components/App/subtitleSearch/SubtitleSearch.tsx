import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader } from "@mantine/core";
import {
  IconChevronRight,
  IconFileSearch,
  IconMovie,
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
import { formatAirDate } from "../picker/pickerLogic";
import {
  episodeCode,
  findGuessedEpisode,
  groupSubtitlesByLanguage,
  guessSubtitleSearch,
  rankTitleResults,
  subtitleTargetLabel,
  type TitleGuess,
} from "./guessTitle";
import { useOpenSubtitlesAvailable } from "./openSubtitlesStatus";
import { shareSubtitleFromUrl } from "./shareSubtitle";
import {
  ErrorState,
  LoadHint,
  LoadingState,
  PaletteFoot,
  PaletteHead,
  PaletteModal,
  arrowKeysBetweenRows,
  cx,
  picker,
  styles,
  useEscape,
  usePhone,
} from "./palette";

type SubtitlesTarget = {
  type: ContentType;
  id: string;
  /** "Breaking Bad · S02E04" */
  label: string;
  /** "episode" or "movie", for the empty state */
  noun: "episode" | "movie";
  poster: string | null;
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

/** The title search: debounced while typing, immediate on Enter; only the latest query's answer counts */
function useTitleSearch() {
  const [state, setState] = useState<Async<SearchResults>>({ status: "idle" });
  const search = useMemo(() => createDebouncedSearch(searchTitles, 300), []);
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
  useEffect(
    () => () => {
      search.cancel();
      immediate.current?.abort();
    },
    [search],
  );
  return { state, run };
}

/**
 * "Search subtitles…": keyless subtitle search for the room's video. Search a title (Cinemeta + Kitsu via
 * /addon/search), pick a series' season/episode, then a subtitle (OpenSubtitles v3 via /addon/subtitles). The chosen
 * file is stored on our server (POST /subtitle) and set as the room subtitle for everyone (`setRoomSubtitle`, i.e.
 * CMD:subtitle). Pre-filled from what's playing (guessSubtitleSearch); AIOStreams picks open on their subtitles.
 * Built on the shared palette (palette.tsx, the source picker's parts).
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
  const phone = usePhone();
  return (
    <PaletteModal
      opened={props.opened}
      onClose={props.onClose}
      label="Search subtitles"
      phone={phone}
    >
      <SubtitleSearchBody {...props} phone={phone} />
    </PaletteModal>
  );
}

const TYPE_LABEL: Record<ContentType, string> = {
  movie: "Movie",
  series: "Show",
  anime: "Anime",
};

/** The views inside the modal */
function SubtitleSearchBody({
  onClose,
  mediaUrl,
  videoMeta,
  setRoomSubtitle,
  openFileNameSearch,
  phone,
}: Parameters<typeof SubtitleSearch>[0] & { phone: boolean }) {
  // Guessed once when the view opens, so a video change underneath doesn't reset what the user is doing
  const [start] = useState(() => guessSubtitleSearch(mediaUrl, videoMeta));
  const guess: TitleGuess = start.guess;
  const [views, setViewsState] = useState<View[]>(() =>
    start.kind === "subtitles"
      ? [
          { kind: "search" },
          {
            kind: "subtitles",
            type: start.type,
            id: start.id,
            label: start.label,
            noun: start.guess.episode !== null ? "episode" : "movie",
            poster: videoMeta?.poster ?? null,
          },
        ]
      : [{ kind: "search" }],
  );
  // Updated synchronously, so several quick Esc presses each go back one level
  const viewsRef = useRef(views);
  const setViews = useCallback((next: View[]) => {
    viewsRef.current = next;
    setViewsState(next);
  }, []);
  const view = views[views.length - 1];
  const push = (v: View) => setViews([...viewsRef.current, v]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popTo = useCallback(
    (depth: number) => {
      setViews(viewsRef.current.slice(0, Math.max(1, depth)));
      inputRef.current?.focus();
    },
    [setViews],
  );
  const back = useCallback(() => {
    const depth = viewsRef.current.length;
    if (depth > 1) {
      popTo(depth - 1);
      return true;
    }
    return false;
  }, [popTo]);
  const fileNameSearchAvailable = useOpenSubtitlesAvailable();

  const [query, setQuery] = useState(guess.query);
  const titleSearch = useTitleSearch();
  // Search what's playing right away, but only once the search level shows (AIOStreams picks start deeper)
  const started = useRef(false);
  useEffect(() => {
    if (view.kind === "search" && !started.current) {
      started.current = true;
      if (guess.query.trim()) {
        titleSearch.run(guess.query, true);
      }
    }
  }, [view.kind, guess.query, titleSearch]);

  // A new level starts at the top, with typing still going to the search field
  useEffect(() => {
    listRef.current?.scrollTo?.({ top: 0 });
    inputRef.current?.focus();
  }, [view]);

  // Esc goes back one level, then closes; ↑/↓ move between the rows
  useEscape(back, onClose);
  const onKeyDown = arrowKeysBetweenRows(listRef, inputRef);

  const onInput = (value: string) => {
    setQuery(value);
    // Typing starts a new search from the top level
    if (viewsRef.current.length > 1) {
      setViews([{ kind: "search" }]);
    }
    titleSearch.run(value);
  };

  const trimmed = query.trim();
  const crumbs: { label: string; depth: number }[] = [];
  if (views.length > 1) {
    crumbs.push({
      label: trimmed ? `Results for “${trimmed}”` : "Search",
      depth: 1,
    });
    views.slice(1).forEach((v, i) => {
      crumbs.push({
        label: v.kind === "title" ? v.item.name : "Subtitles",
        depth: i + 2,
      });
    });
  }

  const searching = titleSearch.state.status === "loading";
  const fileNameLink = openFileNameSearch && fileNameSearchAvailable && (
    <button
      type="button"
      className={styles.footLink}
      onClick={openFileNameSearch}
    >
      <IconFileSearch size={14} aria-hidden />
      Search by file name (OpenSubtitles API)
    </button>
  );

  return (
    <div className={picker.modalBody} onKeyDown={onKeyDown}>
      <PaletteHead
        inputRef={inputRef}
        value={query}
        onChange={onInput}
        onSubmit={() => {
          if (viewsRef.current.length > 1) {
            setViews([{ kind: "search" }]);
          }
          titleSearch.run(query, true);
        }}
        onBack={views.length > 1 ? back : undefined}
        onClose={onClose}
        busy={searching}
        label="Movie or show title"
        placeholder="Search subtitles by movie or show title"
      />
      {crumbs.length > 0 && (
        <nav className={picker.crumbs} aria-label="Breadcrumbs">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <React.Fragment key={c.depth}>
                {i > 0 && <IconChevronRight size={14} aria-hidden />}
                {last ? (
                  <span className={picker.crumbCurrent} aria-current="page">
                    {c.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={picker.crumb}
                    onClick={() => popTo(c.depth)}
                  >
                    {c.label}
                  </button>
                )}
              </React.Fragment>
            );
          })}
        </nav>
      )}
      <div ref={listRef} className={picker.body}>
        {view.kind === "search" && (
          <SearchResultsView
            state={titleSearch.state}
            query={query}
            guess={guess}
            onRetry={() => titleSearch.run(query, true)}
            onPick={(item) =>
              item.type === "movie"
                ? push({
                    kind: "subtitles",
                    type: item.kind,
                    id: item.id,
                    label: item.year
                      ? `${item.name} (${item.year})`
                      : item.name,
                    noun: "movie",
                    poster: item.poster,
                  })
                : push({ kind: "title", item })
            }
          />
        )}
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
                poster: meta.poster ?? view.item.poster,
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
      </div>
      {(!phone || fileNameLink) && (
        <PaletteFoot
          phone={phone}
          right={fileNameLink || "Subtitles from OpenSubtitles"}
        />
      )}
    </div>
  );
}

function SearchResultsView({
  state,
  query,
  guess,
  onRetry,
  onPick,
}: {
  state: Async<SearchResults>;
  query: string;
  guess: TitleGuess;
  onRetry: () => void;
  onPick: (item: TitleRef) => void;
}) {
  // The catalog groups movies, then series, then anime; put the likely match first instead
  const items = useMemo(
    () =>
      state.status === "done"
        ? rankTitleResults(
            [...state.data.movies, ...state.data.series, ...state.data.anime],
            query,
            guess,
          )
        : [],
    [state, query, guess],
  );
  if (state.status === "error") {
    return <ErrorState message={state.message} onRetry={onRetry} />;
  }
  if (state.status === "idle") {
    return (
      <div className={picker.hint}>
        Type the name of the movie or show that's playing.
      </div>
    );
  }
  if (state.status === "loading") {
    return <LoadingState text="Searching…" />;
  }
  if (items.length === 0) {
    return (
      <div className={picker.empty}>No titles found for “{query.trim()}”.</div>
    );
  }
  return (
    <>
      <div className={picker.groupLabel}>
        <IconMovie size={14} aria-hidden /> Movies & shows
      </div>
      <ul className={styles.list} aria-label="Titles">
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`}>
            <button
              type="button"
              data-row
              className={cx(picker.item, styles.row)}
              onClick={() => onPick(item)}
            >
              <Poster src={item.poster} className={styles.thumb} />
              <span className={cx(picker.grow, styles.lines)}>
                <span className={picker.title}>{item.name}</span>
                <span className={styles.metaRow}>
                  {item.year && <span>{item.year}</span>}
                  <span className={cx(picker.tag, picker.tagOutline)}>
                    {TYPE_LABEL[item.kind]}
                  </span>
                </span>
              </span>
              <IconChevronRight
                size={16}
                className={styles.chevron}
                aria-hidden
              />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A poster image, or a film icon when there's none or it doesn't load */
function Poster({ src, className }: { src: string | null; className: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={className} aria-hidden>
      {!src || failed ? (
        <IconMovie size={18} />
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
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
      <Header
        poster={data?.poster ?? item.poster}
        title={item.name}
        meta={
          <>
            {(data?.releaseInfo || item.year) && (
              <span>{data?.releaseInfo || item.year}</span>
            )}
            <span className={cx(picker.tag, picker.tagOutline)}>
              {TYPE_LABEL[item.kind]}
            </span>
          </>
        }
        note="Pick the episode that's playing."
      />
      {meta.status === "loading" && <LoadingState text="Loading episodes…" />}
      {meta.status === "error" && (
        <ErrorState message={meta.message} onRetry={meta.retry} />
      )}
      {data && data.seasons.length === 0 && (
        <div className={picker.empty}>No episodes found for this show.</div>
      )}
      {data && data.seasons.length > 0 && (
        <>
          {data.seasons.length > 1 && (
            <div
              className={cx(picker.seasonBar, styles.seasons)}
              role="group"
              aria-label="Season"
            >
              {data.seasons.map((s) => (
                <button
                  key={s.season}
                  type="button"
                  className={picker.pill}
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
              const date = formatAirDate(ep.released);
              return (
                <li key={ep.id}>
                  <button
                    type="button"
                    data-row
                    ref={isGuess ? guessedRef : undefined}
                    className={cx(picker.item, styles.row)}
                    data-guess={isGuess || undefined}
                    aria-current={isGuess || undefined}
                    onClick={() => onPick(data, ep)}
                  >
                    <span className={cx(picker.grow, styles.lines)}>
                      <span className={picker.title}>
                        <span className={picker.epNum}>
                          {episodeCode(ep.season, ep.episode)}
                        </span>
                        <span>{ep.title || `Episode ${ep.episode}`}</span>
                      </span>
                      {(date || isGuess) && (
                        <span className={picker.meta}>
                          {date}
                          {isGuess && (
                            <span className={picker.playingNow}>
                              {date ? " · " : ""}playing now
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    <span className={styles.hint} aria-hidden>
                      subtitles <IconChevronRight size={14} />
                    </span>
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

/** The title/episode header: poster, name, a meta line and a short note (the picker's title header) */
function Header({
  poster,
  title,
  meta,
  note,
}: {
  poster: string | null;
  title: string;
  meta?: React.ReactNode;
  note?: string;
}) {
  return (
    <div className={cx(picker.titleHead, styles.head)}>
      <Poster src={poster} className={cx(picker.poster, styles.poster)} />
      <div className={picker.grow}>
        <h3>{title}</h3>
        {meta && <div className={picker.headMeta}>{meta}</div>}
        {note && <p>{note}</p>}
      </div>
    </div>
  );
}

/** "en" → "EN", "pt-BR" → "PT" (the language chip on a subtitle row) */
const langChip = (lang: string) => (lang.split("-")[0] || "?").toUpperCase();

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
      <Header
        poster={target.poster}
        title={target.label}
        meta={
          subData ? (
            <span>
              <IconSubtitles size={14} className={styles.inlineIcon} />{" "}
              {subData.length === 1
                ? "1 subtitle"
                : `${subData.length} subtitles`}
              {groups.length > 1 ? ` in ${groups.length} languages` : ""}
            </span>
          ) : undefined
        }
        note="Picking one loads it for everyone in the room."
      />
      {subs.status === "loading" && <LoadingState text="Finding subtitles…" />}
      {subs.status === "error" && (
        <ErrorState message={subs.message} onRetry={subs.retry} />
      )}
      {subs.status === "done" && subs.data.length === 0 && (
        <div className={picker.empty}>
          No subtitles found for this {target.noun}.
        </div>
      )}
      {groups.map((g) => (
        <section key={g.lang} aria-label={g.language}>
          <div className={picker.groupLabel}>
            {g.language}
            <span className={styles.count}>{g.items.length}</span>
          </div>
          <ul className={styles.list}>
            {g.items.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  data-row
                  className={cx(picker.item, styles.row)}
                  disabled={busyId !== null}
                  aria-busy={busyId === s.id || undefined}
                  onClick={() => pick(s)}
                >
                  <span className={cx(picker.lead, styles.lang)} aria-hidden>
                    {langChip(s.lang)}
                  </span>
                  <span className={cx(picker.grow, styles.lines)}>
                    <span className={picker.title}>{s.label}</span>
                    <span className={picker.meta}>OpenSubtitles</span>
                  </span>
                  {busyId === s.id ? <Loader size="xs" /> : <LoadHint />}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
