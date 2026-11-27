// The share modals: what each button calls and the convert option.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";

const transcodeSupported = vi.fn(() => true);
vi.mock("../../utils/clientTranscode", () => ({
  isClientTranscodeSupported: () => transcodeSupported(),
}));
const apiFetch = vi.fn();
vi.mock("../../utils/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/api")>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
const openFileSelector = vi.fn();
vi.mock("../../utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/utils")>()),
  openFileSelector: (...a: unknown[]) => openFileSelector(...a),
}));
const toastMock = vi.fn();
vi.mock("../App/ui/toast", () => ({
  toast: (...a: unknown[]) => toastMock(...a),
}));

const { ScreenShareModal } = await import("./ScreenShareModal");
const { FileShareModal } = await import("./FileShareModal");

const wrap = (ui: React.ReactElement) =>
  render(<MantineProvider env="test">{ui}</MantineProvider>);

beforeEach(() => {
  apiFetch.mockReset();
  openFileSelector.mockReset();
  toastMock.mockReset();
  transcodeSupported.mockReturnValue(true);
});
afterEach(() => cleanup());

describe("ScreenShareModal", () => {
  it("starts sharing and closes, or just closes on Cancel", () => {
    const closeModal = vi.fn();
    const startScreenShare = vi.fn();
    wrap(
      <ScreenShareModal
        closeModal={closeModal}
        startScreenShare={startScreenShare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(startScreenShare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    expect(startScreenShare).toHaveBeenCalled();
    expect(closeModal).toHaveBeenCalledTimes(2);
  });
});

describe("FileShareModal", () => {
  it("shares without converting by default, or with it when checked", () => {
    const closeModal = vi.fn();
    const startFileShare = vi.fn();
    wrap(
      <FileShareModal
        closeModal={closeModal}
        startFileShare={startFileShare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    expect(startFileShare).toHaveBeenLastCalledWith({ convert: false });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Convert on this device/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    expect(startFileShare).toHaveBeenLastCalledWith({ convert: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closeModal).toHaveBeenCalledTimes(3);
  });

  it("disables converting without WebCodecs", () => {
    transcodeSupported.mockReturnValue(false);
    wrap(<FileShareModal closeModal={vi.fn()} startFileShare={vi.fn()} />);
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Convert on this device/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/doesn't support WebCodecs/)).toBeTruthy();
  });
});
