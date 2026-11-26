// Static server for the e2e video fixtures (a separate origin, like a real video host).
// Supports Range requests and one test hook: a request with the header
// `x-e2e-throttle: <token>:<bytes>` gets only the first <bytes> of the file, then the
// rest is held back until `GET /__release?token=<token>`, so one browser can be made
// to stall while the others keep playing. `?nocors` serves a file without CORS headers
// (a video host that doesn't allow other sites to read its files).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.E2E_MEDIA_PORT ?? 18573);
const dir = path.join(import.meta.dirname, "fixtures");
const released = new Set<string>();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.searchParams.has("nocors")) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-expose-headers", "*");
  }
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (url.pathname === "/__release") {
    released.add(url.searchParams.get("token") ?? "");
    res.end("ok");
    return;
  }
  if (url.pathname === "/ping") {
    res.end("ok");
    return;
  }
  const file = path.join(dir, path.basename(url.pathname));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    res.statusCode = 404;
    res.end();
    return;
  }
  let start = 0;
  let end = stat.size - 1;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    if (range[1]) start = Number(range[1]);
    if (range[2]) end = Math.min(Number(range[2]), end);
    if (start > end) {
      res.statusCode = 416;
      res.setHeader("content-range", `bytes */${stat.size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${start}-${end}/${stat.size}`);
  }
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-type", "video/webm");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", end - start + 1);
  const data = fs.readFileSync(file).subarray(start, end + 1);

  // Only the <video> element's own requests are held, not the app's probes (fetch)
  console.log(
    req.method,
    url.pathname,
    req.headers.range,
    req.headers["sec-fetch-dest"],
    req.headers["x-e2e-throttle"],
  );
  const throttle =
    req.headers["sec-fetch-dest"] === "video"
      ? String(req.headers["x-e2e-throttle"] ?? "")
      : "";
  const [token, limitText] = throttle.split(":");
  const limit = Number(limitText);
  // Reads of the file's tail (the WebM index) are never held, so the player can open the file
  const tail = stat.size - 16 * 1024;
  if (
    !token ||
    !limit ||
    released.has(token) ||
    start >= tail ||
    start + data.length <= limit
  ) {
    res.end(data);
    return;
  }
  // Send what's below the limit, then wait for the release
  const head = Math.max(0, limit - start);
  res.write(data.subarray(0, head));
  while (!released.has(token) && !res.destroyed) {
    await new Promise((r) => setTimeout(r, 100));
  }
  res.end(data.subarray(head));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`e2e media server on :${port}`);
});
