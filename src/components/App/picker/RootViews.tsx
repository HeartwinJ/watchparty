// The palette's first level: empty state (stop video, share actions + recents), a pasted link, or search results.
import React, { useEffect, useMemo, useState } from "react";
import { Button, Skeleton } from "@mantine/core";
import {
  IconAlertTriangle,
  IconCornerDownLeft,
  IconFileUpload,
  IconMovie,
  IconPlayerPlayFilled,
  IconPlus,
  IconScreenShare,
  IconPlayerStop,
  IconScreenShareOff,
  IconBrandYoutube,
  IconHistory,
} from "@tabler/icons-react";
import {
  createDebouncedSearch,
  isAddonsConfigured,
  probeAddonsStatus,
  onAddonsConfiguredChange,
  searchTitles,
  searchYouTube,
  type SearchResults,
  type TitleRef,
} from "../../../api/addons";
import { formatTimestamp } from "../../../utils/utils";
import { useOption, useQueueMode } from "./options";
import {
  detectLink,
  episodeCode,
  interleave,
  loadRecents,
  type RecentSource,
  type StreamContext,
} from "./pickerLogic";
import type { PickerActions, SearchFilter } from "./types";
import { getCached, setCached } from "./useLoad";
import styles from "./SourcePicker.module.css";

export const cx = (...classes: (string | false | undefined | null)[]) =>
  classes.filter(Boolean).join(" ");

/** An image that falls back (or disappears) when it fails to load, e.g. a dead poster link */
export function Img({
  src,
  fallback = null,
}: {
  src: string | null | undefined;
  fallback?: React.ReactNode;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) {
    return <>{fallback}</>;
  }
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} />;
}

export function EnterHint() {
  return (
    <span className={styles.enterHint} aria-hidden>
      <IconCornerDownLeft size={14} />
    </span>
  );
}

export function useAddonsConfigured() {
  const [configured, setConfigured] = useState(isAddonsConfigured);
  useEffect(() => {
    const off = onAddonsConfiguredChange(setConfigured);
    // Search/meta work without AIOStreams, so ask the server whether streams do (once per page load)
    probeAddonsStatus().then(setConfigured);
    return off;
  }, []);
  return configured;
}

// ---- Empty state ----

