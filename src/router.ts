// A tiny client-side router (History API). The app has only a handful of routes, so this replaces react-router.
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "create" }
  | { name: "watch"; roomId: string }
  | { name: "notFound" };

/** Maps a pathname to a route. Trailing slashes are ignored. */
export function matchRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") {
    return { name: "home" };
  }
  if (path === "/create") {
    return { name: "create" };
  }
  const watch = /^\/watch\/([^/]+)$/.exec(path);
  if (watch) {
    let roomId = watch[1];
    try {
      roomId = decodeURIComponent(roomId);
    } catch {
      // Malformed escape sequence: use it as is
    }
    return { name: "watch", roomId };
  }
  return { name: "notFound" };
}

// pushState/replaceState don't fire popstate, so navigate() fires this event to notify subscribers
const NAVIGATE_EVENT = "watchparty:navigate";

/** Changes the URL without reloading the page and re-renders components that use useRoute(). */
export function navigate(to: string, options?: { replace?: boolean }) {
  if (options?.replace) {
    window.history.replaceState(null, "", to);
  } else {
    window.history.pushState(null, "", to);
  }
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

const getPathname = () => window.location.pathname;

/** The current pathname, kept in sync with back/forward and navigate(). */
export function usePathname() {
  return useSyncExternalStore(subscribe, getPathname, getPathname);
}

/** The route matching the current URL. */
export function useRoute(): Route {
  return matchRoute(usePathname());
}
