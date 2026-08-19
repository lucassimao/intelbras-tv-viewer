import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/i18n";
import { RenameDialog, Viewer } from "../src/App";
import { CAMERAS, STREAM_PROFILES } from "../src/config/cameras";

describe("viewer fullscreen surface", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests fullscreen on the viewer container and keeps the same video node", () => {
    const camera = CAMERAS.find((candidate) => candidate.id === "cam-124")!;
    render(
      <Viewer
        camera={camera}
        profile={STREAM_PROFILES[0]}
        customNames={{}}
        onSelectProfile={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    const viewer = screen.getByRole("region", { name: /transmissão ao vivo/i });
    const video = screen.getByLabelText(/vídeo de/i);
    const viewerRequestFullscreen = vi.fn().mockResolvedValue(undefined);
    const videoRequestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(viewer, "requestFullscreen", { value: viewerRequestFullscreen });
    Object.defineProperty(video, "requestFullscreen", { value: videoRequestFullscreen });

    fireEvent.click(screen.getByRole("button", { name: /tela cheia/i }));

    expect(viewerRequestFullscreen).toHaveBeenCalledTimes(1);
    expect(videoRequestFullscreen).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/vídeo de/i)).toBe(video);
  });

  it("uses the app fullscreen fallback when the browser rejects fullscreen", async () => {
    const camera = CAMERAS.find((candidate) => candidate.id === "cam-124")!;
    render(
      <Viewer
        camera={camera}
        profile={STREAM_PROFILES[0]}
        customNames={{}}
        onSelectProfile={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    const viewer = screen.getByRole("region", { name: /transmissão ao vivo/i });
    Object.defineProperty(viewer, "requestFullscreen", {
      value: vi.fn().mockRejectedValue(new Error("fullscreen_denied")),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /tela cheia/i }));
      await Promise.resolve();
    });

    expect(viewer.classList.contains("viewer--app-fullscreen")).toBe(true);
  });

  it("uses the app fullscreen fallback when the API is unavailable", () => {
    const camera = CAMERAS.find((candidate) => candidate.id === "cam-124")!;
    render(
      <Viewer
        camera={camera}
        profile={STREAM_PROFILES[0]}
        customNames={{}}
        onSelectProfile={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    const viewer = screen.getByRole("region", { name: /transmissão ao vivo/i });
    Object.defineProperty(viewer, "requestFullscreen", { value: undefined });
    fireEvent.click(screen.getByRole("button", { name: /tela cheia/i }));

    expect(viewer.classList.contains("viewer--app-fullscreen")).toBe(true);
  });
});

describe("camera rename dialog controls", () => {
  it("starts focused, keeps Tab inside, and closes on Escape", () => {
    const camera = CAMERAS.find((candidate) => candidate.id === "cam-124")!;
    const onClose = vi.fn();
    render(
      <RenameDialog camera={camera} currentName="Portão" onClose={onClose} onSaved={vi.fn()} />,
    );

    const dialog = screen.getByRole("dialog");
    const input = screen.getByRole("textbox");
    expect(document.activeElement).toBe(input);

    const buttons = screen.getAllByRole("button");
    buttons.at(-1)?.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
