import React, { type RefObject } from "react";
import { ActionIcon, HoverCard, TextInput } from "@mantine/core";
import {
  IconArrowBackUp,
  IconArrowDown,
  IconMoodSmile,
  IconMovie,
  IconPlayerPlay,
  IconSend,
  IconX,
} from "@tabler/icons-react";
import { EmojiPicker } from "./EmojiPicker";
import { Linkify } from "./Linkify";
import styles from "./Chat.module.css";
import { UserAvatar } from "../Avatar/Avatar";

import {
  formatTimestamp,
  getOrCreateClientId,
  isEmojiString,
} from "../../utils/utils";
import type { RoomCommands } from "../App/socketEvents";
import { parseShareUrl } from "../App/logic/media";
import {
  CSSTransition,
  SwitchTransition,
  TransitionGroup,
} from "react-transition-group";
import type { CSSTransitionProps } from "react-transition-group/CSSTransition";
import {
  describeChatCommand,
  isPersonlessLine,
} from "../App/player/formatChat";

const clientId = getOrCreateClientId();
const truncateReply = (input?: string, max = 30) =>
  input && input.length > max ? `${input.slice(0, max)}...` : input || "";

interface ChatProps {
  chat: ChatMessage[];
  nameMap: StringDict;
  pictureMap: StringDict;
  cmd: Pick<
    RoomCommands,
    "sendChat" | "sendChatV2" | "addReaction" | "removeReaction"
  >;
  scrollTimestamp: number;
  className?: string;
  getMediaDisplayName: (input?: string) => string;
  hide?: boolean;
  ref?: RefObject<Chat | null>;
}

export class Chat extends React.Component<ChatProps> {
  public state = {
    chatMsg: "",
    replyTo: undefined as
      { id: string; timestamp: string; msg?: string } | undefined,
    isNearBottom: true,
    isPickerOpen: false,
    reactionMenu: {
      isOpen: false,
      selectedMsgId: "",
      selectedMsgTimestamp: "",
      yPosition: 0,
      xPosition: 0,
    },
  };
  messagesRef = React.createRef<HTMLDivElement>();
  chatInputRef = React.createRef<HTMLInputElement>();
  // react-transition-group needs a nodeRef with React 19 (findDOMNode is gone)
  reactionMenuRef = React.createRef<HTMLDivElement>();

  async componentDidMount() {
    this.scrollToBottom();
    this.messagesRef.current?.addEventListener("scroll", this.onScroll);
  }

  componentWillUnmount() {
    this.messagesRef.current?.removeEventListener("scroll", this.onScroll);
  }

  componentDidUpdate(prevProps: ChatProps) {
    if (this.props.scrollTimestamp !== prevProps.scrollTimestamp) {
      if (prevProps.scrollTimestamp === 0 || this.state.isNearBottom) {
        this.scrollToBottom();
      }
    }
    if (this.props.hide !== prevProps.hide) {
      this.scrollToBottom();
    }
  }

  setReactionMenu = (
    isOpen: boolean,
    selectedMsgId?: string,
    selectedMsgTimestamp?: string,
    yPosition?: number,
    xPosition?: number,
  ) => {
    this.setState({
      reactionMenu: {
        isOpen,
        selectedMsgId,
        selectedMsgTimestamp,
        yPosition,
        xPosition,
      },
    });
  };

  handleReactionClick = (value: string, id?: string, timestamp?: string) => {
    const msg = this.props.chat.find(
      (m) => m.id === id && m.timestamp === timestamp,
    );
    const data = {
      value,
      msgId: id || this.state.reactionMenu.selectedMsgId,
      msgTimestamp: timestamp || this.state.reactionMenu.selectedMsgTimestamp,
    };
    if (msg?.reactions?.[value].includes(clientId)) {
      this.props.cmd.removeReaction(data);
    } else {
      this.props.cmd.addReaction(data);
    }
  };

  updateChatMsg = (e: any) => {
    this.setState({ chatMsg: e.target.value });
  };

