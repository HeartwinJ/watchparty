import React from "react";
import { Alert, Loader, Menu, Overlay, Title } from "@mantine/core";
import io, { Socket } from "socket.io-client";
import {
  isMobile,
  serverPath,
  testAutoplay,
  openFileSelector,
  getOrCreateClientId,
  getOrCreateSessionId,
  calculateMedian,
  isYouTube,
  isHttp,
  isHls,
  isScreenShare,
  isFileShare,
  isDirectVideoUrl,
  isDash,
  VIDEO_MAX_HEIGHT_CSS,
  softWhite,
} from "../../utils/utils";
import { apiFetch, notifyUnauthorized } from "../../utils/api";
import { getIceServers } from "../../utils/iceServers";
import { generateName } from "../../utils/generateName";
import { Chat } from "../Chat/Chat";
import { TopBar } from "../TopBar/TopBar";
import { People } from "../People/People";
import { getCurrentSettings } from "../Settings/LocalSettings";
import { ComboBox } from "../ComboBox/ComboBox";
import { SearchComponent } from "../SearchComponent/SearchComponent";
import { Controls } from "../Controls/Controls";
import { SettingsModal } from "../Settings/SettingsModal";
import { ErrorModal } from "../Modal/ErrorModal";
import { ScreenShareModal } from "../Modal/ScreenShareModal";
import { FileShareModal } from "../Modal/FileShareModal";
import {
  ClientTranscoder,
  isClientTranscodeSupported,
  type AudioTrackInfo,
} from "../../utils/clientTranscode";
import { SubtitleModal } from "../Modal/SubtitleModal";
import { HTML } from "./HTML";
import { YouTube } from "./YouTube";
import styles from "./App.module.css";
import config from "../../config";
import ChatVideoCard from "../ChatVideoCard/ChatVideoCard";
import {
  ActionIcon,
  Badge,
  TextInput,
  Button,
  Switch,
  Tooltip,
} from "@mantine/core";
import {
  IconChevronLeft,
  IconChevronRight,
  IconFile,
  IconList,
  IconScreenShare,
  IconSettings,
  IconUser,
  IconUsersGroup,
  IconVolume,
  IconX,
} from "@tabler/icons-react";
import { InviteButton } from "../InviteButton/InviteButton";
import type Hls from "hls.js";
import { type MediaPlayerClass } from "dashjs";

declare global {
  interface Window {
    onYouTubeIframeAPIReady: any;
    YT: YT.JsApi;
    watchparty: {
      hls?: Hls;
      dash?: MediaPlayerClass;
    };
  }
}

window.watchparty = {};

const clientId = getOrCreateClientId();

interface AppProps {
  urlRoomId: string;
}

interface AppState {
  state: "starting" | "connected";
  roomMedia: string;
  roomSubtitle: string;
  roomPaused: boolean;
  roomLoop: boolean;
  participants: User[];
  rosterUpdateTS: Number;
  chat: ChatMessage[];
  playlist: PlaylistVideo[];
  tsMap: NumberDict;
  nameMap: StringDict;
  pictureMap: StringDict;
  myName: string;
  loading: boolean;
  scrollTimestamp: number;
  unreadCount: number;
  fullScreen: boolean;
  controlsTimestamp: number;
  watchOptions: SearchResult[];
  isAutoPlayable: boolean;
  overlayMsg: string;
  settings: Settings;
  nonPlayableMedia: boolean;
  currentTab: string;
  isScreenShareModalOpen: boolean;
  isFileShareModalOpen: boolean;
  isSubtitleModalOpen: boolean;
  roomId: string;
  errorMessage: string;
  successMessage: string;
  warningMessage: string;
  showChatColumn: boolean;
  showPeopleColumn: boolean;
  roomPlaybackRate: number;
  isLiveStream: boolean;
  settingsModalOpen: boolean;
  convertProgress: number | undefined;
  convertEnabled: boolean;
  // Audio tracks of the file being converted on this device, and which one is playing
  audioTracks: AudioTrackInfo[] | undefined;
  audioTrackId: number | undefined;
}

export class App extends React.Component<AppProps, AppState> {
  state: AppState = {
    state: "starting",
    roomMedia: "",
    roomPaused: false,
    roomSubtitle: "",
    roomLoop: false,
    participants: [],
    rosterUpdateTS: Date.now(),
    chat: [],
    playlist: [],
    tsMap: {},
    nameMap: {},
    pictureMap: {},
    myName: window.localStorage.getItem("watchparty-username") ?? "",
    loading: true,
    scrollTimestamp: 0,
    unreadCount: 0,
    fullScreen: false,
    controlsTimestamp: 0,
    watchOptions: [],
    isAutoPlayable: true,
    overlayMsg: "",
    settings: {},
    nonPlayableMedia: false,
    currentTab:
      new URLSearchParams(window.location.search).get("tab") ?? "chat",
    isScreenShareModalOpen: false,
    isFileShareModalOpen: false,
    isSubtitleModalOpen: false,
    roomId: "",
    errorMessage: "",
    successMessage: "",
    warningMessage: "",
    showChatColumn: isMobile()
      ? true
      : Boolean(
          Number(
            window.localStorage.getItem("watchparty-showchatcolumn") ?? "1",
          ),
        ),
    showPeopleColumn: false,
    // Boolean(
    //       Number(
    //         window.localStorage.getItem('watchparty-showpeoplecolumn') ?? '0',
    //       ),
    //     ),
    roomPlaybackRate: 0,
    isLiveStream: false,
    settingsModalOpen: false,
    convertProgress: undefined,
    convertEnabled: window.localStorage.getItem("watchparty-convert") === "1",
    audioTracks: undefined,
    audioTrackId: undefined,
  };
  socket: Socket = null!;
  ytDebounce = true;
  localStreamToPublish?: MediaStream;
  isLocalStreamAFile = false;
  transcoder?: ClientTranscoder;
  publisherConns: PCDict = {};
  consumerConn?: RTCPeerConnection;
  heartbeat: number | undefined = undefined;
  tsUpdater: number | undefined = undefined;
  unmounted = false;
  YouTubeInterface: YouTube = new YouTube(null);
  HTMLInterface: HTML = new HTML("leftVideo");
  Player = () => {
    if (this.usingYoutube()) {
      return this.YouTubeInterface;
    } else {
      return this.HTMLInterface;
    }
  };

  chatRef = React.createRef<Chat>();

  async componentDidMount() {
    document.onfullscreenchange = this.onFullScreenChange;
    document.onkeydown = this.onKeydown;

    // Send heartbeat to the server
    this.heartbeat = window.setInterval(
      () => {
        apiFetch("/ping");
      },
      10 * 60 * 1000,
    );

    const canAutoplay = await testAutoplay();
    this.setState({ isAutoPlayable: canAutoplay });
    if (this.unmounted) {
      return;
    }
    this.loadSettings();
    this.loadYouTube();
    this.join("/" + this.props.urlRoomId);
  }

