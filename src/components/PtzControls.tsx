import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Camera } from "../config/cameras";

type Direction = "up" | "down" | "left" | "right";
type PtzResponse = { ok?: boolean; error?: string };

const directions: readonly Direction[] = ["up", "down", "left", "right"];

export function PtzControls({ camera }: { camera: Camera }) {
  const { t } = useTranslation();
  const [moving, setMoving] = useState<Direction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const movingRef = useRef<Direction | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);

  const request = useCallback(
    async (action: "start" | "stop", direction: Direction) => {
      const response = await fetch("/api/ptz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraId: camera.id, action, direction }),
      });
      const payload = (await response.json().catch(() => ({}))) as PtzResponse;
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? "ptz_failed");
    },
    [camera.id],
  );

  const stop = useCallback(
    (direction = movingRef.current) => {
      movingRef.current = null;
      setMoving(null);
      if (!direction) return;
      requestRef.current = request("stop", direction)
        .catch(() => setError("ptz_stop_failed"))
        .finally(() => {
          requestRef.current = null;
        });
    },
    [request],
  );

  const start = useCallback(
    (direction: Direction) => {
      if (movingRef.current) return;
      movingRef.current = direction;
      setMoving(direction);
      setError(null);
      requestRef.current = request("start", direction)
        .then(() => {
          // A very fast release can race the start response. Always stop again
          // after a late start acknowledgement if the button is no longer held.
          if (movingRef.current !== direction) return request("stop", direction);
        })
        .catch(() => {
          if (movingRef.current === direction) {
            movingRef.current = null;
            setMoving(null);
          }
          setError("ptz_start_failed");
        })
        .finally(() => {
          requestRef.current = null;
        });
    },
    [request],
  );

  useEffect(() => {
    const release = () => stop();
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") release();
    };
    window.addEventListener("blur", release);
    window.addEventListener("beforeunload", release);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", release);
      window.removeEventListener("beforeunload", release);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      release();
    };
  }, [stop]);

  if (!camera.enabled || camera.ptz?.directions !== true) return null;

  const label = (direction: Direction) => t(`ptz.${direction}`);
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, direction: Direction) => {
    if (
      !(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as readonly string[]).includes(
        event.key,
      )
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) start(direction);
  };
  const onKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>, direction: Direction) => {
    if (
      !(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as readonly string[]).includes(
        event.key,
      )
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    stop(direction);
  };

  const onMouseDown = (direction: Direction) => start(direction);
  const onMouseUp = (direction: Direction) => stop(direction);
  const onTouchStart = (event: React.TouchEvent<HTMLButtonElement>, direction: Direction) => {
    event.preventDefault();
    start(direction);
  };
  const onTouchEnd = (direction: Direction) => stop(direction);

  return (
    <section className="ptz-controls" aria-label={t("ptz.label")}>
      <div className="ptz-controls__heading">
        <span className="eyebrow">{t("ptz.eyebrow")}</span>
        <span className="ptz-controls__state" role="status" aria-live="polite">
          {moving
            ? t("ptz.moving", { direction: label(moving) })
            : error
              ? t("ptz.error")
              : t("ptz.ready")}
        </span>
      </div>
      <div className="ptz-pad" role="group" aria-label={t("ptz.padLabel")}>
        <span />
        <button
          type="button"
          aria-label={label("up")}
          className={
            moving === "up" ? "ptz-pad__button ptz-pad__button--active" : "ptz-pad__button"
          }
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            start("up");
          }}
          onPointerUp={() => stop("up")}
          onPointerCancel={() => stop("up")}
          onLostPointerCapture={() => stop("up")}
          onMouseDown={() => onMouseDown("up")}
          onMouseUp={() => onMouseUp("up")}
          onMouseLeave={() => onMouseUp("up")}
          onTouchStart={(event) => onTouchStart(event, "up")}
          onTouchEnd={() => onTouchEnd("up")}
          onTouchCancel={() => onTouchEnd("up")}
          onKeyDown={(event) => onKeyDown(event, "up")}
          onKeyUp={(event) => onKeyUp(event, "up")}
          onBlur={() => stop("up")}
        >
          ▲
        </button>
        <span />
        <button
          type="button"
          aria-label={label("left")}
          className={
            moving === "left" ? "ptz-pad__button ptz-pad__button--active" : "ptz-pad__button"
          }
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            start("left");
          }}
          onPointerUp={() => stop("left")}
          onPointerCancel={() => stop("left")}
          onLostPointerCapture={() => stop("left")}
          onMouseDown={() => onMouseDown("left")}
          onMouseUp={() => onMouseUp("left")}
          onMouseLeave={() => onMouseUp("left")}
          onTouchStart={(event) => onTouchStart(event, "left")}
          onTouchEnd={() => onTouchEnd("left")}
          onTouchCancel={() => onTouchEnd("left")}
          onKeyDown={(event) => onKeyDown(event, "left")}
          onKeyUp={(event) => onKeyUp(event, "left")}
          onBlur={() => stop("left")}
        >
          ◀
        </button>
        <button
          type="button"
          className="ptz-pad__stop"
          onClick={() => stop()}
          aria-label={t("ptz.stop")}
        >
          ■
        </button>
        <button
          type="button"
          aria-label={label("right")}
          className={
            moving === "right" ? "ptz-pad__button ptz-pad__button--active" : "ptz-pad__button"
          }
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            start("right");
          }}
          onPointerUp={() => stop("right")}
          onPointerCancel={() => stop("right")}
          onLostPointerCapture={() => stop("right")}
          onMouseDown={() => onMouseDown("right")}
          onMouseUp={() => onMouseUp("right")}
          onMouseLeave={() => onMouseUp("right")}
          onTouchStart={(event) => onTouchStart(event, "right")}
          onTouchEnd={() => onTouchEnd("right")}
          onTouchCancel={() => onTouchEnd("right")}
          onKeyDown={(event) => onKeyDown(event, "right")}
          onKeyUp={(event) => onKeyUp(event, "right")}
          onBlur={() => stop("right")}
        >
          ▶
        </button>
        <span />
        <button
          type="button"
          aria-label={label("down")}
          className={
            moving === "down" ? "ptz-pad__button ptz-pad__button--active" : "ptz-pad__button"
          }
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            start("down");
          }}
          onPointerUp={() => stop("down")}
          onPointerCancel={() => stop("down")}
          onLostPointerCapture={() => stop("down")}
          onMouseDown={() => onMouseDown("down")}
          onMouseUp={() => onMouseUp("down")}
          onMouseLeave={() => onMouseUp("down")}
          onTouchStart={(event) => onTouchStart(event, "down")}
          onTouchEnd={() => onTouchEnd("down")}
          onTouchCancel={() => onTouchEnd("down")}
          onKeyDown={(event) => onKeyDown(event, "down")}
          onKeyUp={(event) => onKeyUp(event, "down")}
          onBlur={() => stop("down")}
        >
          ▼
        </button>
        <span />
      </div>
      {error ? <small className="ptz-controls__error">{t("ptz.errorDetail")}</small> : null}
    </section>
  );
}

export { directions as PTZ_DIRECTIONS };
