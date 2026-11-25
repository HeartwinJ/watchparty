import React from "react";
import {
  Modal,
  Button,
  Radio,
  Switch,
  Title,
  TextInput,
  ActionIcon,
  Divider,
} from "@mantine/core";
import { openFileSelector, serverPath } from "../../utils/utils";
import { apiFetch } from "../../utils/api";
import {
  IconDownload,
  IconSearch,
  IconUpload,
  IconX,
} from "@tabler/icons-react";

export class SubtitleModal extends React.Component<{
  closeModal: () => void;
  roomSubtitle: string | undefined;
  roomMedia: string;
  /** Sets the room subtitle (CMD:subtitle) */
  setRoomSubtitle: (url: string) => void;
  getMediaDisplayName: (input: string) => string;
  setSubtitleMode: (mode?: TextTrackMode) => void;
  getSubtitleMode: () => TextTrackMode;
}> {
  state = {
    loading: false,
    searchResults: [],
    titleQuery: this.props
      .getMediaDisplayName(this.props.roomMedia)
      .split("/")
      .slice(-1)[0],
  };

  uploadSubtitle = async () => {
    const files = await openFileSelector(".srt,.vtt");
    if (!files) {
      return;
    }
    const file = files[0];
    const reader = new FileReader();
    reader.addEventListener("load", async (event) => {
      const subData = event.target?.result;
      // Upload to server
      const resp = await apiFetch("/subtitle", {
        method: "POST",
        body: subData,
        headers: { "Content-Type": "text/plain" },
      });
      // Once URL obtained, make those the room subtitles
      const json = await resp.json();
      this.props.setRoomSubtitle(serverPath + "/subtitle/" + json.hash);
    });
    reader.readAsText(file);
  };

  searchSubtitles = async () => {
    this.setState({ loading: true });
    const resp = await apiFetch(
      "/searchSubtitles?title=" + encodeURIComponent(this.state.titleQuery),
    );
    const json = await resp.json();
    this.setState({ searchResults: json });
    this.setState({ loading: false });
  };
  render() {
    const { closeModal } = this.props;
    return (
      <Modal
        opened
        onClose={closeModal}
        centered
        title="Subtitles"
        size="50rem"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <Switch
            checked={this.props.getSubtitleMode() === "showing"}
            label="Toggle subtitles for myself"
            onClick={() => {
              this.props.setSubtitleMode();
            }}
          />
          <Divider my="lg" />
          <Title order={6}>Room subtitles</Title>
          <div style={{ display: "flex", gap: "4px", flexDirection: "column" }}>
            <TextInput
              placeholder="Subtitle URL"
              value={this.props.roomSubtitle}
              onChange={(e) => this.props.setRoomSubtitle(e.target.value)}
              rightSection={
                <ActionIcon
                  color="red"
                  onClick={() => {
                    this.props.setRoomSubtitle("");
                  }}
                >
                  <IconX />
                </ActionIcon>
              }
            />
            <Button
              color="violet"
              onClick={() => this.uploadSubtitle()}
              leftSection={<IconUpload />}
            >
              Upload (.srt / .vtt)
            </Button>
            <Divider my="lg" />
            <Title order={6}>OpenSubtitles</Title>
            <TextInput
              value={this.state.titleQuery}
              onChange={(e) => this.setState({ titleQuery: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && this.searchSubtitles()}
              rightSectionWidth={85}
              rightSection={
                <Button
                  size="compact-xs"
                  loading={this.state.loading}
                  color="green"
                  onClick={this.searchSubtitles}
                  leftSection={<IconSearch size={14} />}
                >
                  By title
                </Button>
              }
            />
            <div
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              {this.state.searchResults.map(
                (result: {
                  id: string;
                  type: string;
                  attributes: Record<string, any>;
                }) => (
                  <div key={result.id} style={{ display: "flex", gap: "4px" }}>
                    <ActionIcon
                      onClick={async (e) => {
                        const resp = await apiFetch(
                          "/downloadSubtitles?file_id=" +
                            result.attributes.files[0]?.file_id,
                        );
                        const data = await resp.json();
                        this.props.setRoomSubtitle(serverPath + data.link);
                      }}
                    >
                      <IconDownload />
                    </ActionIcon>
                    <span>{result.attributes.release}</span>
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      </Modal>
    );
  }
}
