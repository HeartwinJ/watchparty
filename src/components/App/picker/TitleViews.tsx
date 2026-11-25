// Drill-down levels: a movie (header + streams), a series (seasons → episodes) and an episode (header + streams).
import React, { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Button,
  SegmentedControl,
  Select,
  Skeleton,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconPlayerPlayFilled,
  IconPlus,
  IconRefresh,
  IconTransform,
  IconBadgeCc,
} from "@tabler/icons-react";
import {
  getMeta,
  getStreams,
  getSubtitles,
  type Episode,
  type Meta,
  type StreamDTO,
  type StreamList,
  type Subtitle,
  type TitleRef,
} from "../../../api/addons";
import { useOption, useQueueMode } from "./options";
import {
  baseContentId,
  episodeCode,
  formatAirDate,
  formatSize,
  groupStreams,
  isFuture,
  resolutionLabel,
  streamBadges,
  streamFileLabel,
  type StreamContext,
} from "./pickerLogic";
import type { PickerActions } from "./types";
import { useLoad } from "./useLoad";
import { cx, Img } from "./RootViews";
import styles from "./SourcePicker.module.css";

function ErrorBox({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className={styles.errorBox} role="alert">
      <IconAlertTriangle size={16} />
      <span className={styles.grow}>
        {(error as Error)?.message || "Couldn't load this"}
      </span>
      <Button
        size="compact-sm"
        variant="default"
        leftSection={<IconRefresh size={14} />}
        onClick={retry}
      >
        Retry
      </Button>
    </div>
  );
}

const kindLabel = (t: TitleRef) =>
  t.kind === "anime" ? "Anime" : t.kind === "movie" ? "Movie" : "Series";

