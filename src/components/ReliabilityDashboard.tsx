import { useTranslation } from "react-i18next";
import { CAMERAS, STREAM_PROFILES } from "../config/cameras";
import {
  useReliability,
  type ReliabilityCamera,
  type ReliabilityData,
} from "../hooks/useReliability";

type ReliabilityDashboardProps = { cameraLabel: (cameraId: string) => string; onClose: () => void };

function formatDuration(value: number | null) {
  if (value === null) return "—";
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(1)} s`;
}

function formatMetric(value: number | null, suffix: string) {
  return value === null ? "—" : `${value.toFixed(value < 10 ? 1 : 0)}${suffix}`;
}

function Status({ state }: { state: ReliabilityCamera["state"] }) {
  const { t } = useTranslation();
  return (
    <span className={`reliability-status reliability-status--${state}`}>
      {t(`reliability.states.${state}`)}
    </span>
  );
}

function Rows({
  data,
  cameraLabel,
}: {
  data: ReliabilityData;
  cameraLabel: ReliabilityDashboardProps["cameraLabel"];
}) {
  const { t } = useTranslation();
  const byKey = new Map(
    data.cameras.map((camera) => [`${camera.cameraId}:${camera.profileId}`, camera]),
  );
  return (
    <div className="reliability-grid" role="table" aria-label={t("reliability.tableLabel")}>
      <div className="reliability-grid__head" role="row">
        <span>{t("reliability.camera")}</span>
        <span>{t("reliability.stream")}</span>
        <span>{t("reliability.state")}</span>
        <span>{t("reliability.startup")}</span>
        <span>{t("reliability.loss")}</span>
        <span>{t("reliability.jitter")}</span>
        <span>{t("reliability.lastFrame")}</span>
      </div>
      {CAMERAS.filter((camera) => camera.enabled).flatMap((camera) =>
        STREAM_PROFILES.map((profile) => {
          const item = byKey.get(`${camera.id}:${profile.id}`);
          return (
            <div className="reliability-grid__row" role="row" key={`${camera.id}:${profile.id}`}>
              <strong>{cameraLabel(camera.id)}</strong>
              <span>{t(profile.labelKey)}</span>
              <Status state={item?.state ?? "unknown"} />
              <span>{formatDuration(item?.startupMs ?? null)}</span>
              <span>{formatMetric(item?.packetLossPct ?? null, "%")}</span>
              <span>{formatMetric(item?.jitterMs ?? null, " ms")}</span>
              <span>
                {item?.lastFrameAgeMs === null || item?.lastFrameAgeMs === undefined
                  ? "—"
                  : formatDuration(item.lastFrameAgeMs)}
              </span>
            </div>
          );
        }),
      )}
    </div>
  );
}

export function ReliabilityDashboard({ cameraLabel, onClose }: ReliabilityDashboardProps) {
  const { t } = useTranslation();
  const { data, loading, error, reload } = useReliability();
  return (
    <section className="reliability-dashboard" aria-labelledby="reliability-title">
      <div className="reliability-dashboard__header">
        <div>
          <span className="eyebrow">{t("reliability.eyebrow")}</span>
          <h2 id="reliability-title">{t("reliability.title")}</h2>
        </div>
        <div className="reliability-dashboard__actions">
          <span className="reliability-dashboard__source">
            {data
              ? t("reliability.updated", { time: new Date(data.generatedAt).toLocaleTimeString() })
              : t("reliability.waiting")}
          </span>
          <button type="button" className="fullscreen-button" onClick={reload}>
            {t("reliability.refresh")}
          </button>
          <button type="button" className="fullscreen-button" onClick={onClose}>
            {t("reliability.close")}
          </button>
        </div>
      </div>
      {loading && !data ? (
        <p className="reliability-dashboard__message">{t("reliability.loading")}</p>
      ) : null}
      {error && !data ? (
        <p className="reliability-dashboard__message reliability-dashboard__message--error">
          {t("reliability.error")}
        </p>
      ) : null}
      {data ? <Rows data={data} cameraLabel={cameraLabel} /> : null}
      {data?.stale ? (
        <p className="reliability-dashboard__message">{t("reliability.stale")}</p>
      ) : null}
      <p className="reliability-dashboard__note">{t("reliability.note")}</p>
    </section>
  );
}
