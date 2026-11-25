import React from "react";
import {
  IconBrandYoutubeFilled,
  IconFile,
  IconLink,
  IconList,
  IconMessageFilled,
  type IconProps,
  IconRefresh,
  IconScreenShare,
} from "@tabler/icons-react";
import { NewRoomButton } from "../TopBar/TopBar";
import styles from "./Home.module.css";

export const Home = () => {
  return (
    <div>
      <div className={styles.container}>
        <Hero
          heroText={"Watch videos together with friends anywhere."}
          action={
            <div style={{ marginTop: "8px", width: "300px" }}>
              <NewRoomButton size="xl" />
            </div>
          }
        />
        <div className={styles.featureSection}>
          <Feature
            Icon={IconBrandYoutubeFilled}
            title={`YouTube`}
            text="Watch videos together from YouTube."
          />
          <Feature
            Icon={IconLink}
            title={`URL`}
            text="Paste in a video URL (MP4, HLS, DASH) for everyone to watch from."
          />
          <Feature
            Icon={IconScreenShare}
            title={`Screensharing`}
            text="Share a browser tab or your desktop."
          />
          <Feature
            Icon={IconFile}
            title={`File`}
            text="Stream your own file from your device."
          />
        </div>
        <div className={styles.featureSection}>
          <Feature
            Icon={IconRefresh}
            title="Synchronized Play"
            text="Starts, stops, and seeks are synchronized to everyone."
          />
          <Feature
            Icon={IconMessageFilled}
            title="Chat"
            text="Chat and react with others in your room."
          />
          <Feature
            Icon={IconList}
            title="Playlists"
            text="Set up a list of videos to play next."
          />
        </div>
      </div>
    </div>
  );
};

const Feature = ({
  Icon,
  text,
  title,
}: {
  Icon: React.ForwardRefExoticComponent<IconProps>;
  text: string;
  title: string;
}) => {
  return (
    <div
      style={{
        display: "flex",
        flex: "1 1 0px",
        flexDirection: "column",
        alignItems: "center",
        padding: "10px",
        minWidth: "180px",
      }}
    >
      <Icon size={80} />
      <h4 className={styles.featureTitle}>{title}</h4>
      <div className={styles.featureText}>{text}</div>
    </div>
  );
};

export const Hero = ({
  heroText,
  subText,
  action,
}: {
  heroText?: string;
  subText?: string;
  action?: React.ReactNode;
}) => {
  return (
    <div className={styles.hero}>
      <div className={styles.heroInner}>
        <div style={{ padding: "30px", flex: "1 1 0" }}>
          <div className={styles.heroText}>{heroText}</div>
          {subText && <div className={styles.subText}>{subText}</div>}
          {action}
        </div>
      </div>
    </div>
  );
};
