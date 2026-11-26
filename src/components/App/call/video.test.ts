import { describe, expect, it } from "vitest";
import {
  cameraConstraints,
  classifyCameraError,
  scaleDownBy,
  videoCapsFor,
} from "./video";

describe("videoCapsFor", () => {
  it("shrinks each sender's video as the call grows", () => {
    expect(videoCapsFor(1)).toEqual({
      maxBitrate: 1_200_000,
      maxHeight: 720,
      maxFramerate: 30,
    });
    expect(videoCapsFor(2)).toMatchObject({
      maxBitrate: 700_000,
      maxHeight: 540,
    });
    expect(videoCapsFor(3)).toMatchObject({
      maxBitrate: 400_000,
      maxHeight: 360,
    });
    expect(videoCapsFor(4)).toEqual(videoCapsFor(3));
    expect(videoCapsFor(7)).toMatchObject({ maxHeight: 240, maxFramerate: 15 });
    // Nobody yet: as for one
    expect(videoCapsFor(0)).toEqual(videoCapsFor(1));
  });

  it("keeps a sender's total upload under ~1.6 Mbps at every call size", () => {
    for (let peers = 1; peers <= 7; peers++) {
      const total = peers * videoCapsFor(peers).maxBitrate;
      expect(total).toBeLessThanOrEqual(1_600_000);
      // And never more per peer than with fewer peers
      if (peers > 1) {
        expect(videoCapsFor(peers).maxBitrate).toBeLessThanOrEqual(
          videoCapsFor(peers - 1).maxBitrate,
        );
      }
    }
  });
});

describe("scaleDownBy", () => {
  it("scales the capture down to the cap, never up", () => {
    expect(scaleDownBy(720, 720)).toBe(1);
    expect(scaleDownBy(720, 360)).toBe(2);
    expect(scaleDownBy(720, 540)).toBe(1.33);
    expect(scaleDownBy(480, 720)).toBe(1);
    expect(scaleDownBy(1080, 240)).toBe(4.5);
    // Unknown capture size: assume what we asked for (720p)
    expect(scaleDownBy(undefined, 360)).toBe(2);
    expect(scaleDownBy(0, 360)).toBe(2);
  });
});

describe("cameraConstraints", () => {
  it("asks for 720p at most, the chosen camera or the front one", () => {
    expect(cameraConstraints("cam-1")).toMatchObject({
      height: { ideal: 720 },
      frameRate: { max: 30 },
      deviceId: { exact: "cam-1" },
    });
    const def = cameraConstraints(null);
    expect(def).toMatchObject({ facingMode: { ideal: "user" } });
    expect(def).not.toHaveProperty("deviceId");
  });

  it("classifies camera errors like mic errors", () => {
    expect(classifyCameraError({ name: "NotAllowedError" })).toBe("blocked");
    expect(classifyCameraError({ name: "NotReadableError" })).toBe("in-use");
    expect(classifyCameraError({ name: "NotFoundError" })).toBe("no-device");
  });
});
