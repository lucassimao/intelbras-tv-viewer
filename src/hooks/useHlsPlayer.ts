import type Hls from "hls.js";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { telemetryEvent, telemetryMeasurement, type TelemetryContext } from "../telemetry";

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
/**
 * A `stalled` event is advisory: live HLS implementations emit it while they
 * are still appending the next segment.  Give the media element time to make
 * real progress before tearing down the stream.
 */
export const HLS_STALL_GRACE_MS = 4_000;
/** A short playback burst must not reset the bounded retry budget. */
export const HLS_HEALTHY_PLAYBACK_RESET_MS = 30_000;
/** hls.js can repair a transient decode error in-place, but only finitely. */
export const HLS_MAX_MEDIA_RECOVERIES = 2;

export function shouldRecoverMediaError(recoveryCount: number) {
  return recoveryCount < HLS_MAX_MEDIA_RECOVERIES;
}

export function retryDelayForAttempt(attempt: number) {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 8_000);
}

export function useHlsPlayer(
  videoRef: RefObject<HTMLVideoElement | null>,
  streamUrl: string,
  onStartupMeasured?: (durationMs: number) => void,
  telemetryContext?: TelemetryContext,
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
  const requestedStreamRef = useRef<string | null>(null);

  const retry = useCallback(() => {
    retryCountRef.current = 0;
    setAttempt((currentAttempt) => currentAttempt + 1);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | undefined;
    let retryTimer: number | undefined;
    let stallTimer: number | undefined;
    let healthyPlaybackTimer: number | undefined;
    let retryScheduled = false;
    let disposed = false;
    let lastMediaProgressAt = performance.now();
    let mediaRecoveryCount = 0;
    let stallStartedAt: number | null = null;

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
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (stallTimer !== undefined) {
        window.clearTimeout(stallTimer);
        stallTimer = undefined;
      }
      retryScheduled = false;
      updateStatus({ state: "live", attempt: 0, delayMs: 0, startedAt: null });
      if (!startupReportedRef.current && startedAt !== null) {
        startupReportedRef.current = true;
        const startupMs = Math.max(0, Math.round(performance.now() - startedAt));
        onStartupMeasured?.(startupMs);
        telemetryEvent("first_frame", undefined, telemetryContext);
        telemetryMeasurement("stream_startup_ms", startupMs, telemetryContext);
      }

      if (healthyPlaybackTimer === undefined) {
        healthyPlaybackTimer = window.setTimeout(() => {
          healthyPlaybackTimer = undefined;
          if (
            !disposed &&
            currentStateRef.current === "live" &&
            performance.now() - lastMediaProgressAt < HLS_HEALTHY_PLAYBACK_RESET_MS
          ) {
            // Only a genuinely healthy, continuously progressing stream earns
            // a fresh retry budget. A quick playing event after a reload does
            // not turn a broken stream into an unbounded retry loop.
            retryCountRef.current = 0;
            mediaRecoveryCount = 0;
          }
        }, HLS_HEALTHY_PLAYBACK_RESET_MS);
      }
    };
    const markBuffering = () => {
      if (stallStartedAt === null) {
        stallStartedAt = performance.now();
        telemetryEvent("stall_started", undefined, telemetryContext);
      }
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
      if (stallTimer !== undefined) {
        window.clearTimeout(stallTimer);
        stallTimer = undefined;
      }
      if (retryScheduled) return;
      if (retryCountRef.current >= HLS_MAX_RETRIES) {
        if (currentStateRef.current !== "error") {
          telemetryEvent(
            "player_error_terminal",
            { attempts: retryCountRef.current },
            telemetryContext,
          );
        }
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
      telemetryEvent("player_retry", { attempt: retryCountRef.current, delayMs }, telemetryContext);
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

    const markMediaProgress = () => {
      lastMediaProgressAt = performance.now();
      if (stallStartedAt !== null) {
        const durationMs = Math.max(0, Math.round(performance.now() - stallStartedAt));
        stallStartedAt = null;
        telemetryEvent("stall_resolved", { durationMs }, telemetryContext);
        telemetryMeasurement("stall_duration_ms", durationMs, telemetryContext);
      }
      if (stallTimer !== undefined) {
        window.clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };

    const armStallWatchdog = () => {
      if (disposed || stallTimer !== undefined) return;
      stallTimer = window.setTimeout(() => {
        stallTimer = undefined;
        if (disposed) return;
        const elapsed = performance.now() - lastMediaProgressAt;
        if (elapsed < HLS_STALL_GRACE_MS) {
          armStallWatchdog();
          return;
        }
        scheduleRetry();
      }, HLS_STALL_GRACE_MS);
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
      if (currentStateRef.current === "live") return;

      // A browser connectivity transition is an explicit recovery signal. It
      // gets one fresh bounded cycle, unlike a repeated media error or stall.
      retryCountRef.current = 0;
      retryScheduled = false;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      scheduleRetry();
    };

    updateStatus({
      state: "connecting",
      attempt: retryCountRef.current,
      delayMs: 0,
      startedAt: Date.now(),
    });
    if (requestedStreamRef.current !== streamUrl) {
      requestedStreamRef.current = streamUrl;
      telemetryEvent("stream_requested", undefined, telemetryContext);
    }
    video.addEventListener("playing", markLive);
    video.addEventListener("waiting", markBuffering);
    video.addEventListener("timeupdate", markMediaProgress);
    video.addEventListener("progress", markMediaProgress);
    video.addEventListener("stalled", armStallWatchdog);
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

            telemetryEvent(
              "hls_error_fatal",
              {
                errorType: data.type,
                details: data.details,
              },
              telemetryContext,
            );

            if (data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR) {
              if (shouldRecoverMediaError(mediaRecoveryCount)) {
                mediaRecoveryCount += 1;
                hls?.recoverMediaError();
              } else {
                scheduleRetry();
              }
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
      if (stallTimer) window.clearTimeout(stallTimer);
      if (healthyPlaybackTimer) window.clearTimeout(healthyPlaybackTimer);
      video.removeEventListener("playing", markLive);
      video.removeEventListener("waiting", markBuffering);
      video.removeEventListener("timeupdate", markMediaProgress);
      video.removeEventListener("progress", markMediaProgress);
      video.removeEventListener("stalled", armStallWatchdog);
      video.removeEventListener("error", scheduleRetry);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      video.pause();
      video.removeAttribute("src");
      video.load();
      hls?.destroy();
    };
  }, [attempt, onStartupMeasured, streamUrl, telemetryContext, videoRef]);

  return { state: status.state, status, attempt, retry };
}
