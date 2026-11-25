import React from "react";
import { Button } from "@mantine/core";
import { decodeEntities } from "../../utils/utils";
import { IconBrandYoutubeFilled } from "@tabler/icons-react";

export const YouTubeSearchResult = (
  props: SearchResult & {
    setMedia: (value: string) => void;
    playlistAdd: (value: string) => void;
  },
) => {
  const result = props;
  const setMedia = props.setMedia;
  return (
    <div
      onClick={(e) => {
        setMedia(result.url);
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <img style={{ height: "50px" }} src={result.img} alt={result.name} />
        <IconBrandYoutubeFilled color="red" />
        <div>{decodeEntities(result.name)}</div>
        <div style={{ marginLeft: "auto" }}>
          <Button
            onClick={(e) => {
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              props.playlistAdd(result.url);
            }}
          >
            Add To Playlist
          </Button>
        </div>
      </div>
    </div>
  );
};
