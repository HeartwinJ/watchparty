// toast(): message, tone, replacing by id, one or several action buttons that close the toast.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "./toast";

beforeEach(() => {
  render(
    <MantineProvider env="test">
      <Notifications />
    </MantineProvider>,
  );
});
afterEach(() => {
  act(() => notifications.clean());
  cleanup();
});

describe("toast", () => {
  it("shows a plain message with a title", async () => {
    act(() => {
      toast("Saved", { title: "Room", tone: "success" });
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.getByText("Room")).toBeTruthy();
  });

  it("replaces a toast with the same id", async () => {
    act(() => {
      toast("First", { id: "same" });
    });
    await screen.findByText("First");
    act(() => {
      toast("Second", { id: "same" });
    });
    await screen.findByText("Second");
    await waitFor(() => expect(screen.queryByText("First")).toBeNull());
  });

  it("an action runs and closes the toast", async () => {
    const onClick = vi.fn();
    act(() => {
      toast("Can't play", {
        tone: "warning",
        action: { label: "Retry", onClick },
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(onClick).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Can't play")).toBeNull());
  });

  it("several actions are all shown", async () => {
    const a = vi.fn();
    const b = vi.fn();
    act(() => {
      toast("Pick one", {
        tone: "danger",
        actions: [
          { label: "A", onClick: a },
          { label: "B", onClick: b },
        ],
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "B" }));
    expect(b).toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
  });
});
