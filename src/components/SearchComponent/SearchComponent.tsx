import React from "react";
import { debounce, getYouTubeResults } from "../../utils/utils";
import { Loader, Select } from "@mantine/core";
import { YouTubeSearchResult } from "../SearchResult/SearchResult";
import { IconBrandYoutubeFilled } from "@tabler/icons-react";

interface SearchComponentProps {
  setMedia: (value: string) => void;
  playlistAdd: (value: string) => void;
  disabled?: boolean;
}

// YouTube search box
export class SearchComponent extends React.Component<SearchComponentProps> {
  state = {
    results: [] as SearchResult[],
    loading: false,
    lastResultTimestamp: Date.now(),
    inputMedia: undefined,
  };

  doSearch = async (value?: string) => {
    this.setState({ inputMedia: value || "" });
    this.setState({ loading: true });
    let query = value || "";
    let timestamp = Date.now();
    const results = await getYouTubeResults(query);
    if (timestamp > this.state.lastResultTimestamp) {
      this.setState({
        loading: false,
        results,
        lastResultTimestamp: timestamp,
      });
    }
  };

  render() {
    const renderOption = ({
      option,
    }: {
      option: { value: string; label: string };
    }) => {
      const result = this.state.results.find((r) => r.url === option.value);
      if (!result) {
        return <div>{option.label}</div>;
      }
      return (
        <YouTubeSearchResult
          key={result.url}
          {...result}
          setMedia={this.props.setMedia}
          playlistAdd={this.props.playlistAdd}
        />
      );
    };
    return (
      <Select
        maxDropdownHeight={400}
        searchable
        leftSection={
          this.state.loading ? <Loader size="sm" /> : <IconBrandYoutubeFilled />
        }
        placeholder="Search YouTube"
        onSearchChange={debounce(this.doSearch, 500)}
        value={this.state.inputMedia}
        onFocus={() => this.doSearch()}
        disabled={this.props.disabled}
        data={this.state.results.map((r) => r.url)}
        renderOption={renderOption}
        comboboxProps={{ width: 400, position: "bottom-start" }}
        filter={({ options }) => options}
      />
    );
  }
}
