/**
 * /addon/* routes: title search, metadata, AIOStreams streams, subtitles and
 * next episode. All behind the instance password (requireAuth).
 */
import express, { type RequestHandler, type Response } from "express";
import { createAioStreams } from "./aiostreams.ts";
import { TtlCache } from "./cache.ts";
import { createCatalog, NotFoundError } from "./catalog.ts";
import { AddonError, createRedactor, type FetchFn } from "./http.ts";
import { isContentId, isContentType, parseContentId } from "./ids.ts";
import { rankStreams } from "./streamParser.ts";
import { createSubtitles, parseLangList } from "./subtitles.ts";

export type AddonRouterOptions = {
  /** AIOSTREAMS_MANIFEST_URL. Every route answers 503 while it's empty. */
  manifestUrl: string;
  /** SUBTITLE_LANGS, e.g. "en,es" */
  subtitleLangs: string;
  requireAuth: RequestHandler;
  /** For the public addons (Cinemeta, Kitsu, OpenSubtitles); server.ts passes utils/ssrf.ts safeFetch */
  fetchFn: FetchFn;
  /** For the owner's AIOStreams host (may be on a private network, so no SSRF guard). */
  aioFetchFn?: FetchFn;
  timeoutMs?: number;
  aioTimeoutMs?: number;
  log?: (msg: string) => void;
};

const MAX_QUERY_LENGTH = 100;
const BINGE_GROUP_MAX = 300;

export function createAddonRouter(opts: AddonRouterOptions) {
  const router = express.Router();
  const configured = Boolean(opts.manifestUrl.trim());
  const redact = createRedactor(opts.manifestUrl.trim());
  const log = (msg: string) => (opts.log ?? console.warn)(redact(msg));

  const metaCache = new TtlCache<unknown>({ maxEntries: 500 });
  // ~200 streams per entry, a few hundred KB each at most
  const streamCache = new TtlCache<unknown>({ maxEntries: 100 });
  const catalog = createCatalog({
    fetchFn: opts.fetchFn,
    cache: metaCache,
    timeoutMs: opts.timeoutMs,
  });
  const subtitles = createSubtitles({
    fetchFn: opts.fetchFn,
    cache: metaCache,
    catalog,
    preferredLangs: parseLangList(opts.subtitleLangs || "en"),
    timeoutMs: opts.timeoutMs,
  });
  const aio = configured
    ? createAioStreams({
        manifestUrl: opts.manifestUrl,
        fetchFn: opts.aioFetchFn ?? fetch,
        cache: streamCache,
        timeoutMs: opts.aioTimeoutMs,
      })
    : null;

  router.use("/addon", opts.requireAuth, (_req, res, next) => {
    if (!configured) {
      res.status(503).json({ error: "aiostreams_not_configured" });
      return;
    }
    next();
  });

  const fail = (res: Response, route: string, e: unknown) => {
    if (e instanceof NotFoundError) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (e instanceof AddonError) {
      log(`[addon] ${route} failed: ${e.message}`);
      res.status(502).json({
        error: e.kind === "timeout" ? "upstream_timeout" : "upstream_error",
      });
      return;
    }
    // Unexpected bug: log only the error name so nothing upstream-supplied leaks
    log(`[addon] ${route} failed: ${(e as Error)?.name ?? "error"}`);
    res.status(500).json({ error: "internal_error" });
  };

  const validParams: RequestHandler = (req, res, next) => {
    if (!isContentType(req.params.type) || !isContentId(req.params.id)) {
      res.status(400).json({ error: "invalid_params" });
      return;
    }
    next();
  };

  router.get("/addon/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q || q.length > MAX_QUERY_LENGTH) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    try {
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json(await catalog.search(q));
    } catch (e) {
      fail(res, "search", e);
    }
  });

  router.get("/addon/meta/:type/:id", validParams, async (req, res) => {
    const { type, id } = req.params as {
      type: "movie" | "series" | "anime";
      id: string;
    };
    try {
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json(await catalog.meta(type, parseContentId(id)!.base));
    } catch (e) {
      fail(res, "meta", e);
    }
  });

  router.get("/addon/streams/:type/:id", validParams, async (req, res) => {
    const { type, id } = req.params as {
      type: "movie" | "series" | "anime";
      id: string;
    };
    const bingeGroup =
      typeof req.query.bingeGroup === "string"
        ? req.query.bingeGroup.slice(0, BINGE_GROUP_MAX)
        : undefined;
    try {
      const raw = await aio!.rawStreams(type, id);
      // Playback URLs are per-stream links, but still don't let proxies cache them
      res.setHeader("Cache-Control", "no-store");
      res.json(rankStreams(raw, { bingeGroup }));
    } catch (e) {
      fail(res, "streams", e);
    }
  });

  router.get("/addon/subtitles/:type/:id", validParams, async (req, res) => {
    try {
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json(await subtitles.list(req.params.id as string));
    } catch (e) {
      fail(res, "subtitles", e);
    }
  });

  router.get("/addon/next/:type/:id", validParams, async (req, res) => {
    const { type, id } = req.params as {
      type: "movie" | "series" | "anime";
      id: string;
    };
    try {
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json({ next: await catalog.nextEpisode(type, id) });
    } catch (e) {
      fail(res, "next", e);
    }
  });

  return router;
}
