import { describe, expect, it } from "vitest";
import { tuneVoiceSdp, VOICE_MAX_BITRATE } from "./sdp";

const sdp = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "",
].join("\r\n");

describe("tuneVoiceSdp", () => {
  it("adds DTX, FEC and a voice bitrate to Opus only", () => {
    const out = tuneVoiceSdp(sdp);
    expect(out).toContain(
      `a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=${VOICE_MAX_BITRATE}`,
    );
    expect(out).toContain("a=fmtp:63 111/111");
    expect(out.split("\r\n")).toHaveLength(sdp.split("\r\n").length);
  });

  it("keeps values that are already there", () => {
    const out = tuneVoiceSdp(
      sdp.replace("useinbandfec=1", "useinbandfec=0;usedtx=0"),
    );
    expect(out).toContain(
      `a=fmtp:111 minptime=10;useinbandfec=0;usedtx=0;maxaveragebitrate=${VOICE_MAX_BITRATE}`,
    );
  });

  it("adds an fmtp line when Opus has none", () => {
    const out = tuneVoiceSdp(
      "v=0\nm=audio 9 RTP/AVP 109\na=rtpmap:109 opus/48000/2\n",
    );
    expect(out).toBe(
      `v=0\nm=audio 9 RTP/AVP 109\na=rtpmap:109 opus/48000/2\na=fmtp:109 usedtx=1;useinbandfec=1;maxaveragebitrate=${VOICE_MAX_BITRATE}\n`,
    );
  });

  it("leaves SDP without Opus alone", () => {
    expect(tuneVoiceSdp("v=0\r\nm=video 9 RTP/AVP 96\r\n")).toBe(
      "v=0\r\nm=video 9 RTP/AVP 96\r\n",
    );
  });
});
