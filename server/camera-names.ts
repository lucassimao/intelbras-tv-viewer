export const MAX_CAMERA_NAME_LENGTH = 80;

export function normalizeCameraName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  if (!normalized || [...normalized].length > MAX_CAMERA_NAME_LENGTH) return null;
  if ([...normalized].some((character) => /\p{Cc}/u.test(character))) return null;
  return normalized;
}