  componentWillUnmount() {
    // e.g. the session expired and the login screen replaced the app
    this.unmounted = true;
    document.onfullscreenchange = null;
    document.onkeydown = null;
    window.clearInterval(this.heartbeat);
    window.clearInterval(this.tsUpdater);
    if (this.socket) {
      this.stopPublishingLocalStream();
      this.socket.disconnect();
    }
  }

  join = async (roomId: string) => {
    this.setState({ roomId });
    const socket = io(serverPath + roomId, {
      transports: ["websocket"],
      // Send the session cookie (the dev client runs on a different port than the server)
      withCredentials: true,
      query: {
        clientId,
        roomId: roomId.slice(1),
      },
      auth: {
        sessionId: getOrCreateSessionId(),
      },
    });
    this.socket = socket;
    socket.on("connect", async () => {
      this.setState({
        state: "connected",
        overlayMsg: "",
        errorMessage: "",
        successMessage: "",
        warningMessage: "",
      });
      // Use the name in our state, generate one if empty
      this.updateName(this.state.myName || (await generateName()));
    });
    socket.on("connect_error", (err: any) => {
      console.error(err);
      if (err.message === "unauthorized") {
        // Our session expired or was revoked: go back to the login screen
        socket.disconnect();
        notifyUnauthorized();
      } else if (err.message === "Invalid namespace") {
        this.setState({ overlayMsg: "Couldn't load this room." });
      } else if (err.message === "password") {
        this.setState({
          overlayMsg: "This room has a password, which isn't supported.",
        });
      } else {
        this.setState({ overlayMsg: err?.message ?? "An error occurred" });
      }
    });
    socket.on("disconnect", (reason) => {
      if (reason === "io server disconnect") {
        // the disconnection was initiated by the server, you need to reconnect manually
        this.setState({ overlayMsg: "Disconnected from server." });
      } else {
        // else the socket will automatically try to reconnect
        // Use the alert pill since it's less disruptive
        this.setState({ warningMessage: "Reconnecting..." });
      }
    });
    socket.on("errorMessage", (err: string) => {
      this.setState({ errorMessage: err });
      setTimeout(() => {
        this.setState({ errorMessage: "" });
      }, 3000);
    });
    socket.on("successMessage", (success: string) => {
      this.setState({ successMessage: success });
      setTimeout(() => {
        this.setState({ successMessage: "" });
      }, 3000);
    });
    socket.on("kicked", () => {
      window.location.assign("/");
    });
    socket.on("REC:play", () => {
      this.localPlay();
    });
    socket.on("REC:pause", () => {
      this.localPause();
    });
    socket.on("REC:seek", (data: number) => {
      this.localSeek(data);
    });
    socket.on("REC:playbackRate", (data: number) => {
      this.setState({ roomPlaybackRate: data });
      if (data > 0) {
        this.Player().setPlaybackRate(data);
      }
    });
    socket.on("REC:subtitle", (data: string) => {
      this.setState({ roomSubtitle: data }, () => {
        this.Player().loadSubtitles(data);
      });
    });
    socket.on("REC:loop", (data: boolean) => {
      this.setState({ roomLoop: data });
    });
    socket.on("REC:host", async (data: HostState) => {
      let currentMedia = data.video || "";
      if (this.playingScreenShare() && !isScreenShare(currentMedia)) {
        this.stopPublishingLocalStream();
      }
      if (this.playingFileShare() && !isFileShare(currentMedia)) {
        this.stopPublishingLocalStream();
      }
      if (this.playingScreenShare() && isScreenShare(currentMedia)) {
        // Ignore, it's probably a reconnection
        return;
      }
      if (this.playingFileShare() && isFileShare(currentMedia)) {
        // Ignore, it's probably a reconnection
        return;
      }
      this.setState(
        {
          roomMedia: currentMedia,
          roomPaused: data.paused,
          roomSubtitle: data.subtitle,
          roomLoop: data.loop,
          roomPlaybackRate: data.playbackRate,
          loading: Boolean(data.video),
          nonPlayableMedia: false,
          isLiveStream: false,
        },
        async () => {
          const leftVideo = this.HTMLInterface.getVideoEl();

          // Stop all players
          // Unless the user is sharing a file, because we play it in leftVideo and capture stream
          if (!this.isLocalStreamAFile) {
            this.stopConvert();
            this.HTMLInterface.pauseVideo();
          }
          this.YouTubeInterface.stopVideo();

          if (!this.isLocalStreamAFile) {
            this.Player().clearState();
          }
          if (data.subtitle) {
            this.Player().loadSubtitles(data.subtitle);
          }
          if (data.playbackRate) {
            this.Player().setPlaybackRate(data.playbackRate);
          }

          if (this.playingScreenShare() || this.playingFileShare()) {
            console.log(
              "exiting REC:host since we are using webRTC (fileshare or screenshare). Check setupRTCConnections()",
            );
            this.setLoadingFalse();
            return;
          }
          if (this.usingYoutube() && !this.YouTubeInterface.isReady()) {
            console.log(
              "YT player not ready, onReady callback will retry when it is",
            );
            return;
          }
          const src = data.video;
          const time = data.videoTS;
          if (isDash(src)) {
            if (!window.watchparty.dash) {
              const Dash = await import("dashjs");
              window.watchparty.dash = Dash.MediaPlayer().create();
              window.watchparty.dash.on("streamInitialized", (_e: any) => {
                // for a live stream:
                // html.currenttime is time since stream start
                // html.duration is infinite
                // html.seekable ends at the live edge (see getDuration)
                // player.duration is the size of the seekable range, not a position
                const isLiveStream = Boolean(
                  window.watchparty.dash?.isDynamic(),
                );
                console.log("DASH stream initialized: isLive %s", isLiveStream);
                this.setState({
                  isLiveStream,
                });
              });
            }
            window.watchparty.dash.initialize(leftVideo, src);
          } else if (isHls(src) && window.MediaSource) {
            // Prefer using hls.js if MediaSource Extensions are supported
            // otherwise fallback to native HLS support using video tag (i.e. iPhones)
            if (!window.watchparty.hls) {
              const Hls = (await import("hls.js")).default;
              window.watchparty.hls = new Hls();
              window.watchparty.hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
                const isLiveStream = data.details.live;
                this.setState({ isLiveStream });
                console.log("HLS level loaded: isLive %s", isLiveStream);
              });
            }
            window.watchparty.hls.loadSource(src);
            window.watchparty.hls.attachMedia(leftVideo);
          }
          // else if (isMpegTs(src)) {
          //   const mpegts = (await import('mpegts.js')).default;
          //   let player = mpegts.createPlayer({
          //     type: 'mse', // could also be mpegts, m2ts, flv
          //     // isLive: true,
          //     url: src,
          //   });
          //   player.attachMediaElement(leftVideo);
          //   player.load();
          //   player.play();
          // }
          else if (
            this.state.convertEnabled &&
            isClientTranscodeSupported() &&
            isDirectVideoUrl(src)
          ) {
            await this.convertAndPlay(src, time);
          } else {
            await this.Player().setSrcAndTime(src, time);
          }
          // Start this video
          if (!data.paused) {
            this.localPlay();
          }
          // Do right before playing
          leftVideo?.addEventListener(
            "canplay",
            () => {
              this.setLoadingFalse();
              let ts = undefined;
              // Hls and Dash reset position back to 0 so set it back here
              if (isHls(src) || isDash(src) || this.state.isLiveStream) {
                ts = time;
              }
              // Resync to leader since the loading might have taken some time
              this.localSeek(ts);
              if (data.playbackRate) {
                // Set playback rate again since it might have been lost
                console.log("setting playback rate again", data.playbackRate);
                this.Player().setPlaybackRate(data.playbackRate);
              }
            },
            { once: true },
          );
        },
      );
    });
    socket.on("REC:chat", (data: ChatMessage) => {
      if (
        !getCurrentSettings().disableChatSound &&
        !data.system &&
        ((document.visibilityState && document.visibilityState !== "visible") ||
          this.state.currentTab !== "chat")
      ) {
        new Audio("/clearly.mp3").play();
      }
      this.state.chat.push(data);
      if (this.state.chat.length > 100) {
        this.state.chat.shift();
      }
      this.setState({
        chat: this.state.chat,
        scrollTimestamp: Date.now(),
        unreadCount:
          this.state.currentTab === "chat"
            ? this.state.unreadCount
            : this.state.unreadCount + 1,
      });
    });
    socket.on("REC:addReaction", (data: Reaction) => {
      const { chat } = this.state;
      const msgIndex = chat.findIndex(
        (m) => m.id === data.msgId && m.timestamp === data.msgTimestamp,
      );
      if (msgIndex === -1) {
        return;
      }
      const msg = chat[msgIndex];
      msg.reactions = msg.reactions || {};
      msg.reactions[data.value] = msg.reactions[data.value] || [];
      msg.reactions[data.value].push(data.user);
      this.setState({ chat }, () => {
        // if we add a reaction to the last message we need to scroll down
        // or else the reaction icon might be hidden
        if (
          msgIndex === chat.length - 1 &&
          this.chatRef.current?.state.isNearBottom
        ) {
          this.chatRef.current?.scrollToBottom();
        }
      });
    });
    socket.on("REC:removeReaction", (data: Reaction) => {
      const { chat } = this.state;
      const msg = chat.find(
        (m) => m.id === data.msgId && m.timestamp === data.msgTimestamp,
      );
      if (!msg || !msg.reactions?.[data.value]) {
        return;
      }
      msg.reactions[data.value] = msg.reactions[data.value].filter(
        (id) => id !== data.user,
      );
      this.setState({ chat });
    });
    socket.on("REC:tsMap", (data: NumberDict) => {
      this.setState({ tsMap: data }, () => {
        // Dynamic playback rate based on timestamps
        // Disable for sharing types where the users can have different timestamps
        // e.g. screenshare, fileshare, .m3u8 HLS streams
        // Also not necessary for WebRTC sharing since it should be close to realtime
        if (
          !this.state.roomPaused &&
          !this.state.isLiveStream &&
          this.hasDuration() &&
          this.state.roomPlaybackRate === 0
        ) {
          const leader = this.getLeaderTime();
          const delta = leader - data[clientId];
          // Set leader pbr to 1
          let pbr = 1;
          // Add .01 pbr for each 100ms delay
          if (delta > 0.5) {
            pbr += Number((delta / 10).toFixed(2));
            pbr = Math.min(pbr, 1.1);
          }
          // console.log(delta, pbr);
          if (this.Player().getPlaybackRate() !== pbr) {
            this.Player().setPlaybackRate(pbr);
          }
        }
        if (this.state.roomSubtitle) {
          const sharer = this.state.participants.find((p) => p.isScreenShare);
          if (sharer && sharer.id !== clientId) {
            // Sync only if someone is sharing and it's not us
            const sharerTime = this.state.tsMap[sharer.id];
            this.Player().syncSubtitles(sharerTime);
          }
        }
      });
    });
    socket.on("REC:nameMap", (data: StringDict) => {
      this.setState({ nameMap: data });
    });
    socket.on("REC:pictureMap", (data: StringDict) => {
      this.setState({ pictureMap: data });
    });
    socket.on("roster", (data: User[]) => {
      this.setState({ participants: data, rosterUpdateTS: Date.now() }, () => {
        this.setupRTCConnections();
      });
    });
    socket.on("chatinit", (data: ChatMessage[]) => {
      this.setState({ chat: data, scrollTimestamp: Date.now() });
    });
    socket.on("playlist", (data: PlaylistVideo[]) => {
      this.setState({ playlist: data });
    });
    socket.on(
      "signalSS",
      async (data: {
        msg: { ice: any; sdp: any };
        from: string;
        sharer: boolean;
      }) => {
        config.NODE_ENV === "development" && console.log(data);
        // setupRTCConnections waits for the ICE servers before creating connections, so wait for them too
        // (it awaited first, so its connections exist by the time this continues)
        await getIceServers();
        // Handle messages received from signaling server
        const msg = data.msg;
        const from = data.from;
        // Determine whether the message came from the sharer or the sharee
        const pc = data.sharer ? this.consumerConn : this.publisherConns[from];
        if (!pc) {
          console.warn("signalSS: no connection for", from);
          return;
        }
        if (msg.ice !== undefined) {
          pc.addIceCandidate(new RTCIceCandidate(msg.ice));
        } else if (msg.sdp && msg.sdp.type === "offer") {
          // console.log('offer');
          // TODO Currently ios/Safari cannot handle this property, so remove it from the offer
          const _sdp = msg.sdp.sdp
            .split("\n")
            .filter((line: string) => {
              return line.trim() !== "a=extmap-allow-mixed";
            })
            .join("\n");
          msg.sdp.sdp = _sdp;
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await pc.createAnswer();
          // Allow stereo audio
          answer.sdp = answer.sdp?.replace(
            "useinbandfec=1",
            "useinbandfec=1; stereo=1; maxaveragebitrate=510000",
          );
          // console.log(answer.sdp);
          // Allow multichannel audio if Chromium
          //@ts-expect-error
          const isChromium = Boolean(window.chrome);
          if (isChromium) {
            answer.sdp = answer.sdp
              ?.replace("opus/48000/2", "multiopus/48000/6")
              .replace(
                "useinbandfec=1",
                "channel_mapping=0,4,1,2,3,5; num_streams=4; coupled_streams=2;maxaveragebitrate=510000;minptime=10;useinbandfec=1",
              );
          }
          await pc.setLocalDescription(answer);
          this.sendSignalSS(from, { sdp: pc.localDescription }, !data.sharer);
        } else if (msg.sdp && msg.sdp.type === "answer") {
          pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
      },
    );
    window.clearInterval(this.tsUpdater);
    this.tsUpdater = window.setInterval(() => {
      if (this.state.roomMedia) {
        const toSend = this.getRoomTSToSet(this.Player().getCurrentTime());
        this.socket.emit("CMD:ts", toSend);
      }
    }, 1000);
  };

  loadSettings = async () => {
    // Load settings from localstorage
    let settings = getCurrentSettings();
    this.setState({ settings });
  };

  loadYouTube = () => {
    // This code loads the IFrame Player API code asynchronously.
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.body.append(tag);
    window.onYouTubeIframeAPIReady = () => {
      // Note: this fails silently if the element is not available
      const ytPlayer = new window.YT.Player("leftYt", {
        events: {
          onReady: () => {
            console.log("yt onReady");
            this.YouTubeInterface = new YouTube(ytPlayer);
            this.setState({ loading: false });
            // We might have failed to play YT originally, ask for the current video again
            if (this.usingYoutube()) {
              console.log("requesting host data again after ytReady");
              this.socket.emit("CMD:askHost");
            }
          },
          onStateChange: (e) => {
            if (
              this.usingYoutube() &&
              e.data === window.YT?.PlayerState?.CUED
            ) {
              this.setState({ loading: false });
            }
            if (
              this.usingYoutube() &&
              e.data === window.YT?.PlayerState?.ENDED
            ) {
              console.log(e.data, e.target.getVideoUrl());
              this.onVideoEnded(e.target.getVideoUrl());
            }
            if (
              this.ytDebounce &&
              ((e.data === window.YT?.PlayerState?.PLAYING &&
                this.state.roomPaused) ||
                (e.data === window.YT?.PlayerState?.PAUSED &&
                  !this.state.roomPaused))
            ) {
              this.ytDebounce = false;
              if (e.data === window.YT?.PlayerState?.PLAYING) {
                this.socket.emit("CMD:play");
                this.localPlay();
              } else {
                this.socket.emit("CMD:pause");
                this.localPause();
              }
              window.setTimeout(() => (this.ytDebounce = true), 500);
            }
          },
        },
      });
    };
  };

  showError = (message: string) => {
    this.setState({ errorMessage: message });
    setTimeout(() => {
      this.setState({ errorMessage: "" });
    }, 3000);
  };

  // Stops client-side conversion (if running) and releases its resources
  stopConvert = () => {
    this.transcoder?.stop();
    this.transcoder = undefined;
    if (
      this.state.convertProgress !== undefined ||
      this.state.audioTracks !== undefined
    ) {
      this.setState({
        convertProgress: undefined,
        audioTracks: undefined,
        audioTrackId: undefined,
      });
    }
  };

  // Switches the audio track of the file being converted (e.g. another language). Local to this device for links,
  // for a shared file it changes what everyone hears since viewers receive the converted stream.
  localSetAudioTrack = async (id: number) => {
    try {
      await this.transcoder?.selectAudioTrack(id);
    } catch (err) {
      console.error(err);
      this.showError(
        err instanceof Error ? err.message : "Unable to change audio track",
      );
    }
  };

  createTranscoder = (
    source: File | string,
    video: HTMLMediaElement,
    startTime: number,
    onError: (err: Error) => void,
  ) => {
    const transcoder = new ClientTranscoder({
      source,
      video,
      startTime,
      onProgress: (fraction) => {
        if (this.transcoder === transcoder) {
          this.setState({ convertProgress: fraction });
        }
      },
      onAudioTracks: (audioTracks, audioTrackId) => {
        if (this.transcoder === transcoder) {
          this.setState({ audioTracks, audioTrackId });
        }
      },
      onError,
    });
    this.transcoder = transcoder;
    this.setState({ convertProgress: 0 });
    return transcoder;
  };

  // Plays a media URL in this browser after converting it with WebCodecs (see clientTranscode.ts), for formats the
  // browser can't play natively. Only affects this client: the room's media URL is unchanged.
  convertAndPlay = async (src: string, time: number) => {
    const video = this.HTMLInterface.getVideoEl();
    const transcoder = this.createTranscoder(src, video, time, (err) => {
      // Conversion failed while playing. Carry on without it.
      this.showError(
        `Conversion failed: ${err.message}. Playing without conversion.`,
      );
      this.stopConvert();
      this.Player().setSrcAndTime(src, video.currentTime);
    });
    try {
      await transcoder.start();
    } catch (err) {
      console.error(err);
      if (this.transcoder === transcoder) {
        // Typically a CORS restriction or a link that isn't a media file
        this.stopConvert();
        const reason =
          err instanceof Error ? err.message : "Unable to convert this video";
        this.showError(`${reason}. Playing without conversion.`);
        await this.Player().setSrcAndTime(src, time);
      }
    }
  };

  // Shares a file from this device. With convert, the file is first transcoded in this browser using WebCodecs
  // into a format browsers can play (see clientTranscode.ts), then shared the same way as an unconverted file.
  startFileShare = async (options?: { convert?: boolean }) => {
    const files = await openFileSelector();
    if (!files) {
      return;
    }
    const file = files[0];
    if (options?.convert && !isClientTranscodeSupported()) {
      this.showError("Your browser doesn't support converting videos");
      return;
    }
    this.stopConvert();
    this.Player().clearState();
    const leftVideo = this.HTMLInterface.getVideoEl();
    if (options?.convert) {
      const transcoder = this.createTranscoder(file, leftVideo, 0, (err) => {
        // Conversion failed mid-share
        this.showError(`Conversion failed: ${err.message}`);
        this.stopPublishingLocalStream();
      });
      try {
        await transcoder.start();
      } catch (err) {
        console.error(err);
        if (this.transcoder === transcoder) {
          this.stopConvert();
          this.showError(
            err instanceof Error ? err.message : "Unable to convert this file",
          );
        }
        return;
      }
      if (this.transcoder !== transcoder) {
        // Cancelled while starting up
        return;
      }
    } else {
      leftVideo.src = URL.createObjectURL(file);
    }
    leftVideo.play();
    //@ts-expect-error
    this.localStreamToPublish = leftVideo?.captureStream();
    this.isLocalStreamAFile = true;
    if (this.localStreamToPublish) {
      // Warm the ICE server cache before viewers start connecting
      await getIceServers();
      this.socket.emit("CMD:joinScreenShare", { file: true });
    }
  };

  startScreenShare = async () => {
    if (navigator.mediaDevices.getDisplayMedia) {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        //@ts-expect-error
        video: { height: 720, logicalSurface: true },
        audio: {
          autoGainControl: false,
          channelCount: 2,
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 48000,
          sampleSize: 16,
        },
      });
      this.localStreamToPublish = stream;
      this.isLocalStreamAFile = false;
      // Warm the ICE server cache before viewers start connecting
      await getIceServers();
      this.socket.emit("CMD:joinScreenShare", { file: false });
    }
  };

  stopPublishingLocalStream = async () => {
    this.stopConvert();
    if (this.localStreamToPublish) {
      this.socket.emit("CMD:leaveScreenShare");
      // We don't actually need to unmute if it's a fileshare but this is fine
      this.localSetMute(false);
    }
    this.localStreamToPublish &&
      this.localStreamToPublish.getTracks().forEach((track) => {
        track.stop();
      });
    this.localStreamToPublish = undefined;
    if (this.consumerConn) {
      this.consumerConn.close();
      this.consumerConn = undefined;
    }
    Object.values(this.publisherConns).forEach((pc) => {
      pc.close();
    });
    this.publisherConns = {};
    this.isLocalStreamAFile = false;
  };

  setupRTCConnections = async () => {
    if (!this.playingScreenShare() && !this.playingFileShare()) {
      return;
    }
    // Everything below runs synchronously after this, so concurrent calls can't create duplicate connections
    const iceServers = await getIceServers();
    if (!this.playingScreenShare() && !this.playingFileShare()) {
      return;
    }
    const sharer = this.state.participants.find((p) => p.isScreenShare);
    const selfId = getOrCreateClientId();
    const localTrack = this.localStreamToPublish?.getVideoTracks()[0];
    if (localTrack && !localTrack.onended) {
      // Stop sharing if the local stream stops
      localTrack.onended = () => this.stopPublishingLocalStream();
    }

    // We're the sharer, create a connection to each other member
    if (sharer?.id === selfId) {
      // Delete and close any connections that aren't in the current member list (maybe someone disconnected)
      // This allows them to rejoin later
      const clientIds = new Set(this.state.participants.map((p) => p.id));
      Object.entries(this.publisherConns).forEach(([key, value]) => {
        if (!clientIds.has(key)) {
          value.close();
          delete this.publisherConns[key];
        }
      });

      this.state.participants.forEach((user) => {
        const id = user.id;
        if (id === selfId && this.isLocalStreamAFile) {
          // Don't set up a connection to ourselves if sharing file
          return;
        }
        if (!this.publisherConns[id]) {
          // Set up the RTCPeerConnection for sharing media to each member
          const pc = new RTCPeerConnection({ iceServers });
          this.publisherConns[id] = pc;
          this.localStreamToPublish?.getTracks().forEach((track) => {
            if (this.localStreamToPublish != null) {
              pc.addTrack(track, this.localStreamToPublish);
            }
          });
          pc.onicecandidate = (event) => {
            // We generated an ICE candidate, send it to peer
            if (event.candidate) {
              this.sendSignalSS(id, { ice: event.candidate }, true);
            }
          };
          pc.onnegotiationneeded = async () => {
            // Start connection for peer's video
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.sendSignalSS(id, { sdp: pc.localDescription }, true);
          };
        }
      });
    }
    // We're a watcher, establish connection to sharer
    // If screensharing, sharer also does this
    // If filesharing, sharer does not do this since we use leftVideo
    if (sharer && !this.consumerConn && !this.isLocalStreamAFile) {
      const pc = new RTCPeerConnection({ iceServers });
      this.consumerConn = pc;
      pc.onicecandidate = (event) => {
        // We generated an ICE candidate, send it to sharer
        if (event.candidate) {
          this.sendSignalSS(sharer.id, { ice: event.candidate });
        }
      };
      pc.ontrack = (event: RTCTrackEvent) => {
        // Mount the stream from sharer
        // console.log(stream);
        const leftVideo = this.HTMLInterface.getVideoEl();
        if (leftVideo) {
          leftVideo.src = "";
          leftVideo.srcObject = event.streams[0];
          this.localPlay();
        }
      };
    }
  };

  sendSignalSS = async (to: string, data: any, sharer?: boolean) => {
    // console.log('sendSS', to, data);
    this.socket.emit("signalSS", { to, msg: data, sharer });
  };

  usingYoutube = () => {
    return isYouTube(this.state.roomMedia);
  };

  usingNative = () => {
    // Anything that uses HTML Video (e.g. not YouTube, Vimeo, or other embedded JS player)
    return !this.usingYoutube();
  };

  hasDuration = () => {
    // Youtube, link, etc. Has a defined runtime (not WebRTC)
    return isHttp(this.state.roomMedia);
  };

  playingScreenShare = () => {
    return isScreenShare(this.state.roomMedia);
  };

  playingFileShare = () => {
    return isFileShare(this.state.roomMedia);
  };

  isPauseDisabled = () => {
    return this.playingScreenShare();
  };

  // The duration of the media. For a live stream this is the live edge on the same timeline as the current time,
  // which is what hls.js reports as the duration. dash.js leaves it at Infinity, so use the end of the seekable range.
  // The controls and seeking math below depend on it being finite.
  getDuration = () => {
    const duration = this.Player().getDuration();
    if (this.state.isLiveStream && duration === Infinity) {
      const seekable = this.Player().getVideoEl()?.seekable;
      if (seekable?.length) {
        return seekable.end(seekable.length - 1);
      }
    }
    return duration;
  };

  localSeek = (customTime?: number) => {
    // Jump to the leader's position, or a custom one
    let target = customTime ?? this.getLeaderTime();
    // For live this is the offset from the leading edge (negative)
    if (this.state.isLiveStream) {
      target = this.getDuration() + (customTime ?? 0);
    }
    if (target >= 0 && target < Infinity) {
      console.log("syncing self to leader or custom:", target);
      this.Player().seekVideo(target);
    }
  };

  localPlay = async () => {
    if (!this.state.roomMedia) {
      return;
    }
    const canAutoplay = this.state.isAutoPlayable || (await testAutoplay());
    this.setState(
      { roomPaused: false, isAutoPlayable: canAutoplay },
      async () => {
        if (
          !this.state.isAutoPlayable ||
          (this.localStreamToPublish && !this.isLocalStreamAFile)
        ) {
          console.log("auto-muting to allow autoplay or screenshare host");
          this.localSetMute(true);
        } else {
          this.localSetMute(false);
        }
        try {
          await this.Player().playVideo();
        } catch (e: any) {
          console.warn(e, e.name);
          if (e.name === "NotSupportedError" && this.usingNative()) {
            this.setState({ loading: false, nonPlayableMedia: true });
          }
        }
      },
    );
  };

  localPause = () => {
    this.setState({ roomPaused: true }, async () => {
      this.Player().pauseVideo();
    });
  };

  localSetMute = (muted: boolean) => {
    this.Player().setMute(muted);
    this.refreshControls();
  };

  localSetVolume = (volume: number) => {
    this.Player().setVolume(volume);
    this.refreshControls();
  };

  localSubtitleModal = () => {
    // Native player uses subtitle modal.
    if (this.usingNative()) {
      this.setState({ isSubtitleModalOpen: true });
    }
  };

  roomSetPlaybackRate = (rate: number) => {
    // emit an event to the server
    this.socket.emit("CMD:playbackRate", rate);
  };

  roomSetLoop = (loop: boolean) => {
    this.socket.emit("CMD:loop", loop);
  };

  roomTogglePlay = () => {
    if (this.isPauseDisabled()) {
      return;
    }
    const shouldPlay = this.Player().shouldPlay();
    if (shouldPlay) {
      this.socket.emit("CMD:play");
      this.localPlay();
    } else {
      this.socket.emit("CMD:pause");
      this.localPause();
    }
  };

  roomSeek = (time: number) => {
    let target = time;
    target = Math.max(target, 0);
    this.Player().seekVideo(target);
    const toSend = this.getRoomTSToSet(target);
    this.socket.emit("CMD:seek", toSend);
  };

  getRoomTSToSet = (time: number) => {
    let target = time;
    // In live case, can't just send video time because clients may have different durations
    // Take the passed time and compute the offset from the end time (negative)
    // Each client should use this value to compute the time to set when starting playback
    if (this.state.isLiveStream) {
      target = time - this.getDuration();
    }
    // Otherwise just return the time
    return target;
  };

  onFullScreenChange = () => {
    this.setState({ fullScreen: Boolean(document.fullscreenElement) });
    setTimeout(() => this.chatRef.current?.scrollToBottom(), 100);
  };

  onKeydown = (e: any) => {
    if (!document.activeElement || document.activeElement.tagName === "BODY") {
      if (e.key === " ") {
        e.preventDefault();
        this.roomTogglePlay();
      } else if (e.key === "ArrowRight") {
        this.roomSeek(this.Player().getCurrentTime() + 10);
      } else if (e.key === "ArrowLeft") {
        this.roomSeek(this.Player().getCurrentTime() - 10);
      } else if (e.key === "t") {
        this.localFullScreen(false);
      } else if (e.key === "f") {
        this.localFullScreen(true);
      } else if (e.key === "m") {
        this.localToggleMute();
      }
    }
  };

  localFullScreen = async (bVideoOnly: boolean) => {
    // Default: fullscreen the body (theater mode)
    let container = document.body as HTMLElement;
    if (bVideoOnly || isMobile()) {
      // fullscreen just the video
      container = this.Player().getVideoEl();
    }
    if (
      !container.requestFullscreen &&
      //@ts-expect-error
      container.webkitEnterFullScreen
    ) {
      // e.g. iPhone doesn't allow requestFullscreen
      //@ts-expect-error
      container.webkitEnterFullscreen();
      return;
    }
    if (!document.fullscreenElement) {
      // not currently in fullscreen
      await container.requestFullscreen();
    } else {
      // e.g. switching from video fullscreen to theater mode
      const bChangeElements = document.fullscreenElement !== container;
      await document.exitFullscreen();
      if (bChangeElements) {
        await container.requestFullscreen();
      }
    }
  };

  localToggleMute = () => {
    this.localSetMute(!this.Player().isMuted());
  };

  roomSetMedia = (value: string) => {
    this.socket.emit("CMD:host", value);
  };

  setConvertEnabled = (convertEnabled: boolean) => {
    window.localStorage.setItem(
      "watchparty-convert",
      convertEnabled ? "1" : "0",
    );
    this.setState({ convertEnabled });
    window.location.reload();
  };

  roomPlaylistPlay = (index: number) => {
    this.roomSetMedia(this.state.playlist[index]?.url);
    this.roomPlaylistDelete(index);
  };

  roomPlaylistAdd = (value: string) => {
    this.socket.emit("CMD:playlistAdd", value);
  };

  roomPlaylistMove = (index: number, toIndex: number) => {
    this.socket.emit("CMD:playlistMove", { index, toIndex });
  };

  roomPlaylistDelete = (index: number) => {
    this.socket.emit("CMD:playlistDelete", index);
  };

  updateName = (name: string) => {
    this.setState({ myName: name });
    this.socket.emit("CMD:name", name);
    window.localStorage.setItem("watchparty-username", name);
  };

  getMediaDisplayName = (input?: string) => {
    if (!input) {
      return "";
    }
    // Show the whole URL for youtube
    if (this.usingYoutube()) {
      return input;
    }
    if (input.startsWith("screenshare://")) {
      const sharer = this.state.participants.find((user) => user.isScreenShare);
      return this.state.nameMap[sharer?.id ?? ""] + "'s screen";
    }
    if (input.startsWith("fileshare://")) {
      const sharer = this.state.participants.find((user) => user.isScreenShare);
      return this.state.nameMap[sharer?.id ?? ""] + "'s file";
    }
    if (input.includes("/proxy")) {
      const urlParsed = new URLSearchParams(input);
      const displayName = urlParsed.get("displayName");
      if (displayName) {
        return displayName;
      }
    }
    return input;
  };

  setLoadingFalse = () => {
    this.setState({ loading: false });
  };

  getLeaderTime = () => {
    if (this.state.participants.length > 2) {
      return calculateMedian(Object.values(this.state.tsMap));
    }
    return Math.max(...Object.values(this.state.tsMap));
  };

  onVideoEnded = (url: string) => {
    if (this.state.loading) {
      return;
    }
    this.localPause();
    // check if looping is on, if so set time back to 0 and restart
    if (this.state.roomLoop) {
      this.localSeek(0);
      this.localPlay();
      return;
    }
    if (this.state.playlist.length) {
      // Pass the url of the video at the time this video was started
      this.socket.emit("CMD:playlistNext", url);
      return;
    }
    // Play next fileIndex
    const re = /&fileIndex=(\d+)$/;
    const match = re.exec(this.state.roomMedia);
    if (match) {
      const fileIndex = match[1];
      const nextNum = Number(fileIndex) + 1;
      const nextUrl = this.state.roomMedia.replace(
        /&fileIndex=(\d+)$/,
        `&fileIndex=${nextNum}`,
      );
      this.roomSetMedia(nextUrl);
    }
  };

  refreshControls = () => {
    this.setState({ controlsTimestamp: Date.now() });
  };

  setSettingsModalOpen = (settingsModalOpen: boolean) => {
    this.setState({ settingsModalOpen });
  };

  render() {
    const sharer = this.state.participants.find((p) => p.isScreenShare);
    const playlist = this.state.playlist;
    const controls = (
      <Controls
        key={this.state.controlsTimestamp}
        video={this.state.roomMedia}
        paused={this.state.roomPaused}
        roomPlaybackRate={this.state.roomPlaybackRate}
        isLiveStream={this.state.isLiveStream}
        muted={this.Player().isMuted()}
        volume={this.Player().getVolume()}
        subtitled={this.Player().isSubtitled()}
        currentTime={this.Player().getCurrentTime()}
        duration={this.getDuration()}
        leaderTime={this.hasDuration() ? this.getLeaderTime() : undefined}
        isPauseDisabled={this.isPauseDisabled()}
        playbackRate={this.Player().getPlaybackRate()}
        isYouTube={this.usingYoutube()}
        timeRanges={this.Player().getTimeRanges()}
        loop={this.state.roomLoop}
        roomSetLoop={this.roomSetLoop}
        roomTogglePlay={this.roomTogglePlay}
        roomSeek={this.roomSeek}
        roomSetPlaybackRate={this.roomSetPlaybackRate}
        localFullScreen={this.localFullScreen}
        localToggleMute={this.localToggleMute}
        localSubtitleModal={this.localSubtitleModal}
        localSetVolume={this.localSetVolume}
        localSeek={this.localSeek}
        localSetSubtitleMode={this.Player().setSubtitleMode}
        roomPlaylistPlay={this.roomPlaylistPlay}
        playlist={this.state.playlist}
        audioTracks={this.state.audioTracks}
        audioTrackId={this.state.audioTrackId}
        localSetAudioTrack={this.localSetAudioTrack}
      />
    );
    return (
      <React.Fragment>
        {this.state.isScreenShareModalOpen && (
          <ScreenShareModal
            closeModal={() => this.setState({ isScreenShareModalOpen: false })}
            startScreenShare={this.startScreenShare}
          />
        )}
        {this.state.isFileShareModalOpen && (
          <FileShareModal
            closeModal={() => this.setState({ isFileShareModalOpen: false })}
            startFileShare={this.startFileShare}
          />
        )}
        {this.state.isSubtitleModalOpen && (
          <SubtitleModal
            closeModal={() => this.setState({ isSubtitleModalOpen: false })}
            socket={this.socket}
            roomSubtitle={this.state.roomSubtitle}
            roomMedia={this.state.roomMedia}
            getMediaDisplayName={this.getMediaDisplayName}
            setSubtitleMode={this.Player().setSubtitleMode}
            getSubtitleMode={this.Player().getSubtitleMode}
          />
        )}
        {this.state.state === "starting" && (
          <Overlay className={styles.flexCenter}>
            <Title order={2}>Loading...</Title>
          </Overlay>
        )}
        {this.state.overlayMsg && <ErrorModal error={this.state.overlayMsg} />}
        <SettingsModal
          modalOpen={this.state.settingsModalOpen}
          setModalOpen={this.setSettingsModalOpen}
        />
        {this.state.errorMessage && (
          <Alert
            title="Error"
            color="red"
            style={{
              position: "fixed",
              bottom: "10px",
              right: "10px",
              zIndex: 1000,
            }}
          >
            {this.state.errorMessage}
          </Alert>
        )}
        {this.state.successMessage && (
          <Alert
            title="Success"
            color="green"
            style={{
              position: "fixed",
              bottom: "10px",
              right: "10px",
              zIndex: 1000,
            }}
          >
            {this.state.successMessage}
          </Alert>
        )}
        {this.state.warningMessage && (
          <Alert
            color="yellow"
            // header={this.state.warningMessage}
            style={{
              position: "fixed",
              top: "10px",
              left: "50%",
              transform: "translate(-50%, 0)",
              zIndex: 1000,
            }}
          >
            {this.state.warningMessage}
          </Alert>
        )}
        {!this.state.fullScreen && <TopBar />}
        {
          <div
            className={styles.mobileStack}
            style={{ margin: "0 8px", display: "flex", columnGap: "32px" }}
          >
            <div
              className={
                (this.state.fullScreen
                  ? styles.fullHeightColumnFullscreen
                  : styles.fullHeightColumn) +
                " " +
                styles.leftColumn
              }
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  height: "100%",
                  position: "relative",
                  gap: "4px",
                }}
              >
                {!this.state.fullScreen && (
                  <React.Fragment>
                    <div className={styles.mobileStack}>
                      <ComboBox
                        roomSetMedia={this.roomSetMedia}
                        playlistAdd={this.roomPlaylistAdd}
                        roomMedia={this.state.roomMedia}
                        getMediaDisplayName={this.getMediaDisplayName}
                      />
                    </div>
                    <div className={styles.mobileStack}>
                      {this.localStreamToPublish && (
                        <Button
                          color="red"
                          onClick={this.stopPublishingLocalStream}
                          leftSection={<IconX />}
                        >
                          Stop Share
                        </Button>
                      )}
                      {!this.localStreamToPublish && !sharer && (
                        <Button
                          className={styles.shareButton}
                          color="blue"
                          onClick={() => {
                            this.setState({
                              isScreenShareModalOpen: true,
                            });
                          }}
                          leftSection={<IconScreenShare />}
                        >
                          Screenshare
                        </Button>
                      )}
                      {!this.localStreamToPublish && !sharer && (
                        <Button
                          className={styles.shareButton}
                          color="violet"
                          onClick={() => {
                            this.setState({
                              isFileShareModalOpen: true,
                            });
                          }}
                          leftSection={<IconFile />}
                        >
                          File
                        </Button>
                      )}
                      {false && (
                        <SearchComponent
                          setMedia={this.roomSetMedia}
                          playlistAdd={this.roomPlaylistAdd}
                        />
                      )}
                      <Menu>
                        <Menu.Target>
                          <Button
                            color="grey"
                            leftSection={<IconList />}
                            rightSection={
                              <Badge circle>{playlist.length}</Badge>
                            }
                            className={styles.shareButton}
                          >
                            Playlist
                          </Button>
                        </Menu.Target>
                        <Menu.Dropdown
                          style={{
                            overflowY:
                              playlist.length > 0 ? "scroll" : undefined,
                            maxHeight: 400,
                            maxWidth: isMobile() ? 400 : 600,
                          }}
                        >
                          {playlist.length === 0 && (
                            <Menu.Item disabled>
                              There are no items in the playlist.
                            </Menu.Item>
                          )}
                          {playlist.map(
                            (item: PlaylistVideo, index: number) => {
                              if (Boolean(item.img)) {
                                item.type = "youtube";
                              }
                              return (
                                <Menu.Item key={index}>
                                  <ChatVideoCard
                                    video={item}
                                    index={index}
                                    controls
                                    onPlay={this.roomPlaylistPlay}
                                    onPlayNext={(index) => {
                                      this.roomPlaylistMove(index, 0);
                                    }}
                                    onRemove={(index) => {
                                      this.roomPlaylistDelete(index);
                                    }}
                                  />
                                </Menu.Item>
                              );
                            },
                          )}
                        </Menu.Dropdown>
                      </Menu>
                      {isClientTranscodeSupported() && (
                        <Tooltip
                          multiline
                          w={280}
                          refProp="rootRef"
                          label="Use CPU/GPU to convert content before playback (only with links, use if video or audio doesn't play, or to choose between audio tracks)"
                        >
                          <Switch
                            label="Convert"
                            checked={this.state.convertEnabled}
                            onChange={(e) =>
                              this.setConvertEnabled(e.currentTarget.checked)
                            }
                            style={{ flexShrink: 0, alignSelf: "center" }}
                          />
                        </Tooltip>
                      )}
                    </div>
                  </React.Fragment>
                )}
                <div style={{ flexGrow: 1, position: "relative" }}>
                  <div className={styles.playerContainer}>
                    {!this.state.isAutoPlayable && this.state.roomMedia && (
                      <Overlay className={styles.flexCenter}>
                        <Button
                          onClick={() => {
                            this.setState({ isAutoPlayable: true });
                            this.localSetMute(false);
                            this.localSetVolume(1);
                          }}
                          leftSection={<IconVolume />}
                          size="xl"
                        >
                          Unmute
                        </Button>
                      </Overlay>
                    )}
                    {(this.state.loading ||
                      !this.state.roomMedia ||
                      this.state.nonPlayableMedia) &&
                      !this.state.isLiveStream && (
                        <div
                          id="loader"
                          className={`${styles.videoContent} ${styles.flexCenter}`}
                        >
                          {this.state.loading && (
                            <div
                              className={styles.flexCenter}
                              style={{
                                flexDirection: "column",
                              }}
                            >
                              <Loader />
                            </div>
                          )}
                          {!this.state.loading && !this.state.roomMedia && (
                            <Alert
                              color="yellow"
                              title="You're not watching anything!"
                            >
                              Pick something to watch above.
                            </Alert>
                          )}
                          {!this.state.loading &&
                            this.state.nonPlayableMedia && (
                              <Alert
                                color="red"
                                title="It doesn't look like this is a media file!"
                              >
                                The link needs to point to a video file or
                                stream, not a web page.
                              </Alert>
                            )}
                        </div>
                      )}
                    <iframe
                      style={{
                        display:
                          this.usingYoutube() && !this.state.loading
                            ? "block"
                            : "none",
                      }}
                      title="YouTube"
                      id="leftYt"
                      className={styles.videoContent}
                      allowFullScreen
                      frameBorder="0"
                      allow="autoplay; encrypted-media"
                      src="https://www.youtube.com/embed/?enablejsapi=1&controls=0&rel=0"
                    />
                    <video
                      style={{
                        display:
                          (this.usingNative() && !this.state.loading) ||
                          this.state.fullScreen
                            ? "block"
                            : "none",
                        width: "100%",
                        maxHeight: VIDEO_MAX_HEIGHT_CSS,
                      }}
                      id="leftVideo"
                      onEnded={(e) => this.onVideoEnded(e.currentTarget.src)}
                      playsInline
                      onClick={this.roomTogglePlay}
                    ></video>
                    <div
                      style={{
                        color: softWhite,
                        fontWeight: 400,
                        fontSize: 10,
                        lineHeight: "8px",
                        position: "absolute",
                        bottom: 0,
                        right: 0,
                        zIndex: 1,
                      }}
                    >
                      {[
                        this.state.convertProgress !== undefined &&
                          (this.state.convertProgress * 100).toFixed(1) +
                            "% converted",
                      ]
                        .filter(Boolean)
                        .join(" - ")}
                    </div>
                  </div>
                </div>
                {this.state.roomMedia && controls}
                {!isMobile() && (
                  <div className={styles.expandButton}>
                    <ActionIcon
                      onClick={() => {
                        const newVal = !this.state.showChatColumn;
                        this.setState({
                          showChatColumn: newVal,
                        });
                        window.localStorage.setItem(
                          "watchparty-showchatcolumn",
                          Number(newVal).toString(),
                        );
                      }}
                    >
                      {this.state.showChatColumn ? (
                        <IconChevronRight size={16} />
                      ) : (
                        <IconChevronLeft size={16} />
                      )}
                    </ActionIcon>
                  </div>
                )}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                position: "relative",
                width: this.state.showChatColumn ? 400 : 0,
                maxWidth: 400,
                overflow: "hidden",
                gap: "4px",
              }}
              className={`${
                (this.state.fullScreen
                  ? styles.fullHeightColumnFullscreen
                  : styles.fullHeightColumn) +
                " " +
                styles.rightColumn
              }`}
            >
              <div style={{ display: "flex", width: "100%", gap: "4px" }}>
                <TextInput
                  // description="Name"
                  style={{
                    visibility: this.state.showChatColumn
                      ? undefined
                      : "hidden",
                    flexGrow: 1,
                  }}
                  value={this.state.myName}
                  onChange={(e) => {
                    this.updateName(e.target.value);
                  }}
                  onFocus={(e) => e.target.select()}
                  leftSection={<IconUser />}
                  rightSectionWidth={70}
                  rightSection={
                    <Button
                      size="compact-xs"
                      onClick={async () =>
                        this.updateName(await generateName())
                      }
                    >
                      Random
                    </Button>
                  }
                />
                <InviteButton />
              </div>
              <div style={{ display: "flex", gap: "4px" }}>
                <Button
                  color="grey"
                  onClick={() =>
                    this.setState({
                      showPeopleColumn: !this.state.showPeopleColumn,
                    })
                  }
                  fullWidth
                  leftSection={<IconUsersGroup />}
                  rightSection={
                    <Badge circle>{this.state.participants.length}</Badge>
                  }
                >
                  People
                </Button>
                <Button
                  color="grey"
                  title="Settings"
                  fullWidth
                  onClick={() => {
                    this.setSettingsModalOpen(true);
                  }}
                  leftSection={<IconSettings />}
                >
                  Settings
                </Button>
              </div>
              {this.state.state === "connected" && (
                <div
                  style={{
                    position: "absolute",
                    background: "rgba(10, 10, 10, 0.6)",
                    zIndex: 200,
                    left: 0,
                    top: 76,
                    height: this.state.showPeopleColumn
                      ? "calc(100% - 120px)"
                      : "0%",
                    width: "100%",
                    overflowY: "auto",
                    // visibility: this.state.showPeopleColumn ? 'visible' : 'hidden',
                    transition: "height ease-out 0.5s",
                  }}
                >
                  <People
                    participants={this.state.participants}
                    nameMap={this.state.nameMap}
                    pictureMap={this.state.pictureMap}
                    tsMap={this.state.tsMap}
                  />
                </div>
              )}
              <Chat
                chat={this.state.chat}
                nameMap={this.state.nameMap}
                pictureMap={this.state.pictureMap}
                socket={this.socket}
                scrollTimestamp={this.state.scrollTimestamp}
                getMediaDisplayName={this.getMediaDisplayName}
                ref={this.chatRef}
                hide={!this.state.showChatColumn}
              />
            </div>
          </div>
        }
      </React.Fragment>
    );
  }
}
