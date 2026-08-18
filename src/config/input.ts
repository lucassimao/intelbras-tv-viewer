/**
 * Keyboard input policy shared by the shell and local controls.
 *
 * The app deliberately uses standard keys plus the common webOS/Samsung back
 * key codes. Device detection is avoided: a TV remote normally arrives as a
 * KeyboardEvent, while touch and mouse controls use native button semantics.
 */
export type InputCommand =
  | "camera-previous"
  | "camera-next"
  | "activate"
  | "back"
  | "mode-toggle"
  | "dashboard-toggle";

const BACK_KEY_CODES = new Set([461, 10009]);

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest('[contenteditable="true"], [role="textbox"]')) return true;
  return target.matches('input, textarea, select, [aria-multiline="true"]');
}

export function isBackKey(event: Pick<KeyboardEvent, "key" | "keyCode">): boolean {
  if (
    event.key === "Escape" ||
    event.key === "Back" ||
    event.key === "BrowserBack" ||
    event.key === "GoBack"
  ) {
    return true;
  }
  return BACK_KEY_CODES.has(event.keyCode);
}

export function inputCommandForKey(
  event: Pick<KeyboardEvent, "key" | "keyCode" | "repeat">,
): InputCommand | null {
  if (event.repeat) return null;
  if (isBackKey(event)) return "back";
  if (event.keyCode === 37) return "camera-previous";
  if (event.keyCode === 39) return "camera-next";
  if (event.keyCode === 13) return "activate";
  switch (event.key) {
    case "ArrowLeft":
      return "camera-previous";
    case "ArrowRight":
      return "camera-next";
    case "Enter":
    case "NumpadEnter":
    case " ":
      return "activate";
    case "m":
    case "M":
      return "mode-toggle";
    case "d":
    case "D":
      return "dashboard-toggle";
    default:
      return null;
  }
}

export function shouldHandleGlobalInput(event: KeyboardEvent): boolean {
  return !event.defaultPrevented && !event.repeat && !isEditableTarget(event.target);
}

export function cameraIndexAfterMove(
  length: number,
  currentIndex: number,
  direction: -1 | 1,
): number {
  if (length < 1) return -1;
  const normalized = currentIndex < 0 ? 0 : currentIndex;
  return (normalized + direction + length) % length;
}
