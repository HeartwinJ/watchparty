import { isYouTube } from "./utils";

export const examples: SearchResult[] = [
  {
    url: "https://upload.wikimedia.org/wikipedia/commons/7/7a/Charge_-_Blender_Open_Movie-full_movie.webm",
    img: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2a/Charge_-_Blender_Open_Movie-YouTube_thumbnail.jpg/320px-Charge_-_Blender_Open_Movie-YouTube_thumbnail.jpg",
  },
  {
    url: "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
    img: "https://i.ytimg.com/vi/kJQP7kiw5Fk/default.jpg",
  },
  {
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    img: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/Big_Buck_Bunny_-_forest.jpg/320px-Big_Buck_Bunny_-_forest.jpg",
  },
  {
    url: "https://upload.wikimedia.org/wikipedia/commons/a/a5/Spring_-_Blender_Open_Movie.webm",
    img: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7c/SpringOpenMovie-desend.jpg/320px-SpringOpenMovie-desend.jpg",
  },
  {
    url: "https://livesim2.dashif.org/livesim2/testpic_2s/Manifest.mpd",
    img: "",
  },
].map((urlOrObject: { url: string; img: string } | string) => {
  const url = typeof urlOrObject === "object" ? urlOrObject.url : urlOrObject;
  let type: SearchResult["type"] = "file";
  if (isYouTube(url)) {
    type = "youtube";
  }
  const img = typeof urlOrObject === "object" ? urlOrObject.img : "";
  return {
    url,
    type,
    img,
    name: url,
    duration: 0,
  };
});
