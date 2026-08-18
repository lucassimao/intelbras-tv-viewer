import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StreamProfileSelector } from "../src/components/StreamProfileSelector";
import { STREAM_PROFILES } from "../src/config/cameras";

describe("stream profile keyboard controls", () => {
  it("cycles profiles without bubbling arrows to camera navigation", () => {
    const onSelect = vi.fn();
    const onParentKeyDown = vi.fn();
    const view = render(
      <div onKeyDown={onParentKeyDown}>
        <StreamProfileSelector
          profiles={STREAM_PROFILES}
          selectedProfileId={STREAM_PROFILES[0].id}
          onSelect={onSelect}
        />
      </div>,
    );

    const buttons = view.container.querySelectorAll<HTMLButtonElement>("button");
    buttons[0].focus();
    fireEvent.keyDown(buttons[0], { key: "ArrowRight" });

    expect(document.activeElement).toBe(buttons[1]);
    expect(onSelect).toHaveBeenCalledWith(STREAM_PROFILES[1].id);
    expect(onParentKeyDown).not.toHaveBeenCalled();
  });
});