  sendChatMsg = () => {
    if (!this.state.chatMsg) {
      return;
    }
    if (this.chatTooLong()) {
      return;
    }
    if (this.state.replyTo?.id && this.state.replyTo.timestamp) {
      const chatPayload: ChatPayload = {
        msg: this.state.chatMsg,
        replyToId: this.state.replyTo.id,
        replyToTimestamp: this.state.replyTo.timestamp,
      };
      this.props.cmd.sendChatV2(chatPayload);
      this.setState({ chatMsg: "", replyTo: undefined });
      return;
    }
    this.setState({ chatMsg: "", replyTo: undefined });
    this.props.cmd.sendChat(this.state.chatMsg);
  };

  setReplyTo = (id: string, timestamp: string, msg?: string) => {
    this.setState({ replyTo: { id, timestamp, msg } });
    this.chatInputRef.current?.focus();
  };

  clearReplyTo = () => {
    this.setState({ replyTo: undefined });
  };

  chatTooLong = () => {
    return Boolean(this.state.chatMsg?.length > 10000);
  };

  onScroll = () => {
    this.setState({ isNearBottom: this.isChatNearBottom() });
  };

  isChatNearBottom = () => {
    return (
      this.messagesRef.current &&
      this.messagesRef.current.scrollHeight -
        this.messagesRef.current.scrollTop -
        this.messagesRef.current.offsetHeight <
        50
    );
  };

  scrollToBottom = () => {
    if (this.messagesRef.current) {
      this.messagesRef.current.scrollTop =
        this.messagesRef.current.scrollHeight;
    }
  };

  /** Focuses the message input (e.g. from a keyboard shortcut). */
  focusInput = () => {
    this.chatInputRef.current?.focus();
  };

  formatMessage = (cmd: string, msg?: string): React.ReactNode | string => {
    if (cmd === "host" && !parseShareUrl(msg)) {
      return (
        <React.Fragment>
          {`changed the video to `}
          {this.props.getMediaDisplayName(msg)}
        </React.Fragment>
      );
    } else if (cmd === "playlistAdd") {
      return (
        <React.Fragment>
          {`added to the queue: `}
          {this.props.getMediaDisplayName(msg)}
        </React.Fragment>
      );
    } else if (cmd === "seek") {
      return `jumped to ${formatTimestamp(msg)}`;
    } else if (cmd === "play") {
      return `started the video at ${formatTimestamp(msg)}`;
    } else if (cmd === "pause") {
      return `paused the video at ${formatTimestamp(msg)}`;
    } else if (cmd === "playbackRate") {
      return `set the playback rate to ${msg === "0" ? "auto" : `${msg}x`}`;
    }
    // Newer commands (e.g. subtitleOffset) are described by the player's helper
    return describeChatCommand(cmd, msg, this.props.getMediaDisplayName) ?? cmd;
  };

  addEmoji = (emoji: any) => {
    this.setState({ chatMsg: this.state.chatMsg + emoji.native });
  };

