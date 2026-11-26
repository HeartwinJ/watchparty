/**
 * The source picker's command palette: one input that pastes a link, searches Movies & Shows
 * (AIOStreams) and YouTube, or starts a share, with a drill-down title → season/episode → streams.
 * Desktop: centred palette. Phone (≤ 768px): full-screen sheet. Keyboard: ↑/↓ move, Enter plays/opens,
 * Shift+Enter adds to the queue, Esc goes back one level then closes, Backspace in an empty input goes back.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { ActionIcon, Loader, Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import type { Episode, TitleRef } from "../../../api/addons";
import type { PickerMode, PickerTarget } from "../ui/RoomUi";
import { OptionsProvider, useOptionsController } from "./options";
import {
  contextFromVideoMeta,
  episodeCode,
  isUrlInput,
  type StreamContext,
} from "./pickerLogic";
import {
  EmptyView,
  SearchView,
  UrlView,
  useAddonsConfigured,
} from "./RootViews";
import { EpisodeView, TitleView } from "./TitleViews";
import type { Frame, PickerActions, SearchFilter } from "./types";
import styles from "./SourcePicker.module.css";

const ROOT: Frame = { kind: "root" };

/** The frames that show a title/episode's stream list, e.g. for "Pick another" or a recent title */
export function framesForContext(ctx: StreamContext): Frame[] {
  const frames: Frame[] = [
    ROOT,
    { kind: "title", title: ctx.title, imdbId: ctx.imdbId },
  ];
  if (ctx.episode) {
    frames.push({
      kind: "episode",
      title: ctx.title,
      episode: ctx.episode,
      imdbId: ctx.imdbId,
    });
  }
  return frames;
}

function initialFrames(target: PickerTarget | null | undefined): Frame[] {
  if (target?.kind === "streams") {
    return framesForContext(contextFromVideoMeta(target.videoMeta));
  }
  return [ROOT];
}

