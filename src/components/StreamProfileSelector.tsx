import { useTranslation } from "react-i18next";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { StreamProfile, StreamProfileId } from "../config/cameras";

type StreamProfileSelectorProps = {
  profiles: readonly StreamProfile[];
  selectedProfileId: StreamProfileId;
  onSelect: (profileId: StreamProfileId) => void;
};

export function StreamProfileSelector({
  profiles,
  selectedProfileId,
  onSelect,
}: StreamProfileSelectorProps) {
  const { t } = useTranslation();

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const activeIndex = buttons.findIndex((button) => button === document.activeElement);
    if (activeIndex < 0 || buttons.length < 2) return;

    event.preventDefault();
    event.stopPropagation();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (activeIndex + direction + buttons.length) % buttons.length;
    buttons[nextIndex].focus({ preventScroll: true });
    const nextProfileId = buttons[nextIndex].dataset.profileId;
    const nextProfile = profiles.find((profile) => profile.id === nextProfileId);
    if (nextProfile) onSelect(nextProfile.id);
  };

  return (
    <fieldset className="stream-profile-selector">
      <legend>{t("streamProfiles.label")}</legend>
      <div
        className="stream-profile-selector__options"
        role="radiogroup"
        aria-label={t("streamProfiles.label")}
        onKeyDown={onKeyDown}
      >
        {profiles.map((profile) => {
          const selected = profile.id === selectedProfileId;
          return (
            <button
              key={profile.id}
              type="button"
              role="radio"
              data-profile-id={profile.id}
              aria-checked={selected}
              className={`stream-profile-option${selected ? " stream-profile-option--active" : ""}`}
              onClick={() => onSelect(profile.id)}
              title={t(profile.descriptionKey)}
            >
              <span className="stream-profile-option__dot" aria-hidden="true" />
              <span className="stream-profile-option__copy">
                <strong>{t(profile.labelKey)}</strong>
                <small>{t(profile.descriptionKey)}</small>
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