function ActionRow(props: {
  id: string;
  icon: React.ReactNode;
  title: string;
  meta: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const { props: optionProps } = useOption(props.id, {
    primary: () => !props.disabled && props.onSelect(),
  });
  return (
    <div
      {...optionProps}
      aria-disabled={props.disabled || undefined}
      className={styles.item}
    >
      <span className={cx(styles.lead, styles.leadAction)}>{props.icon}</span>
      <span className={styles.grow}>
        <div className={styles.title}>{props.title}</div>
        <div className={styles.meta}>{props.meta}</div>
      </span>
      <EnterHint />
    </div>
  );
}

function RecentRow({
  id,
  recent,
  actions,
  onOpenContext,
  close,
}: {
  id: string;
  recent: RecentSource;
  actions: PickerActions;
  onOpenContext: (ctx: StreamContext) => void;
  close: () => void;
}) {
  const play = () => {
    if (recent.kind === "url") {
      actions.playUrl(recent.url, { name: recent.name, img: recent.img });
      close();
    } else {
      onOpenContext(recent.context);
    }
  };
  const queue =
    recent.kind === "url"
      ? () => {
          actions.queueUrl(recent.url, { name: recent.name, img: recent.img });
          close();
        }
      : undefined;
  const queueMode = useQueueMode();
  const { props } = useOption(
    id,
    queueMode && queue
      ? { primary: queue, secondary: play }
      : { primary: play, secondary: queue },
  );
  const img =
    recent.kind === "url"
      ? recent.img
      : (recent.context.title.poster ?? undefined);
  const title = recent.kind === "url" ? recent.name : recent.context.title.name;
  const meta =
    recent.kind === "url"
      ? "Link"
      : recent.context.episode
        ? `${episodeCode(recent.context.episode.season, recent.context.episode.episode)}${
            recent.context.episode.title
              ? ` · ${recent.context.episode.title}`
              : ""
          } · pick a stream`
        : "Movie · pick a stream";
  return (
    <div {...props} className={styles.item}>
      <span className={styles.lead}>
        <Img src={img} fallback={<IconHistory size={18} />} />
      </span>
      <span className={styles.grow}>
        <div className={styles.title}>{title}</div>
        <div className={styles.meta}>{meta}</div>
      </span>
      <EnterHint />
    </div>
  );
}

export function EmptyView({
  idPrefix,
  actions,
  queueMode = false,
  onOpenContext,
  close,
}: {
  idPrefix: string;
  actions: PickerActions;
  /** Adding to the queue: no "Stop video" */
  queueMode?: boolean;
  onOpenContext: (ctx: StreamContext) => void;
  close: () => void;
}) {
  const recents = useMemo(() => loadRecents(), []);
  const configured = useAddonsConfigured();
  return (
    <>
      {actions.canStopVideo && !queueMode && (
        <>
          <div className={styles.groupLabel}>Now playing</div>
          <ActionRow
            id={`${idPrefix}-stop-video`}
            icon={<IconPlayerStop size={18} />}
            title="Stop video"
            meta="Clear the player for everyone"
            onSelect={() => {
              actions.stopVideo();
              close();
            }}
          />
        </>
      )}
      <div className={styles.groupLabel}>Start sharing</div>
      {actions.sharing === "me" ? (
        <ActionRow
          id={`${idPrefix}-stop`}
          icon={<IconScreenShareOff size={18} />}
          title="Stop sharing"
          meta="End your screen or file share"
          onSelect={() => {
            actions.stopSharing();
            close();
          }}
        />
      ) : (
        <>
          <ActionRow
            id={`${idPrefix}-screen`}
            icon={<IconScreenShare size={18} />}
            title="Share screen"
            meta={
              actions.sharing === "other"
                ? "Someone is already sharing"
                : "A window, tab or the whole screen, with audio"
            }
            disabled={actions.sharing === "other"}
            onSelect={() => {
              close();
              actions.shareScreen();
            }}
          />
          <ActionRow
            id={`${idPrefix}-file`}
            icon={<IconFileUpload size={18} />}
            title="Share a file"
            meta={
              actions.sharing === "other"
                ? "Someone is already sharing"
                : "Stream a video from this device to everyone"
            }
            disabled={actions.sharing === "other"}
            onSelect={() => {
              close();
              actions.shareFile();
            }}
          />
        </>
      )}
      {recents.length > 0 && (
        <>
          <div className={styles.groupLabel}>Recently played</div>
          {recents.map((r, i) => (
            <RecentRow
              key={`${i}-${r.at}`}
              id={`${idPrefix}-recent-${i}`}
              recent={r}
              actions={actions}
              onOpenContext={onOpenContext}
              close={close}
            />
          ))}
        </>
      )}
      <div className={styles.hint}>
        Type to search{" "}
        {configured && (
          <>
            <b>Movies &amp; Shows</b> and{" "}
          </>
        )}
        <b>YouTube</b>, or paste a YouTube, .m3u8, .mpd or video link.
      </div>
    </>
  );
}

// ---- Pasted link ----

const youTubeId = (url: string): string | undefined => {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      return u.pathname.slice(1) || undefined;
    }
    return u.searchParams.get("v") ?? undefined;
  } catch {
    return undefined;
  }
};

export function UrlView({
  idPrefix,
  url,
  actions,
  close,
}: {
  idPrefix: string;
  url: string;
  actions: PickerActions;
  close: () => void;
}) {
  const link = detectLink(url)!;
  const play = () => {
    actions.playUrl(url);
    close();
  };
  const queue = () => {
    actions.queueUrl(url);
    close();
  };
  const queueMode = useQueueMode();
  const { props } = useOption(
    `${idPrefix}-url`,
    queueMode
      ? { primary: queue, secondary: play }
      : { primary: play, secondary: queue },
  );
  const playButton = (
    <Button
      key="play"
      variant={queueMode ? "default" : "filled"}
      leftSection={<IconPlayerPlayFilled size={14} />}
      onClick={play}
    >
      Play now
    </Button>
  );
  const queueButton = (
    <Button
      key="queue"
      variant={queueMode ? "filled" : "default"}
      leftSection={<IconPlus size={16} />}
      onClick={queue}
    >
      Add to queue
    </Button>
  );
  const ytId = link.kind === "youtube" ? youTubeId(url) : undefined;
  return (
    <>
      <div className={styles.groupLabel}>Detected link</div>
      <div {...props} className={cx(styles.item, styles.urlCard)}>
        {ytId && (
          <div className={styles.ytThumb}>
            <Img
              src={`https://i.ytimg.com/vi/${encodeURIComponent(ytId)}/mqdefault.jpg`}
            />
          </div>
        )}
        <div className={styles.grow}>
          <span
            className={cx(
              styles.tag,
              link.kind === "unknown" ? styles.tagWarn : styles.tagOk,
            )}
            data-testid="link-badge"
          >
            {link.kind === "youtube" ? (
              <IconBrandYoutube size={13} />
            ) : (
              <IconMovie size={13} />
            )}
            {link.label}
          </span>
          <div className={styles.urlTitle}>{link.title}</div>
          {link.warning && (
            <div className={styles.warnLine}>
              <IconAlertTriangle size={13} />
              {link.warning}
            </div>
          )}
          <div className={styles.acts}>
            {queueMode ? [queueButton, playButton] : [playButton, queueButton]}
          </div>
        </div>
      </div>
      <div className={styles.note}>
        Supported: YouTube, HLS (.m3u8), DASH (.mpd), direct video files (MP4,
        WebM; MKV depends on codecs and is converted if needed).
      </div>
    </>
  );
}

