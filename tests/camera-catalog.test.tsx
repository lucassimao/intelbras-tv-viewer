import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../src/i18n";
import { CameraCatalog } from "../src/App";
import { CAMERAS } from "../src/config/cameras";

describe("camera catalog rename affordance", () => {
  it("opens rename for a card without selecting or changing its live feed", () => {
    const camera = CAMERAS[0];
    const onRename = vi.fn();
    const onSelect = vi.fn();

    render(
      <CameraCatalog
        cameras={[camera]}
        activeCamera={camera}
        customNames={{}}
        page={0}
        onPageChange={vi.fn()}
        onSelect={onSelect}
        onRename={onRename}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /renomear/i }));

    expect(onRename).toHaveBeenCalledWith(camera);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByText("Renomear")).toBeNull();
  });

  it("keeps the rename action separate from the selectable camera button", () => {
    const camera = CAMERAS[0];
    const onRename = vi.fn();
    const onSelect = vi.fn();

    render(
      <CameraCatalog
        cameras={[camera]}
        activeCamera={camera}
        customNames={{}}
        page={0}
        onPageChange={vi.fn()}
        onSelect={onSelect}
        onRename={onRename}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const cameraButton = buttons.find((button) => button.dataset.cameraId === camera.id);
    const renameButton = screen.getByRole("button", { name: /renomear/i });

    expect(cameraButton).toBeDefined();
    expect(renameButton.querySelector("svg")).toBeTruthy();
    fireEvent.click(cameraButton!);
    expect(onSelect).toHaveBeenCalledWith(camera);
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.click(renameButton);
    expect(onRename).toHaveBeenCalledWith(camera);
  });

  it("opens rename from Enter on the pencil without selecting the camera", () => {
    const camera = CAMERAS[0];
    const onRename = vi.fn();
    const onSelect = vi.fn();

    render(
      <CameraCatalog
        cameras={[camera]}
        activeCamera={camera}
        customNames={{}}
        page={0}
        onPageChange={vi.fn()}
        onSelect={onSelect}
        onRename={onRename}
      />,
    );

    const renameButton = screen.getByRole("button", { name: /renomear/i });
    renameButton.focus();
    expect(document.activeElement).toBe(renameButton);
    fireEvent.keyDown(renameButton, { key: "Enter" });
    fireEvent.click(renameButton);

    expect(onRename).toHaveBeenCalledWith(camera);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
