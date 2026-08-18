import { describe, expect, it } from "vitest";
import {
  cameraIndexAfterMove,
  inputCommandForKey,
  isBackKey,
  isEditableTarget,
} from "../src/config/input";

describe("input command policy", () => {
  it("filters repeat events and maps TV navigation keys", () => {
    expect(inputCommandForKey({ key: "ArrowLeft", keyCode: 0, repeat: false })).toBe(
      "camera-previous",
    );
    expect(inputCommandForKey({ key: "ArrowRight", keyCode: 0, repeat: false })).toBe(
      "camera-next",
    );
    expect(inputCommandForKey({ key: "ArrowRight", keyCode: 0, repeat: true })).toBeNull();
    expect(inputCommandForKey({ key: "Left", keyCode: 37, repeat: false })).toBe("camera-previous");
    expect(inputCommandForKey({ key: "Right", keyCode: 39, repeat: false })).toBe("camera-next");
    expect(inputCommandForKey({ key: "Enter", keyCode: 13, repeat: false })).toBe("activate");
    expect(inputCommandForKey({ key: " ", keyCode: 32, repeat: false })).toBe("activate");
    expect(inputCommandForKey({ key: "m", keyCode: 77, repeat: false })).toBe("mode-toggle");
  });

  it("recognizes standard and common TV back variants", () => {
    expect(isBackKey({ key: "Escape", keyCode: 27 })).toBe(true);
    expect(isBackKey({ key: "Back", keyCode: 0 })).toBe(true);
    expect(isBackKey({ key: "BrowserBack", keyCode: 0 })).toBe(true);
    expect(isBackKey({ key: "Back", keyCode: 461 })).toBe(true);
    expect(isBackKey({ key: "Unidentified", keyCode: 10009 })).toBe(true);
    expect(inputCommandForKey({ key: "Backspace", keyCode: 8, repeat: false })).toBeNull();
  });

  it("wraps camera movement and handles empty catalogs", () => {
    expect(cameraIndexAfterMove(11, 0, -1)).toBe(10);
    expect(cameraIndexAfterMove(11, 10, 1)).toBe(0);
    expect(cameraIndexAfterMove(0, 0, 1)).toBe(-1);
  });

  it("does not classify editable controls as global input targets", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const button = document.createElement("button");
    document.body.append(input, textarea, button);
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(button)).toBe(false);
    input.remove();
    textarea.remove();
    button.remove();
  });
});
