import type Hls from "hls.js";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type PlayerState = "idle" | "connecting" | "buffering" | "live" | "retrying" | "error";

/**
 * State shared with the UI and reliability surfaces.  Retry metadata is kept
 * here instead of inferred in a component so a stream switch cannot display
 * the previous camera's attempt count or delay.
 */
export type PlayerStatus =
  | { state: "idle"; attempt: 0; delayMs: 0; startedAt: null }
  | { state: "connecting"; attempt: number; delayMs: 0; startedAt: number }
  | { state: "buffering"; attempt: number; delayMs: 0; startedAt: number }
  | { state: "retrying"; attempt: number; delayMs: number; startedAt: number }
  | { state: "live"; attempt: 0; delayMs: 0; startedAt: null }
  | { state: "error"; attempt: number; delayMs: 0; startedAt: null };

export const HLS_MAX_RETRIES = 4;

export function retryDelayForAttempt(attempt: number) {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 8_000);
}

export function useHlsPlayer(
  videoRef: RefObject<HTMLVideoElement | null>,
  streamUrl: string,
  onStartupMeasured?: (durationMs: number) => void,
) {
  const [status, setStatus] = useState<PlayerStatus>({
    state: "idle",
    attempt: 0,
    delayMs: 0,
    startedAt: null,
  });
  const [attempt, setAttempt] = useState(0);
  const retryCountRef = useRef(0);
  const lastStreamUrlRef = useRef(streamUrl);
  const startupAtRef = useRef<number | null>(null);
  const startupReportedRef = useRef(false);
  const currentStateRef = useRef<PlayerState>("idle");

  const retry = useCallback(() => {
    retryCountRef.current = 0;
    setAttempt((currentAttempt) => currentAttempt + 1);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | undefined;
    let retryTimer: number | undefined;
    let retryScheduled = false;
    let disposed = false;

    if (lastStreamUrlRef.current !== streamUrl) {
      retryCountRef.current = 0;
      lastStreamUrlRef.current = streamUrl;
      startupAtRef.current = performance.now();
      startupReportedRef.current = false;
    } else if (startupAtRef.current === null) {
      startupAtRef.current = performance.now();
    }
    const startedAt = startupAtRef.current;

    const updateStatus = (nextStatus: PlayerStatus) => {
      if (disposed) return;
      currentStateRef.current = nextStatus.state;
      setStatus(nextStatus);
    };

    const markLive = () => {
      retryCountRef.current = 0;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      retryScheduled = false;
      updateStatus({ state: "live", attempt: 0, delayMs: 0, startedAt: null });
      if (!startupReportedRef.current && startedAt !== null) {
        startupReportedRef.current = true;
        onStartupMeasured?.(Math.max(0, Math.round(performance.now() - startedAt)));
      }
    };
    const markBuffering = () => {
      if (currentStateRef.current === "live") {
        updateStatus({
          state: "buffering",
          attempt: retryCountRef.current,
          delayMs: 0,
          startedAt: Date.now(),
        });
      }
    };
    const scheduleRetry = () => {
      if (disposed) return;
      if (retryScheduled) return;
      if (retryCountRef.current >= HLS_MAX_RETRIES) {
        updateStatus({
          state: "error",
          attempt: retryCountRef.current,
          delayMs: 0,
          startedAt: null,
        });
        return;
      }

      retryScheduled = true;
      retryCountRef.current += 1;
      const delayMs = retryDelayForAttempt(retryCountRef.current);
      updateStatus({
        state: "retrying",
        attempt: retryCountRef.current,
        delayMs,
        startedAt: Date.now(),
      });
      retryTimer = window.setTimeout(() => {
        if (!disposed) {
          retryScheduled = false;
          setAttempt((currentAttempt) => currentAttempt + 1);
        }
      }, retryDelayForAttempt(retryCountRef.current));
    };

    const handleOffline = () => {
      if (currentStateRef.current !== "live") {
        updateStatus({
          state: "connecting",
          attempt: retryCountRef.current,
          delayMs: 0,
          startedAt: Date.now(),
        });
      }
    };
    const handleOnline = () => {
      if (currentStateRef.current !== "live") scheduleRetry();
    };

    updateStatus({
      state: "connecting",
      attempt: retryCountRef.current,
      delayMs: 0,
      startedAt: Date.now(),
    });
    video.addEventListener("playing", markLive);
    video.addEventListener("waiting", markBuffering);
    video.addEventListener("stalled", scheduleRetry);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamUrl;
      video.addEventListener("error", scheduleRetry);
      void video.play().catch(scheduleRetry);
    } else {
      void import("hls.js")
        .then(({ default: HlsPlayer }) => {
          if (disposed) return;
          if (!HlsPlayer.isSupported()) {
            updateStatus({
              state: "error",
              attempt: retryCountRef.current,
              delayMs: 0,
              startedAt: null,
            });
            return;
          }

          hls = new HlsPlayer({
            enableWorker: true,
            lowLatencyMode: false,
            liveSyncDurationCount: 2,
            liveMaxLatencyDurationCount: 5,
            maxLiveSyncPlaybackRate: 1.25,
          });
          hls.loadSource(streamUrl);
          hls.attachMedia(video);
          hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
            void video.play().catch(scheduleRetry);
          });
          hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;

            if (data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR) {
              hls?.recoverMediaError();
              return;
            }

            scheduleRetry();
          });
        })
        .catch(scheduleRetry);
    }

    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      video.removeEventListener("playing", markLive);
      video.removeEventListener("waiting", markBuffering);
      video.removeEventListener("stalled", scheduleRetry);
      video.removeEventListener("error", scheduleRetry);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      video.pause();
      video.removeAttribute("src");
      video.load();
      hls?.destroy();
    };
  }, [attempt, onStartupMeasured, streamUrl, videoRef]);

  return { state: status.state, status, attempt, retry };
}