function TitleHeader({
  title,
  meta,
}: {
  title: TitleRef;
  meta: Meta | undefined;
}) {
  const poster = meta?.poster ?? title.poster;
  const year = meta?.releaseInfo ?? (meta?.year ?? title.year)?.toString();
  return (
    <div className={styles.titleHead}>
      <div className={styles.poster}>
        <Img
          src={poster}
          fallback={<span className={styles.posterFallback}>{title.name}</span>}
        />
      </div>
      <div className={styles.grow}>
        <h3>{meta?.name ?? title.name}</h3>
        <div className={styles.headMeta}>
          {year && <span>{year}</span>}
          <span className={cx(styles.tag, styles.tagOutline)}>
            {kindLabel(title)}
          </span>
          {meta?.genres.length ? (
            <span>{meta.genres.slice(0, 3).join(" · ")}</span>
          ) : null}
          {meta?.runtime && <span>{meta.runtime}</span>}
        </div>
        {meta?.description ? (
          <p>{meta.description}</p>
        ) : !meta ? (
          <>
            <Skeleton height={10} mb={6} />
            <Skeleton height={10} width="70%" />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---- Stream list ----

function StreamRow({
  id,
  stream,
  ctx,
  actions,
  close,
  best,
  sameRelease,
}: {
  id: string;
  stream: StreamDTO;
  ctx: StreamContext;
  actions: PickerActions;
  close: () => void;
  best?: boolean;
  sameRelease?: string | null;
}) {
  const play = () => {
    actions.playStream(stream, ctx);
    close();
  };
  const queue = () => {
    actions.queueStream(stream, ctx);
    close();
  };
  const queueMode = useQueueMode();
  const { props } = useOption(
    id,
    queueMode
      ? { primary: queue, secondary: play }
      : { primary: play, secondary: queue },
  );
  const res = resolutionLabel(stream.resolution);
  const size = formatSize(stream.sizeBytes);
  const unlikely = stream.tier === "unlikely";
  const label = streamFileLabel(stream);
  return (
    <div
      {...props}
      className={cx(styles.item, styles.stream, unlikely && styles.dim)}
      data-tier={stream.tier}
    >
      <span
        className={cx(styles.tag, styles.res, res === "4K" && styles.res4k)}
      >
        {res ?? "—"}
      </span>
      <div className={styles.grow}>
        <div className={styles.line1}>
          <span>{stream.source ?? stream.service ?? "Stream"}</span>
          {size && <span className={styles.size}>{size}</span>}
          {best && (
            <span className={cx(styles.tag, styles.tagAccent)}>Best match</span>
          )}
          {sameRelease && (
            <span className={cx(styles.tag, styles.tagOutline)}>
              Same release as {sameRelease}
            </span>
          )}
          {stream.tier === "convert-light" && (
            <span
              className={styles.tag}
              title="Only the audio (or container) is converted"
            >
              <IconTransform size={12} /> Light conversion
            </span>
          )}
          {stream.tier === "convert-heavy" && (
            <span
              className={cx(styles.tag, styles.tagWarn)}
              title="The video is re-encoded in the browser"
            >
              <IconTransform size={12} /> Heavy conversion
            </span>
          )}
        </div>
        <div className={styles.badges}>
          {streamBadges(stream).map((b, i) => (
            <span
              key={`${b.label}-${i}`}
              className={cx(styles.tag, b.tone === "problem" && styles.tagWarn)}
            >
              {b.label}
            </span>
          ))}
          {stream.cached && (
            <span className={cx(styles.tag, styles.tagOk)}>
              <IconBolt size={12} /> Cached
            </span>
          )}
        </div>
        {unlikely && stream.reasons.length > 0 && (
          <div className={styles.warnLine}>
            <IconAlertTriangle size={13} />
            {stream.reasons.join(" · ")}
          </div>
        )}
        <div className={styles.fname} title={label}>
          {label}
        </div>
      </div>
      {queueMode ? (
        <div className={styles.streamActs}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            aria-label="Play now"
            title="Play now"
            onClick={play}
            tabIndex={-1}
          >
            <IconPlayerPlayFilled size={16} />
          </ActionIcon>
          <Button
            size="sm"
            variant={unlikely ? "default" : "filled"}
            leftSection={<IconPlus size={16} />}
            onClick={queue}
            tabIndex={-1}
            aria-label="Add to queue"
          >
            <span className={styles.playLabel}>Add</span>
          </Button>
        </div>
      ) : (
        <div className={styles.streamActs}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            aria-label="Add to queue"
            title="Add to queue"
            onClick={queue}
            tabIndex={-1}
          >
            <IconPlus size={18} />
          </ActionIcon>
          <Button
            size="sm"
            variant={unlikely ? "default" : "filled"}
            leftSection={<IconPlayerPlayFilled size={14} />}
            onClick={play}
            tabIndex={-1}
            aria-label={unlikely ? "Try anyway" : "Play"}
          >
            <span className={styles.playLabel}>
              {unlikely ? "Try anyway" : "Play"}
            </span>
          </Button>
        </div>
      )}
    </div>
  );
}

function CollapseToggle({
  id,
  open,
  setOpen,
  count,
  reasons,
}: {
  id: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  count: number;
  reasons: string;
}) {
  const { props } = useOption(id, { primary: () => setOpen(!open) });
  return (
    <div {...props} className={styles.collapse} aria-expanded={open}>
      <IconAlertTriangle size={16} />
      <span>
        May not play in browser · {count}{" "}
        {reasons && <span className={styles.collapseWhy}>{reasons}</span>}
      </span>
      <IconChevronDown size={16} className={styles.chevron} />
    </div>
  );
}

function StreamSkeletons() {
  return (
    <div aria-busy aria-label="Loading streams">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className={cx(styles.item, styles.stream)} aria-hidden>
          <Skeleton height={22} width={50} />
          <div className={styles.grow}>
            <Skeleton height={12} width="40%" mb={8} />
            <Skeleton height={10} width="60%" mb={6} />
            <Skeleton height={8} width="80%" />
          </div>
        </div>
      ))}
    </div>
  );
}

const topReasons = (streams: StreamDTO[]) => {
  const seen = new Map<string, number>();
  streams.forEach((s) =>
    s.reasons.forEach((r) => seen.set(r, (seen.get(r) ?? 0) + 1)),
  );
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r]) => r)
    .join(" · ");
};

