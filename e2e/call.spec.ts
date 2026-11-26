import { expect, type Page } from "@playwright/test";
import { createRoom, focusPlayer, test, type Viewer } from "./helpers.ts";

// Voice/video call with Chromium's fake mic and camera (--use-fake-device-for-media-stream).
// Every RTCPeerConnection is recorded so the tests can check connection states and real RTP stats.

declare global {
  interface Window {
    __pcs: RTCPeerConnection[];
  }
}

function recordPeerConnections() {
  window.__pcs = [];
  const Orig = window.RTCPeerConnection;
  const Wrapped = function (
    ...args: ConstructorParameters<typeof RTCPeerConnection>
  ) {
    const pc = new Orig(...args);
    window.__pcs.push(pc);
    return pc;
  } as unknown as typeof RTCPeerConnection;
  Wrapped.prototype = Orig.prototype;
  Object.setPrototypeOf(Wrapped, Orig);
  window.RTCPeerConnection = Wrapped;
}

const joinPage = (
  join: (r: string, l: string, o?: object) => Promise<Viewer>,
  room: string,
  label: string,
) => join(room, label, { initScript: recordPeerConnections });

async function openCallPanel(page: Page) {
  await page
    .getByRole("button", { name: /^Voice call/ })
    .first()
    .click();
}

async function joinCall(v: Viewer, { cameraFirst = false } = {}) {
  await openCallPanel(v.page);
  if (cameraFirst) {
    await v.page.getByRole("button", { name: "Turn camera on" }).last().click();
    await expect(
      v.page.getByRole("button", { name: "Turn camera off" }).last(),
    ).toBeVisible();
  }
  await v.page.getByRole("button", { name: "Join voice call" }).click();
  await expect(
    v.page.getByRole("button", { name: "Leave call" }),
  ).toBeVisible();
  await openCallPanel(v.page); // toggles it closed
  await expect(v.page.getByRole("button", { name: "Leave call" })).toBeHidden();
}

/** The desktop top-bar camera button. */
async function cameraButton(v: Viewer) {
  await v.page
    .locator(
      'header button[aria-label="Turn camera on"], header button[aria-label="Turn camera off"]',
    )
    .click();
}

/** The V shortcut (only in a call). */
async function cameraKey(v: Viewer) {
  await focusPlayer(v.page);
  await v.page.keyboard.press("v");
}

/** Open peer connections: state + inbound audio packets. */
function peers(page: Page) {
  return page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs.filter(
      (p) => p.connectionState !== "closed",
    )) {
      let audioPackets = 0;
      (await pc.getStats()).forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "audio") {
          audioPackets += s.packetsReceived ?? 0;
        }
      });
      out.push({ state: pc.connectionState, audioPackets });
    }
    return out;
  });
}

/** Remote camera <video>s whose frames are actually advancing (local previews use the fake device's label). */
function liveRemoteVideos(page: Page) {
  return page.evaluate(async () => {
    const videos = [...document.querySelectorAll("video")].filter(
      (v) =>
        v.srcObject instanceof MediaStream &&
        v.srcObject.getVideoTracks().length > 0 &&
        !/fake/i.test(v.srcObject.getVideoTracks()[0].label),
    );
    const before = videos.map(
      (v) => v.getVideoPlaybackQuality().totalVideoFrames,
    );
    await new Promise((r) => setTimeout(r, 500));
    return videos.filter(
      (v, i) =>
        v.videoWidth > 0 &&
        v.getVideoPlaybackQuality().totalVideoFrames > before[i],
    ).length;
  });
}

/** Every viewer is connected to every other one, receives audio, and sees `cams(v)` live remote cameras. */
async function expectCall(
  viewers: Viewer[],
  cams: (v: Viewer) => number,
  stage: string,
) {
  for (const v of viewers) {
    await expect
      .poll(
        async () => {
          const p = await peers(v.page);
          return p.length === viewers.length - 1 &&
            p.every((x) => x.state === "connected" && x.audioPackets > 0)
            ? "ok"
            : JSON.stringify(p);
        },
        {
          message: `${stage}: ${v.label} connected with audio`,
          timeout: 20_000,
        },
      )
      .toBe("ok");
    await expect
      .poll(() => liveRemoteVideos(v.page), {
        message: `${stage}: ${v.label} sees ${cams(v)} live remote camera(s)`,
        timeout: 20_000,
      })
      .toBe(cams(v));
  }
}

test.describe.configure({ timeout: 120_000 });

test("two people: camera on after joining (button and V), off and on again, mute shown to the other", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!);
  const a = await joinPage(join, room, "A");
  const b = await joinPage(join, room, "B");
  await joinCall(a);
  await joinCall(b);
  await expectCall([a, b], () => 0, "joined, cameras off");

  await cameraButton(a);
  await expectCall([a, b], (v) => (v === b ? 1 : 0), "A camera via button");
  await cameraKey(b);
  await expectCall([a, b], () => 1, "B camera via V");
  await cameraButton(a);
  await expectCall([a, b], (v) => (v === a ? 1 : 0), "A camera off");
  await cameraButton(a);
  await expectCall([a, b], () => 1, "A camera on again");

  // A mutes: B sees it in the People panel
  await a.page.locator('header button[aria-label="Mute microphone"]').click();
  await expect(
    a.page.locator('header button[aria-label="Unmute microphone"]'),
  ).toBeVisible();
  await b.page.getByRole("tab", { name: /People/ }).click();
  await expect(b.page.getByLabel("In the voice call, muted")).toHaveCount(1);
  await a.page.locator('header button[aria-label="Unmute microphone"]').click();
  await expect(b.page.getByLabel("In the voice call, muted")).toHaveCount(0);
  await expect(
    b.page.getByLabel("In the voice call", { exact: true }),
  ).toHaveCount(2);
});

