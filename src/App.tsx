import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import "./App.css";
import {
  CAMERAS,
  DEFAULT_CAMERA,
  streamPathForProfile,
  streamProfilesForCamera,
  type Camera,
  type StreamProfile,
} from "./config/cameras";
import {
  CAMERA_CATALOG_PAGE_SIZE,
  catalogPageCount,
  catalogPageForCamera,
  camerasOnCatalogPage,
  cycleCamera,
} from "./config/navigation";
import { inputCommandForKey, shouldHandleGlobalInput } from "./config/input";
import { StreamProfileSelector } from "./components/StreamProfileSelector";
import { ReliabilityDashboard } from "./components/ReliabilityDashboard";
import { PtzControls } from "./components/PtzControls";
import { LANGUAGE_STORAGE_KEY, type SupportedLanguage } from "./i18n";
import {
  HLS_MAX_RETRIES,
  useHlsPlayer,
  type PlayerState,
  type PlayerStatus,
} from "./hooks/useHlsPlayer";
import { useGlanceSnapshots, type SnapshotCameraStatus } from "./hooks/useGlanceSnapshots";
import { useStreamProfilePreferences } from "./hooks/useStreamProfilePreferences";
import { telemetryEvent } from "./telemetry";

type CameraNames = Record<string, string>;
type ViewMode = "focus" | "glance";
const VIEW_MODE_STORAGE_KEY = "intelbras-viewer-view-mode";
const GLANCE_PAGE_SIZE = 6;

function cameraName(camera: Camera, t: TFunction, customNames: CameraNames = {}) {
  return (
    customNames[camera.id] ??
    t("camera.defaultName", {
      model: camera.model ?? t("camera.genericModel"),
      ip: camera.ip,
    })
  );
}

function cameraTechnicalLabel(camera: Camera, t: TFunction) {
  return `${camera.model ?? t("camera.genericModel")} · ${camera.ip}`;
}

function parseCameraNames(value: unknown): CameraNames {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const names = (value as { names?: unknown }).names;
  if (typeof names !== "object" || names === null || Array.isArray(names)) return {};
  return Object.fromEntries(
    Object.entries(names).filter(
      ([cameraId, name]) => cameraId.length > 0 && typeof name === "string",
    ),
  );
}

function Clock() {
  const { i18n } = useTranslation();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const locale = i18n.resolvedLanguage === "en" ? "en" : "pt-BR";
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

  return <time dateTime={now.toISOString()}>{time}</time>;
}

function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const activeLanguage: SupportedLanguage = i18n.resolvedLanguage === "en" ? "en" : "pt-BR";

  const changeLanguage = useCallback(
    (language: SupportedLanguage) => {
      try {
        window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
      } catch {
        // Some TV privacy modes disable storage; the in-memory language still works.
      }
      void i18n.changeLanguage(language);
    },
    [i18n],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    changeLanguage(activeLanguage === "pt-BR" ? "en" : "pt-BR");
  };

  return (
    <div
      className="language-switcher"
      role="group"
      data-input-scope="language"
      aria-label={t("language.label")}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        aria-label={t("language.changeTo", { language: t("language.portuguese") })}
        aria-pressed={activeLanguage === "pt-BR"}
        onClick={() => changeLanguage("pt-BR")}
      >
        PT
      </button>
      <button
        type="button"
        aria-label={t("language.changeTo", { language: t("language.english") })}
        aria-pressed={activeLanguage === "en"}
        onClick={() => changeLanguage("en")}
      >
        EN
      </button>
    </div>
  );
}

function ModeSwitcher({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  const { t } = useTranslation();
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    onChange(mode === "focus" ? "glance" : "focus");
  };

  return (
    <div
      className="mode-switcher"
      role="group"
      data-input-scope="mode"
      aria-label={t("viewMode.label")}
      onKeyDown={onKeyDown}
    >
      <button type="button" aria-pressed={mode === "focus"} onClick={() => onChange("focus")}>
        {t("viewMode.focus")}
      </button>
      <button type="button" aria-pressed={mode === "glance"} onClick={() => onChange("glance")}>
        {t("viewMode.glance")}
      </button>
    </div>
  );
}

