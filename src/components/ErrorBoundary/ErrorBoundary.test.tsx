import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

const Boom = (): never => {
  throw new Error("boom");
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    render(
      <MantineProvider env="test">
        <ErrorBoundary>
          <p>fine</p>
        </ErrorBoundary>
      </MantineProvider>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
  });

  it("shows a reload card instead of a blank page when a child throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      reload,
    });
    render(
      <MantineProvider env="test">
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </MantineProvider>,
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(console.error).toHaveBeenCalledWith(
      "Page crashed",
      expect.any(Error),
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalled();
  });
});
