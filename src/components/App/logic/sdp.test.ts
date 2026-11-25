import { describe, expect, it } from "vitest";
import { stripExtmapAllowMixed, tuneAnswerSdp } from "./sdp";

describe("stripExtmapAllowMixed", () => {
  it("removes the attribute line and keeps the rest", () => {
    const sdp = "v=0\r\na=extmap-allow-mixed\r\nm=audio 9\r\n";
    expect(stripExtmapAllowMixed(sdp)).toBe("v=0\r\nm=audio 9\r\n");
  });
});

describe("tuneAnswerSdp", () => {
  const sdp =
    "a=rtpmap:111 opus/48000/2\na=fmtp:111 minptime=10;useinbandfec=1";

  it("enables stereo", () => {
    expect(tuneAnswerSdp(sdp, false)).toBe(
      "a=rtpmap:111 opus/48000/2\na=fmtp:111 minptime=10;useinbandfec=1; stereo=1; maxaveragebitrate=510000",
    );
  });

  it("enables multichannel opus on Chromium", () => {
    const out = tuneAnswerSdp(sdp, true);
    expect(out).toContain("multiopus/48000/6");
    expect(out).toContain("channel_mapping=0,4,1,2,3,5");
    expect(out).toContain("stereo=1");
  });
});