function StatusPill({ state }: { state: PlayerState }) {
  const { t } = useTranslation();

  return (
    <div className={`status-pill status-pill--${state}`} aria-live="polite">
      <span className="status-pill__light" aria-hidden="true" />
      {t(`status.${state}`)}
    </div>
  );
}

function StreamLoadingOverlay({
  camera,
  cameraName: name,
  profile,
  status,
}: {
  camera: Camera;
  cameraName: string;
  profile: StreamProfile;
  status: PlayerStatus;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const isError = status.state === "error";
  // A short live-buffer transition should keep the last decoded frame visible.
  // The full-screen loading panel is reserved for startup/reconnect states.
  const isLoading = !isError && status.state !== "live" && status.state !== "buffering";

  useEffect(() => {
    if (!isLoading || status.startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isLoading, status.startedAt]);

  if (!isLoading) return null;

  const elapsedSeconds =
    status.startedAt === null ? 0 : Math.max(0, Math.floor((now - status.startedAt) / 1_000));
  const message =
    status.state === "retrying"
      ? t("viewer.loadingRetrying", {
          attempt: status.attempt,
          max: HLS_MAX_RETRIES,
          delay: Math.ceil(status.delayMs / 1_000),
        })
      : t("viewer.loadingConnecting");

  return (
    <div className="stream-loading" role="status" aria-live="polite">
      <div className="stream-loading__panel">
        <span className="stream-loading__signal" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="eyebrow">{t("viewer.loadingEyebrow")}</span>
        <strong>{message}</strong>
        <span className="stream-loading__context">
          {name} · {t(profile.labelKey)} · {camera.ip}
        </span>
        {elapsedSeconds >= 5 ? (
          <small className="stream-loading__elapsed" aria-hidden="true">
            {t("viewer.loadingElapsed", { seconds: elapsedSeconds })}
          </small>
        ) : null}
      </div>
    </div>
  );
}

function getHlsOrigin() {
  const configuredOrigin = (import.meta as ImportMeta & { env?: { VITE_HLS_ORIGIN?: unknown } }).env
    ?.VITE_HLS_ORIGIN;
  const normalizedOrigin =
    typeof configuredOrigin === "string" ? configuredOrigin.replace(/\/$/, "") : undefined;
  return normalizedOrigin ?? `${window.location.protocol}//${window.location.hostname}:8888`;
}

export function Viewer({
  camera,
  profile,
  customNames,
  onSelectProfile,
}: {
  camera: Camera;
  profile: StreamProfile;
  customNames: CameraNames;
  onSelectProfile: (profileId: StreamProfile["id"]) => void;
}) {
  const { t } = useTranslation();
  const viewerRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [appFullscreen, setAppFullscreen] = useState(false);
  const fullscreenTelemetryRef = useRef(false);
  const name = cameraName(camera, t, customNames);
  const streamUrl = useMemo(
    () => `${getHlsOrigin()}/${streamPathForProfile(camera, profile)}/index.m3u8`,
    [camera, profile],
  );
  const telemetryContext = useMemo(
    () => ({ cameraId: camera.id, profileId: profile.id }),
    [camera.id, profile.id],
  );
  const reportStartup = useCallback(
    (durationMs: number) => {
      void fetch("/api/reliability/startup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraId: camera.id, profileId: profile.id, startupMs: durationMs }),
      }).catch(() => {
        // Telemetry must never interfere with playback.
      });
    },
    [camera.id, profile.id],
  );
  const { state, status, retry } = useHlsPlayer(
    videoRef,
    streamUrl,
    reportStartup,
    telemetryContext,
  );

  const requestFullscreen = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (document.fullscreenElement === viewer) {
      void document.exitFullscreen?.();
      return;
    }
    if (viewer.requestFullscreen) {
      void viewer
        .requestFullscreen()
        .catch(() => window.dispatchEvent(new Event("viewer:fullscreen-enter")));
      return;
    }
    window.dispatchEvent(new Event("viewer:fullscreen-enter"));
  }, []);

  useEffect(() => {
    const setFullscreenState = (active: boolean) => {
      setAppFullscreen(active);
      if (fullscreenTelemetryRef.current === active) return;
      fullscreenTelemetryRef.current = active;
      telemetryEvent(active ? "fullscreen_entered" : "fullscreen_exited", undefined, {
        cameraId: camera.id,
        profileId: profile.id,
      });
    };
    const onFullscreenChange = () => {
      setFullscreenState(document.fullscreenElement === viewerRef.current);
    };
    const onFallbackExit = () => setFullscreenState(false);
    const onFallbackEnter = () => setFullscreenState(true);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("viewer:fullscreen-enter", onFallbackEnter);
    window.addEventListener("viewer:fullscreen-exit", onFallbackExit);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("viewer:fullscreen-enter", onFallbackEnter);
      window.removeEventListener("viewer:fullscreen-exit", onFallbackExit);
    };
  }, [camera.id, profile.id]);

  return (
    <section
      ref={viewerRef}
      className={`viewer${appFullscreen ? " viewer--app-fullscreen" : ""}`}
      aria-label={t("viewer.liveStreamLabel", { camera: name })}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        aria-label={t("viewer.videoLabel", { camera: name })}
      />
      <div className="viewer__shade" aria-hidden="true" />
      <StreamLoadingOverlay camera={camera} cameraName={name} profile={profile} status={status} />

      <div className="viewer__topline">
        <div>
          <span className="eyebrow">{t("viewer.currentFeed")}</span>
          <h1>{name}</h1>
        </div>
      </div>
      <div className="viewer__controls">
        <StreamProfileSelector
          profiles={streamProfilesForCamera(camera)}
          selectedProfileId={profile.id}
          onSelect={onSelectProfile}
        />
        <StatusPill state={state} />
      </div>

      {state === "error" ? (
        <div className="viewer__message">
          <span className="viewer__message-code">{t("viewer.noSignal")}</span>
          <p>{t("viewer.profileLoadError", { camera: name, profile: t(profile.labelKey) })}</p>
          <button type="button" onClick={retry}>
            {t("viewer.tryAgain")}
          </button>
        </div>
      ) : null}

      <PtzControls camera={camera} />

      <div className="viewer__footer">
        <span>{t("viewer.cameraCode", { number: camera.shortcut })}</span>
        <span>{camera.ip}</span>
        <button type="button" className="fullscreen-button" onClick={requestFullscreen}>
          {t("viewer.fullscreen")}
        </button>
      </div>
    </section>
  );
}

