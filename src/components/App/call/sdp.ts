// SDP tweak for voice: ask the other side's Opus encoder for DTX (no packets during silence), in-band FEC and a
// voice-sized bitrate. Applied to remote descriptions before setRemoteDescription, because the fmtp parameters in
// the remote description configure our encoder.

export const VOICE_MAX_BITRATE = 32_000;

const OPUS_PARAMS: [string, string][] = [
  ["usedtx", "1"],
  ["useinbandfec", "1"],
  ["maxaveragebitrate", String(VOICE_MAX_BITRATE)],
];

export function tuneVoiceSdp(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(eol);
  const opusPts = new Set<string>();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (m) {
      opusPts.add(m[1]);
    }
  }
  if (!opusPts.size) {
    return sdp;
  }
  const seenFmtp = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fmtp && opusPts.has(fmtp[1])) {
      seenFmtp.add(fmtp[1]);
      const params = fmtp[2]
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean);
      const keys = new Set(params.map((p) => p.split("=")[0].toLowerCase()));
      for (const [k, v] of OPUS_PARAMS) {
        if (!keys.has(k)) {
          params.push(`${k}=${v}`);
        }
      }
      out.push(`a=fmtp:${fmtp[1]} ${params.join(";")}`);
      continue;
    }
    out.push(line);
    const rtpmap = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (rtpmap && !lines.some((l) => l.startsWith(`a=fmtp:${rtpmap[1]} `))) {
      // No fmtp line for Opus at all: add one right after its rtpmap
      seenFmtp.add(rtpmap[1]);
      out.push(
        `a=fmtp:${rtpmap[1]} ${OPUS_PARAMS.map(([k, v]) => `${k}=${v}`).join(";")}`,
      );
    }
  }
  return out.join(eol);
}
