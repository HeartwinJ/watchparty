import React from "react";
import {
  formatTimestamp,
  getColorForStringHex,
  getDefaultPicture,
  softWhite,
} from "../../utils/utils";
import { IconScreenShare } from "@tabler/icons-react";

// Everyone in the room, with their current playback position
export const People = ({
  participants,
  pictureMap,
  nameMap,
  tsMap,
}: {
  participants: User[];
  pictureMap: StringDict;
  nameMap: StringDict;
  tsMap: NumberDict;
}) => {
  const size = participants.length > 2 ? 180 : 250;
  const contentStyle: React.CSSProperties = {
    height: size,
    width: size,
    objectFit: "cover",
    position: "relative",
  };
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: "4px",
        padding: "4px",
      }}
    >
      {participants.map((p) => {
        return (
          <div key={p.id} style={{ position: "relative" }}>
            {p.isScreenShare && (
              <IconScreenShare
                color={softWhite}
                style={{ position: "absolute", top: 0, left: 0, zIndex: 1 }}
              />
            )}
            <div
              style={{
                position: "absolute",
                bottom: "4px",
                left: "0px",
                width: "100%",
                color: softWhite,
                borderRadius: "4px",
                fontSize: "10px",
                fontWeight: 700,
                display: "flex",
                zIndex: 1,
              }}
            >
              <div
                title={nameMap[p.id] || p.id}
                style={{
                  backdropFilter: "brightness(80%)",
                  padding: "4px",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  display: "inline-block",
                }}
              >
                {nameMap[p.id] || p.id}
              </div>
              <div
                style={{
                  backdropFilter: "brightness(60%)",
                  padding: "4px",
                  flexGrow: 1,
                  display: "flex",
                  justifyContent: "center",
                }}
              >
                {formatTimestamp(tsMap[p.id] || 0)}
              </div>
            </div>
            <img
              style={contentStyle}
              src={
                pictureMap[p.id] ||
                getDefaultPicture(nameMap[p.id], getColorForStringHex(p.id))
              }
            />
          </div>
        );
      })}
    </div>
  );
};