export function StreamListView({
  idPrefix,
  ctx,
  actions,
  close,
  setFooter,
}: {
  idPrefix: string;
  ctx: StreamContext;
  actions: PickerActions;
  close: () => void;
  setFooter: (note: string | null) => void;
}) {
  const id = ctx.episode?.id ?? ctx.title.id;
  // Prefer the release that's playing now (same show), so quality and source stay consistent
  const current = actions.currentMeta;
  const sameShow =
    current && baseContentId(current.id) === baseContentId(id) ? current : null;
  const bingeGroup = sameShow?.bingeGroup ?? null;
  const key = `streams:${ctx.title.kind}:${id}:${bingeGroup ?? ""}`;
  const { data, error, retry } = useLoad<StreamList>(key, (signal) =>
    getStreams(ctx.title.kind, id, { bingeGroup, signal }),
  );
  const [showUnlikely, setShowUnlikely] = useState(false);
  const groups = useMemo(() => (data ? groupStreams(data) : null), [data]);

  useEffect(() => {
    if (data) {
      setFooter(
        `Top ${data.streams.length} of ${data.total} · ${data.counts.direct} play directly · cached for 10 min`,
      );
    } else {
      setFooter(null);
    }
  }, [data, setFooter]);
  useEffect(() => () => setFooter(null), [setFooter]);

  if (error) {
    return <ErrorBox error={error} retry={retry} />;
  }
  if (!groups || !data) {
    return <StreamSkeletons />;
  }
  if (data.streams.length === 0) {
    return (
      <div className={styles.empty}>
        No playable streams found for this title.
      </div>
    );
  }
  const sameReleaseLabel =
    sameShow && sameShow.episode !== null
      ? episodeCode(sameShow.season, sameShow.episode)
      : null;
  const row = (s: StreamDTO, i: number, group: string, best?: boolean) => (
    <StreamRow
      key={`${group}-${i}`}
      id={`${idPrefix}-s-${group}-${i}`}
      stream={s}
      ctx={ctx}
      actions={actions}
      close={close}
      best={best}
      sameRelease={
        bingeGroup && s.bingeGroup === bingeGroup && sameShow?.id !== id
          ? sameReleaseLabel
          : null
      }
    />
  );
  return (
    <>
      {groups.direct.length > 0 && (
        <section aria-label="Plays directly">
          <div className={cx(styles.groupLabel, styles.groupOk)}>
            <IconCheck size={14} /> Plays directly · {groups.direct.length}
          </div>
          {groups.direct.map((s, i) => row(s, i, "direct", i === 0))}
        </section>
      )}
      {groups.convert.length > 0 && (
        <section aria-label="Plays with conversion">
          <div className={styles.groupLabel}>
            <IconTransform size={14} /> Plays with conversion ·{" "}
            {groups.convert.length}
          </div>
          {groups.convert.map((s, i) =>
            row(s, i, "convert", groups.direct.length === 0 && i === 0),
          )}
        </section>
      )}
      {groups.unlikely.length > 0 && (
        <section aria-label="May not play in browser">
          <CollapseToggle
            id={`${idPrefix}-unlikely-toggle`}
            open={showUnlikely}
            setOpen={setShowUnlikely}
            count={groups.unlikely.length}
            reasons={topReasons(groups.unlikely)}
          />
          {showUnlikely && groups.unlikely.map((s, i) => row(s, i, "unlikely"))}
        </section>
      )}
    </>
  );
}

// ---- Movie / series ----

function EpisodeRow({
  id,
  episode,
  playing,
  onOpen,
}: {
  id: string;
  episode: Episode;
  playing: boolean;
  onOpen: (e: Episode) => void;
}) {
  const { props } = useOption(id, { primary: () => onOpen(episode) });
  const date = formatAirDate(episode.released);
  const future = isFuture(episode.released);
  return (
    <div {...props} className={cx(styles.item, future && styles.dim)}>
      <div className={cx(styles.still, styles.epStill)}>
        <Img src={episode.thumbnail} />
      </div>
      <div className={styles.grow}>
        <div className={styles.title}>
          <span className={styles.epNum}>
            E{String(episode.episode).padStart(2, "0")}
          </span>
          {episode.title ?? `Episode ${episode.episode}`}
        </div>
        <div className={styles.meta}>
          {future ? `Airs ${date}` : date}
          {playing && <span className={styles.playingNow}> · playing now</span>}
        </div>
      </div>
      <span className={styles.enterHint} aria-hidden>
        streams <IconChevronRight size={14} />
      </span>
    </div>
  );
}

