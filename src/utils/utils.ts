//@ts-expect-error
import canAutoplay from "can-autoplay";

export { serverPath } from "./api";

export function formatTimestamp(input: any, zeroTime?: number): string {
  if (
    input === null ||
    input === undefined ||
    input === false ||
    Number.isNaN(input) ||
    input === Infinity
  ) {
    return "";
  }
  if (zeroTime) {
    return new Date((zeroTime + input) * 1000).toLocaleTimeString();
  }
  let hours = Math.abs(Math.trunc(Number(input) / 3600));
  let minutes = Math.abs(Math.trunc(Number(input) / 60) % 60)
    .toString()
    .padStart(2, "0");
  let seconds = Math.abs(Math.trunc(Number(input) % 60))
    .toString()
    .padStart(2, "0");
  return `${Number(input) < 0 ? "-" : ""}${hours ? `${hours}:` : ""}${minutes}:${seconds}`;
}

export const isYouTube = (input: string) => {
  return (
    input.startsWith("https://www.youtube.com/") ||
    input.startsWith("https://youtu.be/")
  );
};

export const isHttp = (input: string) => {
  return input.startsWith("http");
};

// Direct links to video files, i.e. things the browser can fetch and play (or convert) as a plain media file.
// Excludes pages/streams that are resolved or played by dedicated players (YouTube, HLS, DASH, Reddit/Twitch
// links that the server resolves, etc.)
export const isDirectVideoUrl = (input: string) => {
  return (
    isHttp(input) &&
    !isYouTube(input) &&
    !isHls(input) &&
    !isDash(input) &&
    !isMpegTs(input) &&
    !/^https?:\/\/(www\.|old\.)?(reddit|twitch)\.(com|tv)(\/|$)/.test(input)
  );
};

export const isHls = (input: string) => {
  return input.includes(".m3u8");
};

export const isDash = (input: string) => {
  return input.includes(".mpd");
};

const isMpegTs = (input: string) => {
  return input.includes(".mpegts");
};

export const isScreenShare = (input: string) => {
  return input.startsWith("screenshare://");
};

export const isFileShare = (input: string) => {
  return input.startsWith("fileshare://");
};

/**
 * A blocked autoplay rejects at once; the library's default 250 ms timeout also fails a slow or busy device, which
 * then got a needless "Unmute" scrim that swallowed its first click (e.g. on the seek bar).
 */
export const AUTOPLAY_TEST_TIMEOUT_MS = 2000;

export async function testAutoplay() {
  const result = await canAutoplay.video({ timeout: AUTOPLAY_TEST_TIMEOUT_MS });
  return result.result;
}

export function decodeEntities(input: string) {
  const doc = new DOMParser().parseFromString(input, "text/html");
  return doc.documentElement.textContent;
}

export const isMobile = () => {
  return window.screen.width <= 600;
};

export async function openFileSelector(accept?: string) {
  return new Promise<FileList | null>((resolve) => {
    // Create an input element
    const inputElement = document.createElement("input");

    // Set its type to file
    inputElement.type = "file";

    // Set accept to the file types you want the user to select.
    // Include both the file extension and the mime type
    if (accept) {
      inputElement.accept = accept;
    }

    // set onchange event to call callback when user has selected file
    inputElement.addEventListener("change", () => {
      resolve(inputElement.files);
    });

    // dispatch a click event to open the file dialog
    inputElement.dispatchEvent(new MouseEvent("click"));
  });
}

export function getOrCreateClientId() {
  let clientId = window.localStorage.getItem("watchparty-clientid");
  if (!clientId) {
    // Generate a new clientID and save it
    // This requires https, so fallback to JS implementation if needed
    clientId = createUuid();
    window.localStorage.setItem("watchparty-clientid", clientId);
  }
  return clientId;
}

export function getOrCreateSessionId() {
  let sessionId = window.localStorage.getItem("watchparty-sessionid");
  if (!sessionId) {
    // Generate a new sessionID and save it
    // This requires https, so fallback to JS implementation if needed
    sessionId = createUuid();
    window.localStorage.setItem("watchparty-sessionid", sessionId);
  }
  return sessionId;
}

function createUuid() {
  return crypto.randomUUID ? crypto.randomUUID() : uuidv4();
}

export function calculateMedian(array: number[]): number {
  // Check If Data Exists
  if (array.length >= 1) {
    // Sort Array
    array = array.sort((a: number, b: number) => {
      return a - b;
    });

    // Array Length: Even
    if (array.length % 2 === 0) {
      // Average Of Two Middle Numbers
      return (array[array.length / 2 - 1] + array[array.length / 2]) / 2;
    }
    // Array Length: Odd
    else {
      // Middle Number
      return array[(array.length - 1) / 2];
    }
  }
  return 0;
}

export const isEmojiString = (input?: string): boolean => {
  return /^(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])+$/g.test(
    input ?? "",
  );
};

function uuidv4() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16),
  );
}