export function PickerPalette({
  opened,
  onClose,
  actions,
  target,
  mode = "play",
}: {
  opened: boolean;
  onClose: () => void;
  actions: PickerActions;
  target?: PickerTarget | null;
  /** "queue": Enter and the primary buttons add to the queue instead of playing now */
  mode?: PickerMode;
}) {
  const phone = useMediaQuery("(max-width: 768px)") ?? false;
  return (
    <Modal.Root
      opened={opened}
      onClose={onClose}
      size={720}
      yOffset="10vh"
      fullScreen={phone}
      closeOnEscape={false}
      trapFocus
      returnFocus
      zIndex={400}
      transitionProps={{
        transition: phone ? "slide-up" : "pop",
        duration: 180,
      }}
      // classNames (not className on the parts: Modal.Content also passes className to the full-width "inner")
      classNames={{
        overlay: styles.overlay,
        content: styles.content,
        body: styles.modalBody,
      }}
    >
      <Modal.Overlay />
      <Modal.Content
        aria-label="Choose what to watch"
        data-full-screen={phone || undefined}
      >
        <Modal.Body>
          {opened && (
            <PaletteInner
              key={target ? JSON.stringify(target) : mode}
              onClose={onClose}
              actions={actions}
              target={target}
              phone={phone}
              queueMode={mode === "queue"}
            />
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

function PaletteInner({
  onClose,
  actions,
  target,
  phone,
  queueMode,
}: {
  onClose: () => void;
  actions: PickerActions;
  target?: PickerTarget | null;
  phone: boolean;
  queueMode: boolean;
}) {
  const idPrefix = useId().replace(/:/g, "");
  const listboxId = `${idPrefix}-list`;
  const [query, setQuery] = useState(
    target?.kind === "search" ? target.query : "",
  );
  const [frames, setFramesState] = useState<Frame[]>(() =>
    initialFrames(target),
  );
  // Updated synchronously, so several quick Esc presses each go back one level
  const framesRef = useRef(frames);
  const setFrames = useCallback(
    (next: Frame[] | ((fs: Frame[]) => Frame[])) => {
      framesRef.current =
        typeof next === "function" ? next(framesRef.current) : next;
      setFramesState(framesRef.current);
    },
    [],
  );
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [searching, setSearching] = useState(false);
  const [footer, setFooter] = useState<string | null>(null);
  const configured = useAddonsConfigured();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const options = useOptionsController(listRef);
  const frame = frames[frames.length - 1];

  const push = useCallback(
    (f: Frame) => setFrames((fs) => [...fs, f]),
    [setFrames],
  );
  const popTo = useCallback(
    (depth: number) => {
      setFrames((fs) => fs.slice(0, Math.max(1, depth)));
      inputRef.current?.focus();
    },
    [setFrames],
  );
  const back = useCallback(() => {
    const depth = framesRef.current.length;
    if (depth > 1) {
      popTo(depth - 1);
      return true;
    }
    return false;
  }, [popTo]);

  const openTitle = useCallback(
    (title: TitleRef) => push({ kind: "title", title }),
    [push],
  );
  const openContext = useCallback(
    (ctx: StreamContext) => setFrames(framesForContext(ctx)),
    [],
  );
  const openEpisode = useCallback(
    (title: TitleRef, imdbId: string | null) => (episode: Episode) =>
      push({ kind: "episode", title, episode, imdbId }),
    [push],
  );
  // Keep the imdb id from the title's meta for the episode level
  const [titleImdb, setTitleImdb] = useState<string | null>(null);
  const onMeta = useCallback(
    (meta: { imdbId: string | null }) => setTitleImdb(meta.imdbId),
    [],
  );

  // Scroll to the top whenever the level changes, and keep typing/arrow keys going to the input (clicking a row
  // would otherwise leave focus on the dialog itself)
  useEffect(() => {
    listRef.current?.scrollTo?.({ top: 0 });
    inputRef.current?.focus();
  }, [frame]);

  // Esc works wherever focus is inside the dialog (a clicked row, a button, the dialog itself)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) {
        return;
      }
      // Let an open dropdown (e.g. the season Select) close itself first
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[aria-expanded="true"][aria-haspopup]')) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (!back()) {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [back]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The rest only applies while typing in the input (buttons keep their own keys)
    if (e.target !== inputRef.current) {
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      options.move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      if (e.nativeEvent.isComposing) {
        return;
      }
      e.preventDefault();
      const handled = options.run(e.shiftKey);
      if (!handled && !e.shiftKey && isUrlInput(query)) {
        actions.playUrl(query.trim());
        onClose();
      }
    } else if (
      e.key === "Backspace" &&
      query === "" &&
      framesRef.current.length > 1
    ) {
      e.preventDefault();
      back();
    }
  };

  const onInput = (value: string) => {
    setQuery(value);
    if (frames.length > 1) {
      // Typing starts a new search from the top level
      setFrames([ROOT]);
    }
  };

  const trimmed = query.trim();
  const crumbs: { label: string; depth: number }[] = [];
  if (frames.length > 1) {
    crumbs.push({
      label: trimmed ? `Results for “${trimmed}”` : "Start",
      depth: 1,
    });
    frames.slice(1).forEach((f, i) => {
      if (f.kind === "title") {
        crumbs.push({ label: f.title.name, depth: i + 2 });
      } else if (f.kind === "episode") {
        crumbs.push({
          label: `${episodeCode(f.episode.season, f.episode.episode)}${f.episode.title ? ` · ${f.episode.title}` : ""}`,
          depth: i + 2,
        });
      }
    });
  }

  let body: React.ReactNode;
  if (frame.kind === "title") {
    body = (
      <TitleView
        key={`t-${frame.title.kind}-${frame.title.id}`}
        idPrefix={idPrefix}
        title={frame.title}
        actions={actions}
        close={onClose}
        onOpenEpisode={(ep, meta) => openEpisode(frame.title, meta.imdbId)(ep)}
        onMeta={onMeta}
        setFooter={setFooter}
      />
    );
  } else if (frame.kind === "episode") {
    body = (
      <EpisodeView
        key={`e-${frame.episode.id}`}
        idPrefix={idPrefix}
        title={frame.title}
        episode={frame.episode}
        imdbId={frame.imdbId ?? titleImdb}
        actions={actions}
        close={onClose}
        setFooter={setFooter}
      />
    );
  } else if (!trimmed) {
    body = (
      <EmptyView
        idPrefix={idPrefix}
        actions={actions}
        queueMode={queueMode}
        onOpenContext={openContext}
        close={onClose}
      />
    );
  } else if (isUrlInput(trimmed)) {
    body = (
      <UrlView
        key={trimmed}
        idPrefix={idPrefix}
        url={trimmed}
        actions={actions}
        close={onClose}
      />
    );
  } else {
    body = (
      <SearchView
        idPrefix={idPrefix}
        query={trimmed}
        filter={filter}
        setFilter={setFilter}
        actions={actions}
        onOpenTitle={openTitle}
        onLoadingChange={setSearching}
        close={onClose}
      />
    );
  }

  return (
    <div className={styles.modalBody} onKeyDown={onKeyDown}>
      <div className={styles.head}>
        {frames.length > 1 ? (
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Back"
            onClick={back}
            size="lg"
          >
            <IconChevronLeft size={20} />
          </ActionIcon>
        ) : (
          <span className={styles.headIcon} aria-hidden>
            {searching ? (
              <Loader size={18} color="gray" />
            ) : (
              <IconSearch size={20} />
            )}
          </span>
        )}
        <input
          ref={inputRef}
          data-autofocus
          className={styles.input}
          value={query}
          onChange={(e) => onInput(e.currentTarget.value)}
          placeholder={
            configured
              ? "Search movies, shows, YouTube, or paste a link"
              : "Search YouTube or paste a link"
          }
          role="combobox"
          aria-label="Search or paste a link"
          aria-expanded
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={options.activeId ?? undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Close"
          onClick={onClose}
          size="lg"
        >
          <IconX size={20} />
        </ActionIcon>
      </div>
      {crumbs.length > 0 && (
        <nav className={styles.crumbs} aria-label="Breadcrumbs">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <React.Fragment key={c.depth}>
                {i > 0 && <IconChevronRight size={14} aria-hidden />}
                {last ? (
                  <span className={styles.crumbCurrent} aria-current="page">
                    {c.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.crumb}
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
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Results"
        className={styles.body}
      >
        <OptionsProvider api={options.api} queueMode={queueMode}>
          {body}
        </OptionsProvider>
      </div>
      {!phone && (
        <div className={styles.foot}>
          <span>
            <kbd className={styles.kbd}>↑</kbd>
            <kbd className={styles.kbd}>↓</kbd> move
          </span>
          <span>
            <kbd className={styles.kbd}>↵</kbd>{" "}
            {queueMode ? "open / add to queue" : "open / play"}
          </span>
          <span>
            <kbd className={styles.kbd}>⇧</kbd>
            <kbd className={styles.kbd}>↵</kbd>{" "}
            {queueMode ? "play now" : "add to queue"}
          </span>
          <span>
            <kbd className={styles.kbd}>esc</kbd> back / close
          </span>
          <span className={styles.footRight}>
            {footer ??
              (configured
                ? "Movies & Shows via AIOStreams · YouTube"
                : "YouTube")}
          </span>
        </div>
      )}
    </div>
  );
}
