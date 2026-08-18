import { useCallback, useState } from "react";
import {
  streamProfilesForCamera,
  STREAM_PROFILES,
  type Camera,
  type StreamProfileId,
} from "../config/cameras";

const STORAGE_KEY = "intelbras-viewer-stream-profiles";

type ProfileSelection = Record<string, StreamProfileId>;

export function isProfileId(value: unknown): value is StreamProfileId {
  return typeof value === "string" && STREAM_PROFILES.some((profile) => profile.id === value);
}

export function readStoredSelections(): ProfileSelection {
  if (typeof window === "undefined") return {};

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};

    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, StreamProfileId] =>
        isProfileId(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function persistSelections(selections: ProfileSelection) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selections));
  } catch {
    // Some TV privacy modes disable storage; playback still works for this session.
  }
}

export function useStreamProfilePreferences() {
  const [selections, setSelections] = useState<ProfileSelection>(readStoredSelections);

  const profileForCamera = useCallback(
    (camera: Camera) => {
      const availableProfiles = streamProfilesForCamera(camera);
      const selectedId = selections[camera.id];
      return availableProfiles.find((profile) => profile.id === selectedId) ?? availableProfiles[0];
    },
    [selections],
  );

  const selectProfile = useCallback((camera: Camera, profileId: StreamProfileId) => {
    if (!streamProfilesForCamera(camera).some((profile) => profile.id === profileId)) return;

    setSelections((current) => {
      const next = { ...current, [camera.id]: profileId };
      persistSelections(next);
      return next;
    });
  }, []);

  return { profileForCamera, selectProfile };
}