  render() {
    const chat = this.props.chat;
    return (
      <div
        className={`${styles.chat} ${this.props.className ?? ""}`}
        style={this.props.hide ? { display: "none" } : undefined}
      >
        <div
          className={styles.chatContainer}
          ref={this.messagesRef}
          role="log"
          aria-label="Chat messages"
        >
          <div className={styles.chatList}>
            {chat.length === 0 && (
              <div className={styles.emptyChat}>No messages yet. Say hi!</div>
            )}
            {chat.map((msg, i) => (
              <ChatMessage
                key={msg.timestamp + msg.id}
                className={
                  msg.id === this.state.reactionMenu.selectedMsgId &&
                  msg.timestamp === this.state.reactionMenu.selectedMsgTimestamp
                    ? styles.selected
                    : ""
                }
                continued={isContinuation(chat[i - 1], msg)}
                message={msg}
                pictureMap={this.props.pictureMap}
                nameMap={this.props.nameMap}
                formatMessage={this.formatMessage}
                setReactionMenu={this.setReactionMenu}
                handleReactionClick={this.handleReactionClick}
                onReply={this.setReplyTo}
              />
            ))}
          </div>
          {!this.state.isNearBottom && (
            <button
              type="button"
              className={styles.jump}
              onClick={this.scrollToBottom}
            >
              <IconArrowDown size={14} aria-hidden="true" />
              Jump to latest
            </button>
          )}
        </div>
        {this.state.isPickerOpen && (
          <div className={styles.picker}>
            <EmojiPicker
              theme="dark"
              previewPosition="none"
              maxFrequentRows={1}
              onEmojiSelect={this.addEmoji}
              onClickOutside={() => this.setState({ isPickerOpen: false })}
            />
          </div>
        )}
        <CSSTransition
          nodeRef={this.reactionMenuRef}
          in={this.state.reactionMenu.isOpen}
          timeout={300}
          classNames={{
            enter: styles["reactionMenu-enter"],
            enterActive: styles["reactionMenu-enter-active"],
            exit: styles["reactionMenu-exit"],
            exitActive: styles["reactionMenu-exit-active"],
          }}
          unmountOnExit
        >
          <div
            ref={this.reactionMenuRef}
            className={styles.reactionPicker}
            style={{
              top: Math.max(
                8,
                Math.min(
                  this.state.reactionMenu.yPosition - 150,
                  window.innerHeight - 450,
                ),
              ),
              left: Math.max(8, this.state.reactionMenu.xPosition - 240),
            }}
          >
            <EmojiPicker
              theme="dark"
              previewPosition="none"
              maxFrequentRows={1}
              perLine={6}
              onClickOutside={() => this.setReactionMenu(false)}
              onEmojiSelect={(emoji: any) => {
                this.handleReactionClick(emoji.native);
                this.setReactionMenu(false);
              }}
            />
          </div>
        </CSSTransition>
        <div className={styles.composer}>
          {this.state.replyTo && (
            <div className={styles.replyComposer}>
              <div className={styles.replyComposerText}>
                Replying to{" "}
                <b>{this.props.nameMap[this.state.replyTo.id] || "Unknown"}</b>
                {this.state.replyTo.msg ? (
                  <div className={styles.replyComposerMsg}>
                    {this.state.replyTo.msg}
                  </div>
                ) : null}
              </div>
              <ActionIcon
                variant="subtle"
                color="gray"
                size={28}
                aria-label="Cancel reply"
                onClick={this.clearReplyTo}
              >
                <IconX size={16} />
              </ActionIcon>
            </div>
          )}
          <TextInput
            ref={this.chatInputRef}
            size="md"
            aria-label="Message"
            onKeyDown={(e: any) => e.key === "Enter" && this.sendChatMsg()}
            onChange={this.updateChatMsg}
            value={this.state.chatMsg}
            error={this.chatTooLong() ? "That message is too long." : undefined}
            placeholder="Message"
            classNames={{ input: styles.input }}
            rightSectionWidth={72}
            rightSectionPointerEvents="all"
            rightSection={
              <div className={styles.inputActions}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size={30}
                  aria-label="Insert emoji"
                  aria-expanded={this.state.isPickerOpen}
                  onClick={() => {
                    // Add a delay to prevent the click from triggering onClickOutside
                    const curr = this.state.isPickerOpen;
                    setTimeout(
                      () => this.setState({ isPickerOpen: !curr }),
                      100,
                    );
                  }}
                >
                  <IconMoodSmile size={18} />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color={this.state.chatMsg ? "copper" : "gray"}
                  size={30}
                  aria-label="Send message"
                  disabled={!this.state.chatMsg}
                  onClick={this.sendChatMsg}
                >
                  <IconSend size={18} />
                </ActionIcon>
              </div>
            }
          />
        </div>
      </div>
    );
  }
}

