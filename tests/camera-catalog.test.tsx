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
  });
});