// ---- Search ----

type YouTubeResults = SearchResult[];

function PosterCard({
  id,
  item,
  onOpen,
}: {
  id: string;
  item: TitleRef;
  onOpen: (item: TitleRef) => void;
}) {
  const { props } = useOption(id, { primary: () => onOpen(item) });
  const kindLabel =
    item.kind === "anime"
      ? "Anime"
      : item.kind === "movie"
        ? "Movie"
        : "Series";
  return (
    <div {...props} className={styles.posterCard} title={item.name}>
      <div className={styles.poster}>
        <Img
          src={item.poster}
          fallback={<span className={styles.posterFallback}>{item.name}</span>}
        />
      </div>
      <div className={styles.title}>{item.name}</div>
      <div className={styles.posterMeta}>
        {item.year ?? ""}
        <span className={styles.tag}>{kindLabel}</span>
      </div>
    </div>
  );
}

function YouTubeRow({
  id,
  item,
  actions,
  close,
}: {
  id: string;
  item: SearchResult;
  actions: PickerActions;
  close: () => void;
}) {
  const play = () => {
    actions.playUrl(item.url, { name: item.name, img: item.img });
    close();
  };
  const queue = () => {
    actions.queueUrl(item.url, { name: item.name, img: item.img });
    close();
  };
  const queueMode = useQueueMode();
  const { props } = useOption(
    id,
    queueMode
      ? { primary: queue, secondary: play }
      : { primary: play, secondary: queue },
  );
  return (
    <div {...props} className={styles.item}>
      <div className={styles.ytThumb}>
        <Img src={item.img} />
        {item.duration > 0 && (
          <span className={styles.duration}>
            {formatTimestamp(item.duration)}
          </span>
        )}
      </div>
      <span className={styles.grow}>
        <div className={styles.title}>{item.name}</div>
        <div className={styles.meta}>{item.channel || "YouTube"}</div>
      </span>
      <Button
        variant="subtle"
        color="gray"
        size="compact-sm"
        aria-label={
          queueMode ? `Play ${item.name} now` : `Add ${item.name} to queue`
        }
        onClick={queueMode ? play : queue}
        tabIndex={-1}
      >
        {queueMode ? (
          <IconPlayerPlayFilled size={14} />
        ) : (
          <IconPlus size={16} />
        )}
      </Button>
    </div>
  );
}

const SEARCH_DELAY_MS = 250;
const titleKey = (q: string) => `search:${q}`;
const ytKey = (q: string) => `yt:${q}`;

interface SearchState<T> {
  query: string;
  data?: T;
  error?: unknown;
}

/** Debounced, cancellable search for one source; cached results show immediately */
function useSearch<T>(
  query: string,
  enabled: boolean,
  key: (q: string) => string,
  fn: (q: string, signal: AbortSignal) => Promise<T>,
) {
  const searcher = useMemo(
    () => createDebouncedSearch(fn, SEARCH_DELAY_MS),
    // fn is a module-level function
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [state, setState] = useState<SearchState<T>>({ query: "" });
  useEffect(() => {
    if (!enabled || !query) {
      searcher.cancel();
      return;
    }
    const cached = getCached<T>(key(query));
    if (cached) {
      searcher.cancel();
      setState({ query, data: cached });
      return;
    }
    searcher.run(
      query,
      (data) => {
        setCached(key(query), data);
        setState({ query, data });
      },
      (error) => setState({ query, error }),
    );
    return () => searcher.cancel();
  }, [query, enabled, key, searcher]);
  const current = state.query === query;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    // Keep showing the previous results while the next ones load
    stale: !current ? state.data : undefined,
    loading:
      enabled && Boolean(query) && (!current || (!state.data && !state.error)),
  };
}