function snapshotAgeLabel(status: SnapshotCameraStatus, t: TFunction) {
  if (status.status === "locked") return t("glance.locked");
  if (status.status === "error") return t("glance.error");
  if (status.status === "capturing" || status.status === "waiting") return t("glance.waiting");
  if (status.ageMs === null) return t("glance.waiting");
  if (status.ageMs < 1_000) return t("glance.ageSeconds", { seconds: 0 });
  return t("glance.ageSeconds", { seconds: Math.floor(status.ageMs / 1_000) });
}

function GlanceTile({
  camera,
  name,
  status,
  onSelect,
}: {
  camera: Camera;
  name: string;
  status: SnapshotCameraStatus;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl =
    status.revision > 0
      ? `/api/snapshots/${encodeURIComponent(camera.id)}?rev=${status.revision}`
      : null;
  const locked = !camera.enabled;
  const unavailable =
    imageFailed ||
    status.status === "error" ||
    status.status === "waiting" ||
    status.status === "capturing" ||
    !imageUrl;

  return (
    <button
      type="button"
      className={`glance-tile${locked ? " glance-tile--locked" : ""}`}
      disabled={locked}
      onClick={onSelect}
      aria-label={
        locked ? t("camera.lockedLabel", { camera: name }) : t("glance.promote", { camera: name })
      }
    >
      <span className="glance-tile__media">
        {unavailable ? (
          <span className="glance-tile__fallback">
            {locked ? "×" : imageFailed ? t("glance.imageError") : "…"}
          </span>
        ) : null}
        {imageUrl && !imageFailed && !locked ? (
          <img
            src={imageUrl}
            alt={t("glance.snapshotAlt", { camera: name })}
            onError={() => setImageFailed(true)}
          />
        ) : null}
        <span className={`glance-tile__status glance-tile__status--${status.status}`}>
          {snapshotAgeLabel(status, t)}
        </span>
      </span>
      <span className="glance-tile__copy">
        <strong>{name}</strong>
        <small>
          {camera.model ?? t("glance.genericModel")} · {camera.ip}
        </small>
      </span>
    </button>
  );
}

function GlanceWall({
  camera,
  profile,
  customNames,
  onSelectCamera,
  onSelectProfile,
}: {
  camera: Camera;
  profile: StreamProfile;
  customNames: CameraNames;
  onSelectCamera: (cameraId: string) => void;
  onSelectProfile: (profileId: StreamProfile["id"]) => void;
}) {
  const { t } = useTranslation();
  const priorityCameraIds = useMemo(
    () =>
      CAMERAS.filter((candidate) => candidate.id !== camera.id)
        .slice(0, GLANCE_PAGE_SIZE)
        .map((candidate) => candidate.id),
    [camera.id],
  );
  const { statuses, unavailable } = useGlanceSnapshots(true, { priorityCameraIds });
  const [page, setPage] = useState(0);
  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.cameraId, status])),
    [statuses],
  );
  const tiles = useMemo(
    () => CAMERAS.filter((candidate) => candidate.id !== camera.id),
    [camera.id],
  );
  const pageCount = Math.max(1, Math.ceil(tiles.length / GLANCE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visibleTiles = tiles.slice(safePage * GLANCE_PAGE_SIZE, (safePage + 1) * GLANCE_PAGE_SIZE);
  const nameFor = (candidate: Camera) => cameraName(candidate, t, customNames);

  return (
    <section className="glance-wall" aria-label={t("glance.wallLabel")}>
      <div className="glance-wall__live">
        <Viewer
          camera={camera}
          profile={profile}
          customNames={customNames}
          onSelectProfile={onSelectProfile}
        />
      </div>
      <aside className="glance-wall__catalog" aria-label={t("glance.catalogLabel")}>
        <div className="glance-wall__heading">
          <div>
            <span className="eyebrow">{t("glance.eyebrow")}</span>
            <h2>{t("glance.title")}</h2>
          </div>
          <span className="glance-wall__count">{t("glance.liveCount")}</span>
        </div>
        {unavailable ? (
          <p className="glance-wall__notice" role="status">
            {t("glance.serviceUnavailable")}
          </p>
        ) : null}
        <div className="glance-wall__grid">
          {visibleTiles.map((candidate) => (
            <GlanceTile
              key={candidate.id}
              camera={candidate}
              name={nameFor(candidate)}
              status={
                statusById.get(candidate.id) ?? {
                  cameraId: candidate.id,
                  status: candidate.enabled ? "waiting" : "locked",
                  capturedAt: null,
                  ageMs: null,
                  revision: 0,
                }
              }
              onSelect={() => onSelectCamera(candidate.id)}
            />
          ))}
        </div>
        <div className="glance-wall__pagination">
          <button
            type="button"
            onClick={() => setPage((current) => (current - 1 + pageCount) % pageCount)}
            disabled={pageCount < 2}
            aria-label={t("glance.previousPage")}
          >
            ←
          </button>
          <span>{t("glance.page", { current: safePage + 1, total: pageCount })}</span>
          <button
            type="button"
            onClick={() => setPage((current) => (current + 1) % pageCount)}
            disabled={pageCount < 2}
            aria-label={t("glance.nextPage")}
          >
            →
          </button>
        </div>
      </aside>
    </section>
  );
}

function EmptyState() {
  const { t } = useTranslation();

  return (
    <main className="console-shell console-shell--empty">
      <section className="viewer viewer--empty" aria-labelledby="empty-title">
        <div className="viewer__message">
          <span className="viewer__message-code">{t("empty.code")}</span>
          <h1 id="empty-title">{t("empty.title")}</h1>
          <p>{t("empty.description")}</p>
        </div>
      </section>
    </main>
  );
}

export function CameraCatalog({
  cameras,
  activeCamera,
  customNames,
  page,
  onPageChange,
  onSelect,
  onRename,
}: {
  cameras: readonly Camera[];
  activeCamera: Camera;
  customNames: CameraNames;
  page: number;
  onPageChange: (page: number) => void;
  onSelect: (camera: Camera) => void;
  onRename: (camera: Camera) => void;
}) {
  const { t } = useTranslation();
  const pageCount = catalogPageCount(cameras, CAMERA_CATALOG_PAGE_SIZE);
  const safePage = Math.min(page, pageCount - 1);
  const pageCameras = camerasOnCatalogPage(cameras, safePage, CAMERA_CATALOG_PAGE_SIZE);

  const movePage = (direction: -1 | 1) => {
    onPageChange(Math.min(pageCount - 1, Math.max(0, safePage + direction)));
  };

  const onPaginationKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (
      !(event.target instanceof HTMLButtonElement) ||
      !event.target.classList.contains("camera-page-button")
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    movePage(event.key === "ArrowRight" ? 1 : -1);
  };

  return (
    <section className="camera-catalog" aria-labelledby="camera-catalog-title">
      <div className="camera-catalog__header">
        <div>
          <span className="eyebrow">{t("camera.catalogEyebrow")}</span>
          <h2 id="camera-catalog-title">{t("camera.catalogTitle")}</h2>
        </div>
        <div
          className="camera-catalog__pagination"
          data-input-scope="catalog-pagination"
          onKeyDown={onPaginationKeyDown}
        >
          <button
            type="button"
            className="camera-page-button"
            onClick={() => movePage(-1)}
            disabled={safePage === 0}
            aria-label={t("camera.previousPage")}
          >
            ←
          </button>
          <span aria-live="polite">
            {t("camera.pagePosition", { current: safePage + 1, total: pageCount })}
          </span>
          <button
            type="button"
            className="camera-page-button"
            onClick={() => movePage(1)}
            disabled={safePage === pageCount - 1}
            aria-label={t("camera.nextPage")}
          >
            →
          </button>
        </div>
      </div>
      <nav className="camera-catalog__grid" aria-label={t("camera.navigationLabel")}>
        {pageCameras.map((camera) => {
          const name = cameraName(camera, t, customNames);
          const available = camera.enabled;
          return (
            <div
              key={camera.id}
              className={`camera-card-row${camera.id === activeCamera.id ? " camera-card-row--active" : ""}`}
            >
              <button
                type="button"
                data-camera-id={camera.id}
                className={`camera-card${camera.id === activeCamera.id ? " camera-card--active" : ""}${available ? "" : " camera-card--locked"}`}
                aria-label={available ? name : t("camera.lockedLabel", { camera: name })}
                aria-pressed={available ? camera.id === activeCamera.id : undefined}
                aria-current={camera.id === activeCamera.id ? "true" : undefined}
                onClick={() => (available ? onSelect(camera) : onRename(camera))}
              >
                <span className="camera-card__number">{camera.shortcut}</span>
                <span className="camera-card__copy">
                  <strong>{name}</strong>
                  <small>{cameraTechnicalLabel(camera, t)}</small>
                </span>
                <span className="camera-card__state" aria-hidden="true">
                  {available ? t("camera.ready") : t("camera.locked")}
                </span>
              </button>
              <button
                type="button"
                className="camera-card__rename"
                aria-label={t("camera.renameDialogTitle", { camera: name })}
                title={t("camera.renameDialogTitle", { camera: name })}
                onClick={() => onRename(camera)}
              >
                <svg
                  className="camera-card__rename-icon"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17v3Z" />
                  <path d="m14.5 7.5 2 2" />
                </svg>
              </button>
            </div>
          );
        })}
      </nav>
    </section>
  );
}

export function RenameDialog({
  camera,
  currentName,
  onClose,
  onSaved,
}: {
  camera: Camera;
  currentName?: string;
  onClose: () => void;
  onSaved: (name: string | null) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(currentName ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dialogCameraName = currentName ?? cameraName(camera, t);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();

    const keepFocusInside = (event: FocusEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) {
        inputRef.current?.focus();
      }
    };
    document.addEventListener("focusin", keepFocusInside);
    return () => document.removeEventListener("focusin", keepFocusInside);
  }, []);

  const saveName = async (nextName: string | null) => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/cameras/${encodeURIComponent(camera.id)}/name`, {
        method: nextName === null ? "DELETE" : "PUT",
        headers: nextName === null ? undefined : { "Content-Type": "application/json" },
        body: nextName === null ? undefined : JSON.stringify({ name: nextName }),
      });
      if (!response.ok) throw new Error("name_save_failed");
      onSaved(nextName);
      onClose();
    } catch {
      setError(t("camera.renameFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (inputCommandForKey(event.nativeEvent) === "back") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;

    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="rename-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="rename-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="rename-title"
        onKeyDown={onKeyDown}
      >
        <span className="eyebrow">{t("camera.renameCode")}</span>
        <h2 id="rename-title">{t("camera.renameDialogTitle", { camera: dialogCameraName })}</h2>
        <p>{t("camera.renameDescription")}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveName(name);
          }}
        >
          <label htmlFor="camera-name">{t("camera.nameLabel")}</label>
          <input
            ref={inputRef}
            id="camera-name"
            value={name}
            maxLength={80}
            autoComplete="off"
            placeholder={t("camera.namePlaceholder")}
            aria-describedby={error ? "rename-error" : undefined}
            aria-invalid={error ? "true" : undefined}
            onChange={(event) => setName(event.target.value)}
            disabled={isSaving}
          />
          {error ? (
            <p id="rename-error" className="rename-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="rename-dialog__actions">
            <button type="button" onClick={onClose} disabled={isSaving}>
              {t("camera.cancelRename")}
            </button>
            <button
              type="button"
              onClick={() => void saveName(null)}
              disabled={isSaving || !currentName}
            >
              {t("camera.clearName")}
            </button>
            <button
              type="submit"
              className="rename-dialog__primary"
              disabled={isSaving || !name.trim()}
            >
              {isSaving ? t("camera.savingName") : t("camera.saveName")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function App() {
  const { i18n, t } = useTranslation();
  useEffect(() => {
    // Mark the boot shell complete only after React has committed this tree.
    // If parsing or mounting fails on an older TV, index.html's diagnostic
    // remains available instead of being cleared immediately after render().
    (window as Window & { __viewerMounted?: boolean }).__viewerMounted = true;
  }, []);
  const availableCameras = useMemo(() => CAMERAS.filter((camera) => camera.enabled), []);
  const [activeCameraId, setActiveCameraId] = useState(DEFAULT_CAMERA.id);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "glance" ? "glance" : "focus";
    } catch {
      return "focus";
    }
  });
  const [customNames, setCustomNames] = useState<CameraNames>({});
  const [renameCameraId, setRenameCameraId] = useState<string | null>(null);
  const renameOriginRef = useRef<HTMLElement | null>(null);
  const [showReliability, setShowReliability] = useState(false);
  const [catalogPage, setCatalogPage] = useState(() =>
    catalogPageForCamera(CAMERAS, DEFAULT_CAMERA.id, CAMERA_CATALOG_PAGE_SIZE),
  );
  const activeCamera =
    availableCameras.find((camera) => camera.id === activeCameraId) ?? availableCameras[0];
  const { profileForCamera, selectProfile: persistProfileSelection } =
    useStreamProfilePreferences();

  const changeViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Some TV privacy modes disable storage; the in-memory mode still works.
    }
  }, []);

  const openRename = useCallback((cameraId: string) => {
    // A native fullscreen element creates a top-layer boundary on webOS. Exit
    // it before mounting the dialog so the modal is always visible and usable.
    if (document.fullscreenElement) void document.exitFullscreen?.();
    if (document.querySelector<HTMLElement>(".viewer--app-fullscreen")) {
      window.dispatchEvent(new Event("viewer:fullscreen-exit"));
    }
    renameOriginRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRenameCameraId(cameraId);
  }, []);

  const closeRename = useCallback(() => {
    setRenameCameraId(null);
  }, []);

  useEffect(() => {
    if (renameCameraId !== null || !renameOriginRef.current) return;
    const origin = renameOriginRef.current;
    renameOriginRef.current = null;
    window.setTimeout(() => origin.focus({ preventScroll: true }), 0);
  }, [renameCameraId]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/cameras/names", { signal: controller.signal })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<unknown>)
          : Promise.reject(new Error("names_unavailable")),
      )
      .then((value) => setCustomNames(parseCameraNames(value)))
      .catch(() => {
        // The viewer remains fully usable with translated defaults if the local API is down.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const language = i18n.resolvedLanguage === "en" ? "en" : "pt-BR";
    document.documentElement.lang = language;
    document.title = t("app.documentTitle");
  }, [i18n.resolvedLanguage, t]);

  useEffect(() => {
    const activeButton = activeCamera
      ? document.querySelector<HTMLButtonElement>(`[data-camera-id="${activeCamera.id}"]`)
      : null;
    activeButton?.focus({ preventScroll: true });
  }, [activeCamera, catalogPage]);

  const selectCamera = useCallback((cameraId: string) => {
    const camera = CAMERAS.find((candidate) => candidate.id === cameraId && candidate.enabled);
    if (!camera) return;
    setActiveCameraId(camera.id);
    setCatalogPage(catalogPageForCamera(CAMERAS, camera.id, CAMERA_CATALOG_PAGE_SIZE));
    telemetryEvent("camera_changed", { source: "selection" }, { cameraId: camera.id });
  }, []);

  const selectProfile = useCallback(
    (camera: Camera, profileId: StreamProfile["id"]) => {
      if (!streamProfilesForCamera(camera).some((candidate) => candidate.id === profileId)) return;
      persistProfileSelection(camera, profileId);
      telemetryEvent("profile_changed", undefined, {
        cameraId: camera.id,
        profileId,
      });
    },
    [persistProfileSelection],
  );

  const moveCamera = useCallback(
    (direction: -1 | 1) => {
      const camera = cycleCamera(CAMERAS, activeCameraId, direction);
      if (!camera) return;
      setActiveCameraId(camera.id);
      setCatalogPage(catalogPageForCamera(CAMERAS, camera.id, CAMERA_CATALOG_PAGE_SIZE));
      telemetryEvent(
        "camera_changed",
        { source: direction < 0 ? "previous" : "next" },
        {
          cameraId: camera.id,
        },
      );
    },
    [activeCameraId],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleGlobalInput(event)) return;
      if (event.target instanceof HTMLElement && event.target.closest('[role="dialog"]')) return;

      const command = inputCommandForKey(event);
      if (command === "back") {
        const fullscreenViewer =
          document.fullscreenElement?.closest(".viewer") ??
          document.querySelector<HTMLElement>(".viewer--app-fullscreen");
        if (fullscreenViewer) {
          event.preventDefault();
          if (document.fullscreenElement) void document.exitFullscreen?.();
          window.dispatchEvent(new Event("viewer:fullscreen-exit"));
          return;
        }
        if (showReliability) {
          event.preventDefault();
          setShowReliability(false);
        }
        return;
      }

      if (command === "mode-toggle") {
        event.preventDefault();
        changeViewMode(viewMode === "focus" ? "glance" : "focus");
        return;
      }

      if (command === "dashboard-toggle") {
        event.preventDefault();
        setShowReliability((visible) => !visible);
        return;
      }

      if (command === "camera-previous") {
        event.preventDefault();
        moveCamera(-1);
        return;
      }

      if (command === "camera-next") {
        event.preventDefault();
        moveCamera(1);
        return;
      }

      const selectedCamera = availableCameras.find((camera) => camera.shortcut === event.key);
      if (selectedCamera) {
        event.preventDefault();
        selectCamera(selectedCamera.id);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [availableCameras, changeViewMode, moveCamera, selectCamera, showReliability, viewMode]);

  if (!activeCamera) return <EmptyState />;

  const activeCameraName = cameraName(activeCamera, t, customNames);
  const activeProfile = profileForCamera(activeCamera);
  if (!activeProfile) return <EmptyState />;
  const renameCamera = renameCameraId
    ? CAMERAS.find((camera) => camera.id === renameCameraId)
    : undefined;

  return (
    <main className={`console-shell${viewMode === "glance" ? " console-shell--glance" : ""}`}>
      <header className="masthead">
        <div className="brand">
          <div>
            <strong>{t("header.title")}</strong>
            <span>{t("header.subtitle")}</span>
          </div>
        </div>
        <div className="masthead__meta">
          <span>{t("header.localNetwork")}</span>
          <ModeSwitcher mode={viewMode} onChange={changeViewMode} />
          <button
            type="button"
            className="dashboard-toggle"
            data-input-scope="dashboard"
            aria-expanded={showReliability}
            onClick={() => setShowReliability((visible) => !visible)}
          >
            {t("reliability.toggle")}
          </button>
          <LanguageSwitcher />
          <Clock />
        </div>
      </header>

      {showReliability ? (
        <ReliabilityDashboard
          cameraLabel={(cameraId) => {
            const camera = CAMERAS.find((candidate) => candidate.id === cameraId);
            return camera ? cameraName(camera, t, customNames) : cameraId;
          }}
          onClose={() => setShowReliability(false)}
        />
      ) : null}

      {viewMode === "glance" ? (
        <GlanceWall
          camera={activeCamera}
          profile={activeProfile}
          customNames={customNames}
          onSelectCamera={selectCamera}
          onSelectProfile={(profileId) => selectProfile(activeCamera, profileId)}
        />
      ) : (
        <Viewer
          camera={activeCamera}
          profile={activeProfile}
          customNames={customNames}
          onSelectProfile={(profileId) => selectProfile(activeCamera, profileId)}
        />
      )}

      <p className="sr-only" aria-live="polite">
        {t("accessibility.showingCamera", { camera: activeCameraName })}
      </p>

      {viewMode === "focus" ? (
        <CameraCatalog
          cameras={CAMERAS}
          activeCamera={activeCamera}
          customNames={customNames}
          page={catalogPage}
          onPageChange={setCatalogPage}
          onSelect={(camera) => selectCamera(camera.id)}
          onRename={(camera) => openRename(camera.id)}
        />
      ) : null}

      <footer className="help-line">
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd> {t("help.changeCamera")}
        </span>
        <span>
          <kbd>1–9</kbd> {t("help.jumpToFeed")}
        </span>
        <span>
          <kbd>OK</kbd> {viewMode === "glance" ? t("glance.promoteHint") : t("help.selectFeed")}
        </span>
        <span className="help-line__system">Relay / HLS</span>
      </footer>
      {renameCamera ? (
        <RenameDialog
          camera={renameCamera}
          currentName={customNames[renameCamera.id]}
          onClose={closeRename}
          onSaved={(name) =>
            setCustomNames((current) => {
              if (name === null) {
                const next = { ...current };
                delete next[renameCamera.id];
                return next;
              }
              return { ...current, [renameCamera.id]: name.trim() };
            })
          }
        />
      ) : null}
    </main>
  );
}

export default App;
