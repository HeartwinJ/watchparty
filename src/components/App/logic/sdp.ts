// SDP tweaks for screen/file share (WebRTC).

/** iOS/Safari can't handle the a=extmap-allow-mixed attribute, so remove it from incoming offers. */
export function stripExtmapAllowMixed(sdp: string) {
  return sdp
    .split("\n")
    .filter((line) => line.trim() !== "a=extmap-allow-mixed")
    .join("\n");
}

/** Allows stereo audio in an answer, and multichannel (5.1) Opus on Chromium. */
export function tuneAnswerSdp(sdp: string, isChromium: boolean) {
  let out = sdp.replace(
    "useinbandfec=1",
    "useinbandfec=1; stereo=1; maxaveragebitrate=510000",
  );
  if (isChromium) {
    out = out
      .replace("opus/48000/2", "multiopus/48000/6")
      .replace(
        "useinbandfec=1",
        "channel_mapping=0,4,1,2,3,5; num_streams=4; coupled_streams=2;maxaveragebitrate=510000;minptime=10;useinbandfec=1",
      );
  }
  return out;
}