const ALL_POSTERS = 10;
const ALL_YOUTUBE = 5;

export function SearchView({
  idPrefix,
  query,
  filter,
  setFilter,
  actions,
  onOpenTitle,
  onLoadingChange,
  close,
}: {
  idPrefix: string;
  query: string;
  filter: SearchFilter;
  setFilter: (f: SearchFilter) => void;
  actions: PickerActions;
  onOpenTitle: (item: TitleRef) => void;
  onLoadingChange: (loading: boolean) => void;
  close: () => void;
}) {
  const configured = useAddonsConfigured();
  const effectiveFilter: SearchFilter =
    !configured && filter === "titles" ? "all" : filter;
  const showTitles = configured && effectiveFilter !== "youtube";
  const showYouTube = effectiveFilter !== "titles";
  const titles = useSearch<SearchResults>(
    query,
    showTitles,
    titleKey,
    searchTitles,
  );
  const youtube = useSearch<YouTubeResults>(
    query,
    showYouTube,
    ytKey,
    searchYouTube,
  );
  const loading = titles.loading || youtube.loading;
  useEffect(() => onLoadingChange(loading), [loading, onLoadingChange]);
  useEffect(() => () => onLoadingChange(false), [onLoadingChange]);

  const titleData = titles.data ?? titles.stale;
  const posters = titleData
    ? interleave(titleData.movies, titleData.series, titleData.anime)
    : [];
  const shownPosters =
    effectiveFilter === "all" ? posters.slice(0, ALL_POSTERS) : posters;
  const ytData = youtube.data ?? youtube.stale ?? [];
  const shownYouTube =
    effectiveFilter === "all" ? ytData.slice(0, ALL_YOUTUBE) : ytData;

  const chips: { value: SearchFilter; label: string }[] = [
    { value: "all", label: "All" },
    ...(configured
      ? [{ value: "titles" as const, label: "Movies & Shows" }]
      : []),
    { value: "youtube", label: "YouTube" },
  ];

  return (
    <>
      <div className={styles.filters} role="group" aria-label="Filter results">
        {chips.map((c) => (
          <button
            key={c.value}
            type="button"
            className={styles.pill}
            aria-pressed={effectiveFilter === c.value}
            onClick={() => setFilter(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {showTitles && (
        <section aria-label="Movies & Shows">
          <div className={styles.groupLabel}>
            <IconMovie size={14} /> Movies &amp; Shows
          </div>
          {titles.error ? (
            <div className={styles.errorBox}>
              <IconAlertTriangle size={16} />
              {(titles.error as Error).message || "Search failed"}
            </div>
          ) : !titleData ? (
            <div className={styles.posters} aria-busy>
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className={styles.posterCard}>
                  <Skeleton className={styles.poster} />
                  <Skeleton height={12} width="80%" />
                </div>
              ))}
            </div>
          ) : posters.length === 0 ? (
            <div className={styles.note}>
              No movies or shows match “{query}”.
            </div>
          ) : (
            <div className={styles.posters}>
              {shownPosters.map((item) => (
                <PosterCard
                  key={`${item.kind}:${item.id}`}
                  id={`${idPrefix}-t-${item.kind}-${item.id}`}
                  item={item}
                  onOpen={onOpenTitle}
                />
              ))}
            </div>
          )}
        </section>
      )}
      {showYouTube && (
        <section aria-label="YouTube">
          <div className={styles.groupLabel}>
            <IconBrandYoutube size={14} /> YouTube
          </div>
          {youtube.error ? (
            <div className={styles.errorBox}>
              <IconAlertTriangle size={16} />
              YouTube search failed
            </div>
          ) : !youtube.data && !youtube.stale ? (
            Array.from({ length: 3 }, (_, i) => (
              <div key={i} className={styles.item} aria-hidden>
                <Skeleton className={styles.ytThumb} />
                <div className={styles.grow}>
                  <Skeleton height={12} width="70%" mb={6} />
                  <Skeleton height={10} width="40%" />
                </div>
              </div>
            ))
          ) : ytData.length === 0 ? (
            <div className={styles.note}>No YouTube results.</div>
          ) : (
            shownYouTube.map((item, i) => (
              <YouTubeRow
                key={`${item.url}-${i}`}
                id={`${idPrefix}-yt-${i}`}
                item={item}
                actions={actions}
                close={close}
              />
            ))
          )}
        </section>
      )}
    </>
  );
}
