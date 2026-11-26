import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntroSkipNoticeView } from "./IntroSkipNotice";

afterEach(cleanup);

describe("IntroSkipNoticeView", () => {
  it("says how much was skipped and offers to watch from the start", () => {
    const onWatchFromStart = vi.fn();
    render(
      <MantineProvider env="test">
        <IntroSkipNoticeView seconds={90} onWatchFromStart={onWatchFromStart} />
      </MantineProvider>,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Skipped intro (1:30)",
    );
    fireEvent.click(screen.getByRole("button", { name: "Watch from start" }));
    expect(onWatchFromStart).toHaveBeenCalledTimes(1);
  });
});
