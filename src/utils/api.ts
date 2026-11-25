import config from "../config";

// Where the client sends API requests: VITE_SERVER_HOST, or hostname:8080 in dev, or the same origin in prod.
export const serverPath =
  config.VITE_SERVER_HOST ||
  `${window.location.protocol}//${
    config.NODE_ENV === "development"
      ? `${window.location.hostname}:8080`
      : window.location.host
  }`;

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Subscribe to "the server says we're not logged in". Returns an unsubscribe function. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

/** Tell the app the session is gone (e.g. a 401 or a socket rejected with "unauthorized"). */
export function notifyUnauthorized() {
  unauthorizedListeners.forEach((listener) => listener());
}

/** Resolve a path ("/youtube?q=") or absolute URL against serverPath. */
export function apiUrl(pathOrUrl: string) {
  return pathOrUrl.startsWith("/") ? serverPath + pathOrUrl : pathOrUrl;
}

export function isServerUrl(url: string) {
  return url === serverPath || url.startsWith(serverPath + "/");
}

/**
 * fetch() for our own server. Sends the session cookie (the dev client runs on a different port than the
 * server, so credentials must be "include"), and a 401 sends the app back to the login screen.
 * URLs on other origins are fetched normally, without credentials.
 */
export async function apiFetch(
  pathOrUrl: string,
  init?: RequestInit,
  options?: { ignoreUnauthorized?: boolean },
): Promise<Response> {
  const url = apiUrl(pathOrUrl);
  if (!isServerUrl(url)) {
    return fetch(url, init);
  }
  const response = await fetch(url, { credentials: "include", ...init });
  if (response.status === 401 && !options?.ignoreUnauthorized) {
    notifyUnauthorized();
  }
  return response;
}