test("two people with cameras on before joining", async ({ join, baseURL }) => {
  const room = await createRoom(baseURL!);
  const a = await joinPage(join, room, "A");
  const b = await joinPage(join, room, "B");
  await joinCall(a, { cameraFirst: true });
  await joinCall(b, { cameraFirst: true });
  await expectCall([a, b], () => 1, "both cameras before joining");
});

test("two people turning their cameras on at the same moment", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!);
  const a = await joinPage(join, room, "A");
  const b = await joinPage(join, room, "B");
  await joinCall(a);
  await joinCall(b);
  await expectCall([a, b], () => 0, "joined");
  await Promise.all([cameraKey(a), cameraKey(b)]);
  await expectCall([a, b], () => 1, "simultaneous cameras");
});

test("three people: a third joins, turns the camera on, and someone reloads", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!);
  const a = await joinPage(join, room, "A");
  const b = await joinPage(join, room, "B");
  await joinCall(a);
  await joinCall(b);
  await cameraKey(a);
  await cameraKey(b);
  await expectCall([a, b], () => 1, "A and B cameras");

  const c = await joinPage(join, room, "C");
  await joinCall(c);
  await expectCall(
    [a, b, c],
    (v) => (v === c ? 2 : 1),
    "C joined with the camera off",
  );
  await cameraKey(c);
  await expectCall([a, b, c], () => 2, "C camera on");

  // A reload rejoins the call (camera off)
  await b.page.reload();
  await expect(b.page.locator("#leftVideo")).toBeAttached();
  await expectCall([a, b, c], (v) => (v === b ? 2 : 1), "B reloaded");
  await cameraKey(b);
  await expectCall([a, b, c], () => 2, "B camera on after the reload");
});

/** How much inbound video (frames decoded) and audio (packets) this page got, over all its peer connections. */
function inbound(page: Page) {
  return page.evaluate(async () => {
    let videoFrames = 0;
    let audioPackets = 0;
    for (const pc of window.__pcs.filter(
      (p) => p.connectionState !== "closed",
    )) {
      (await pc.getStats()).forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") {
          videoFrames += s.framesDecoded ?? 0;
        } else if (s.type === "inbound-rtp" && s.kind === "audio") {
          audioPackets += s.packetsReceived ?? 0;
        }
      });
    }
    return { videoFrames, audioPackets };
  });
}

/** Inbound growth over `ms` */
async function inboundGrowth(page: Page, ms = 1500) {
  const before = await inbound(page);
  await page.waitForTimeout(ms);
  const after = await inbound(page);
  return {
    video: after.videoFrames - before.videoFrames,
    audio: after.audioPackets - before.audioPackets,
  };
}

/** Polls until this page gets no new video frames while audio keeps coming */
async function expectVideoStopped(v: Viewer, stage: string) {
  await expect
    .poll(
      async () => {
        const g = await inboundGrowth(v.page);
        return g.video === 0 && g.audio > 0 ? "ok" : JSON.stringify(g);
      },
      {
        message: `${stage}: ${v.label} gets audio but no video`,
        timeout: 20_000,
      },
    )
    .toBe("ok");
}

test("hidden or collapsed video tiles stop receiving camera video; voice and the others are unaffected", async ({
  join,
  baseURL,
}) => {
  const room = await createRoom(baseURL!);
  const a = await joinPage(join, room, "A");
  const b = await joinPage(join, room, "B");
  const c = await joinPage(join, room, "C");
  for (const v of [a, b, c]) {
    await joinCall(v);
  }
  await cameraKey(a);
  await cameraKey(c);
  await expectCall([a, b, c], (v) => (v === b ? 2 : 1), "A and C cameras");

  // B hides the tiles: A and C stop sending B video, B still hears them, C still gets A's camera
  await b.page
    .getByRole("button", { name: "Hide video tiles on this device" })
    .click();
  await expectVideoStopped(b, "B hid the tiles");
  for (const v of [a, c]) {
    expect(await liveRemoteVideos(v.page)).toBe(1);
  }
  expect((await inboundGrowth(c.page)).video).toBeGreaterThan(0);

  // B shows them again (call panel switch): video resumes quickly
  await openCallPanel(b.page);
  await b.page.getByRole("switch", { name: /Show video tiles/ }).click();
  await openCallPanel(b.page);
  await expect
    .poll(() => liveRemoteVideos(b.page), {
      message: "B sees both cameras again",
      timeout: 10_000,
    })
    .toBe(2);

  // Collapsing the strip works the same way
  await b.page.getByRole("button", { name: "Collapse call video" }).click();
  await expectVideoStopped(b, "B collapsed the strip");
  await b.page.getByRole("button", { name: "Show call video (2)" }).click();
  await expect
    .poll(() => liveRemoteVideos(b.page), {
      message: "B sees both cameras after expanding",
      timeout: 10_000,
    })
    .toBe(2);
  await expectCall([a, b, c], (v) => (v === b ? 2 : 1), "everyone again");
});