export function TitleView({
  idPrefix,
  title,
  actions,
  close,
  onOpenEpisode,
  onMeta,
  setFooter,
}: {
  idPrefix: string;
  title: TitleRef;
  actions: PickerActions;
  close: () => void;
  onOpenEpisode: (e: Episode, meta: Meta) => void;
  onMeta: (meta: Meta) => void;
  setFooter: (note: string | null) => void;
}) {
  const isMovie = title.type === "movie";
  const {
    data: meta,
    error,
    retry,
  } = useLoad<Meta>(`meta:${title.kind}:${title.id}`, (signal) =>
    getMeta(title.kind, title.id, signal),
  );
  useEffect(() => {
    if (meta) {
      onMeta(meta);
    }
  }, [meta, onMeta]);

  const current = actions.currentMeta;
  const playingHere =
    current && baseContentId(current.id) === title.id ? current : null;
  const seasons = meta?.seasons ?? [];
  const defaultSeason =
    (playingHere?.season != null &&
    seasons.some((s) => s.season === playingHere.season)
      ? playingHere.season
      : seasons.find((s) => s.season > 0)?.season) ??
    seasons[0]?.season ??
    1;
  const [season, setSeason] = useState<number | null>(null);
  const activeSeason = season ?? defaultSeason;
  const episodes =
    seasons.find((s) => s.season === activeSeason)?.episodes ?? [];

  if (isMovie) {
    return (
      <>
        <TitleHeader title={title} meta={meta} />
        <StreamListView
          idPrefix={idPrefix}
          ctx={{ title, imdbId: meta?.imdbId }}
          actions={actions}
          close={close}
          setFooter={setFooter}
        />
      </>
    );
  }

  const seasonLabel = (n: number) => (n === 0 ? "Specials" : `Season ${n}`);
  return (
    <>
      <TitleHeader title={title} meta={meta} />
      {error ? (
        <ErrorBox error={error} retry={retry} />
      ) : !meta ? (
        <StreamSkeletons />
      ) : seasons.length === 0 ? (
        <div className={styles.empty}>No episodes listed for this title.</div>
      ) : (
        <>
          <div className={styles.seasonBar}>
            {seasons.length <= 6 ? (
              <SegmentedControl
                aria-label="Season"
                value={String(activeSeason)}
                onChange={(v) => setSeason(Number(v))}
                data={seasons.map((s) => ({
                  value: String(s.season),
                  label: seasonLabel(s.season),
                }))}
              />
            ) : (
              <Select
                aria-label="Season"
                value={String(activeSeason)}
                onChange={(v) => v && setSeason(Number(v))}
                data={seasons.map((s) => ({
                  value: String(s.season),
                  label: seasonLabel(s.season),
                }))}
                allowDeselect={false}
                comboboxProps={{ withinPortal: true, zIndex: 450 }}
                w={180}
              />
            )}
          </div>
          {episodes.map((e) => (
            <EpisodeRow
              key={e.id}
              id={`${idPrefix}-e-${e.id}`}
              episode={e}
              playing={current?.id === e.id}
              onOpen={(ep) => onOpenEpisode(ep, meta)}
            />
          ))}
        </>
      )}
    </>
  );
}

export function EpisodeView({
  idPrefix,
  title,
  episode,
  imdbId,
  actions,
  close,
  setFooter,
}: {
  idPrefix: string;
  title: TitleRef;
  episode: Episode;
  imdbId?: string | null;
  actions: PickerActions;
  close: () => void;
  setFooter: (note: string | null) => void;
}) {
  const { data: subs } = useLoad<Subtitle[]>(
    `subs:${title.kind}:${episode.id}`,
    (signal) => getSubtitles(title.kind, episode.id, signal).catch(() => []),
  );
  const subLangs = subs
    ? [...new Set(subs.map((s) => s.label.replace(/\s+\d+$/, "")))].slice(0, 4)
    : [];
  const code = episodeCode(episode.season, episode.episode);
  return (
    <>
      <div className={styles.titleHead}>
        <div className={styles.still}>
          <Img src={episode.thumbnail} />
        </div>
        <div className={styles.grow}>
          <h3>
            {code}
            {episode.title ? ` · ${episode.title}` : ""}
          </h3>
          <div className={styles.headMeta}>
            <span>{title.name}</span>
            {formatAirDate(episode.released) && (
              <span>{formatAirDate(episode.released)}</span>
            )}
            {subLangs.length > 0 && (
              <span>
                <IconBadgeCc size={14} style={{ verticalAlign: "-2px" }} />{" "}
                Subtitles found: {subLangs.join(", ")}
              </span>
            )}
          </div>
        </div>
      </div>
      <StreamListView
        idPrefix={idPrefix}
        ctx={{ title, episode, imdbId }}
        actions={actions}
        close={close}
        setFooter={setFooter}
      />
    </>
  );
}