/** Messages from the same person within a few minutes are grouped under one name and avatar. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function isContinuation(
  prev: ChatMessage | undefined,
  msg: ChatMessage,
): boolean {
  if (!prev || prev.id !== msg.id || prev.cmd || msg.cmd) {
    return false;
  }
  if (prev.system || msg.system || msg.replyToUserId) {
    return false;
  }
  const gap = Date.parse(msg.timestamp) - Date.parse(prev.timestamp);
  return Number.isFinite(gap) && gap >= 0 && gap < GROUP_WINDOW_MS;
}

const formatTime = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const ChatMessage = ({
  message,
  nameMap,
  pictureMap,
  formatMessage,
  setReactionMenu,
  handleReactionClick,
  onReply,
  className,
  continued,
}: {
  message: ChatMessage;
  nameMap: StringDict;
  pictureMap: StringDict;
  formatMessage: (cmd: string, msg?: string) => React.ReactNode;
  setReactionMenu: (
    isOpen: boolean,
    selectedMsgId?: string,
    selectedMsgTimestamp?: string,
    yPosition?: number,
    xPosition?: number,
  ) => void;
  handleReactionClick: (value: string, id?: string, timestamp?: string) => void;
  onReply: (id: string, timestamp: string, msg?: string) => void;
  className: string;
  continued: boolean;
}) => {
  const { id, timestamp, cmd, msg, system, reactions, videoTS } = message;
  const spellFull = 5; // the number of people whose names should be written out in full in the reaction popup
  const imageMsg = renderImageString(msg);
  // Lines nobody caused (the queue advanced, the next episode started) have no person: no name, avatar or reactions
  const personless = isPersonlessLine(message);
  const name = system ? "System" : nameMap[id] || id;
  const time = formatTime(timestamp);

  const actions = (
    <div className={styles.commentMenu}>
      {id && id !== clientId && !cmd && (
        <ActionIcon
          variant="subtle"
          color="gray"
          size={26}
          aria-label={`Reply to ${name}`}
          onClick={() => onReply(id, timestamp, msg)}
        >
          <IconArrowBackUp size={16} />
        </ActionIcon>
      )}
      {!personless && (
        <ActionIcon
          variant="subtle"
          color="gray"
          size={26}
          aria-label="Add reaction"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setTimeout(() => {
              setReactionMenu(true, id, timestamp, rect.top, rect.right);
            }, 100);
          }}
        >
          <IconMoodSmile size={16} />
        </ActionIcon>
      )}
    </div>
  );

  const reactionChips = (
    <TransitionGroup className={styles.reactions} component="div">
      {Object.keys(reactions ?? []).map((key) =>
        reactions?.[key].length ? (
          <NodeTransition
            key={key}
            timeout={200}
            classNames={{
              enter: styles["reaction-enter"],
              enterActive: styles["reaction-enter-active"],
              exit: styles["reaction-exit"],
              exitActive: styles["reaction-exit-active"],
            }}
            unmountOnExit
          >
            {(nodeRef) => (
              <HoverCard>
                <HoverCard.Target>
                  <button
                    type="button"
                    ref={nodeRef}
                    className={`${styles.reactionContainer} ${
                      reactions[key].includes(clientId)
                        ? styles.highlighted
                        : ""
                    }`}
                    aria-pressed={reactions[key].includes(clientId)}
                    onClick={() =>
                      handleReactionClick(key, message.id, message.timestamp)
                    }
                  >
                    <span className={styles.reactionEmoji}>{key}</span>
                    <SwitchTransition>
                      <NodeTransition
                        key={key + "-" + reactions[key].length}
                        classNames={{
                          enter: styles["reactionCounter-enter"],
                          enterActive: styles["reactionCounter-enter-active"],
                          exit: styles["reactionCounter-exit"],
                          exitActive: styles["reactionCounter-exit-active"],
                        }}
                        endOnTransitionEnd
                        unmountOnExit
                      >
                        {(nodeRef) => (
                          <span
                            ref={nodeRef}
                            className={styles.reactionCounter}
                          >
                            {reactions[key].length}
                          </span>
                        )}
                      </NodeTransition>
                    </SwitchTransition>
                  </button>
                </HoverCard.Target>
                <HoverCard.Dropdown className={styles.tooltip}>
                  {`${reactions[key]
                    .slice(0, spellFull)
                    .map((id) => nameMap[id] || "Unknown")
                    .concat(
                      reactions[key].length > spellFull
                        ? [`${reactions[key].length - spellFull} more`]
                        : [],
                    )
                    .reduce(
                      (text, value, i, array) =>
                        text + (i < array.length - 1 ? ", " : " and ") + value,
                    )} reacted.`}
                </HoverCard.Dropdown>
              </HoverCard>
            )}
          </NodeTransition>
        ) : null,
      )}
    </TransitionGroup>
  );

  if (cmd) {
    return (
      <div className={`${styles.comment} ${styles.sys} ${className}`}>
        <span className={styles.sysIcon} aria-hidden="true">
          {cmd === "host" || cmd === "playlistAdd" || cmd === "nowPlaying" ? (
            <IconMovie size={14} />
          ) : (
            <IconPlayerPlay size={14} />
          )}
        </span>
        <div className={styles.sysBody}>
          {personless ? (
            formatMessage(cmd, msg)
          ) : (
            <>
              <b>{name}</b> {formatMessage(cmd, msg)}
            </>
          )}
          {reactionChips}
        </div>
        {actions}
      </div>
    );
  }

  return (
    <div
      className={`${styles.comment} ${continued ? styles.cont : ""} ${className} ${
        message.replyToUserId === clientId ? styles.replyMessage : ""
      }`}
    >
      {continued ? (
        <span className={styles.avatarSpacer} aria-hidden="true" />
      ) : (
        <UserAvatar id={id} name={name} picture={pictureMap[id]} size={28} />
      )}
      <div className={styles.body}>
        {!continued && (
          <div className={styles.meta}>
            <span className={styles.who}>{name}</span>
            <span
              className={styles.when}
              title={new Date(timestamp).toLocaleString()}
            >
              {time}
              {Boolean(videoTS) && ` · @ ${formatTimestamp(videoTS)}`}
            </span>
          </div>
        )}
        {message.replyToUserId && (
          <HoverCard withinPortal={false} openDelay={120}>
            <HoverCard.Target>
              <div className={styles.replyInfo}>
                {`↪ @${nameMap[message.replyToUserId] || "user"}: `}
                {truncateReply(message.replyToMsg, 30)}
              </div>
            </HoverCard.Target>
            <HoverCard.Dropdown className={styles.replyTooltip}>
              {message.replyToMsg || ""}
            </HoverCard.Dropdown>
          </HoverCard>
        )}
        <div
          className={`${styles.txt} ${isEmojiString(msg) ? styles.emoji : ""}`}
        >
          <Linkify text={msg} />
        </div>
        {imageMsg}
        {reactionChips}
      </div>
      {actions}
    </div>
  );
};

type NodeTransitionProps = Omit<
  CSSTransitionProps<HTMLElement>,
  "nodeRef" | "children" | "addEndListener"
> & {
  /** End the transition on the element's transitionend event instead of a timeout */
  endOnTransitionEnd?: boolean;
  children: (nodeRef: React.RefObject<any>) => React.ReactNode;
};

/**
 * CSSTransition with its own nodeRef: react-transition-group falls back to findDOMNode without one, which React 19
 * removed. TransitionGroup/SwitchTransition inject their props (in, onExited, ...) into this wrapper.
 */
const NodeTransition = ({
  children,
  endOnTransitionEnd,
  ...props
}: NodeTransitionProps) => {
  const nodeRef = React.useRef<HTMLElement>(null);
  const transitionProps = {
    ...props,
    nodeRef,
    ...(endOnTransitionEnd
      ? {
          addEndListener: (done: () => void) =>
            nodeRef.current?.addEventListener("transitionend", done, false),
        }
      : {}),
  } as CSSTransitionProps<HTMLElement>;
  return (
    <CSSTransition {...transitionProps}>{children(nodeRef)}</CSSTransition>
  );
};

export const renderImageString = (
  input: string | undefined,
): React.ReactNode | null => {
  // If a valid image string, return an image
  let regex =
    /^https?:\/\/.*\/.*\.(png|gif|webp|jpeg|jpg|heic|heif|jfif)\??.*$/gim;
  if (String(input)?.match(regex)) {
    return <img className={styles.image} src={input} alt="" loading="lazy" />;
  }
  return null;
};
