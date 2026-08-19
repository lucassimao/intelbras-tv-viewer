import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HLS_MAX_RETRIES,
  HLS_MAX_MEDIA_RECOVERIES,
  HLS_STALL_GRACE_MS,
  retryDelayForAttempt,
  shouldRecoverMediaError,
  useHlsPlayer,
} from "../src/hooks/useHlsPlayer";
import * as telemetry from "../src/telemetry";

function TestPlayer({ url, onStartupMeasured }: { url: string; onStartupMeasured: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const player = useHlsPlayer(videoRef, url, onStartupMeasured);

  return (
    <>
      <video ref={videoRef} data-testid="video" />
      <output data-testid="state">{player.state}</output>
      <output data-testid="attempt">{player.status.attempt}</output>
    </>
  );
}

describe("HLS retry policy", () => {
  it("uses four bounded exponential retry delays", () => {
    expect(HLS_MAX_RETRIES).toBe(4);
    expect(
      Array.from({ length: HLS_MAX_RETRIES }, (_, index) => retryDelayForAttempt(index + 1)),
    ).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(retryDelayForAttempt(8)).toBe(8_000);
  });

  it("bounds in-place hls.js media recovery before consuming a retry", () => {
    expect(HLS_MAX_MEDIA_RECOVERIES).toBe(2);
    expect(shouldRecoverMediaError(0)).toBe(true);
    expect(shouldRecoverMediaError(HLS_MAX_MEDIA_RECOVERIES - 1)).toBe(true);
    expect(shouldRecoverMediaError(HLS_MAX_MEDIA_RECOVERIES)).toBe(false);
  });
});

describe("HLS player lifecycle", () => {
  beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows connecting, then buffering, and only reports live after playing", async () => {
    const onStartupMeasured = vi.fn();

    render(<TestPlayer url="/cam-114/index.m3u8" onStartupMeasured={onStartupMeasured} />);
    const video = screen.getByTestId("video");

    expect(screen.getByTestId("state").textContent).toBe("connecting");
    fireEvent(video, new Event("playing"));
    expect(screen.getByTestId("state").textContent).toBe("live");
    expect(onStartupMeasured).toHaveBeenCalledTimes(1);

    fireEvent(video, new Event("waiting"));
    expect(screen.getByTestId("state").textContent).toBe("buffering");
    fireEvent(video, new Event("playing"));
    expect(screen.getByTestId("state").textContent).toBe("live");
    expect(onStartupMeasured).toHaveBeenCalledTimes(1);
  });

  it("emits bounded stall telemetry without timeupdate flooding", () => {
    const eventSpy = vi.spyOn(telemetry, "telemetryEvent");
    const measurementSpy = vi.spyOn(telemetry, "telemetryMeasurement");
    const videoView = render(<TestPlayer url="/cam-114/index.m3u8" onStartupMeasured={vi.fn()} />);
    const video = screen.getByTestId("video");

    fireEvent(video, new Event("playing"));
    fireEvent(video, new Event("waiting"));
    fireEvent(video, new Event("timeupdate"));
    for (let index = 0; index < 20; index += 1) fireEvent(video, new Event("timeupdate"));

    expect(eventSpy.mock.calls.filter(([name]) => name === "stream_requested")).toHaveLength(1);
    expect(eventSpy.mock.calls.filter(([name]) => name === "stall_started")).toHaveLength(1);
    expect(eventSpy.mock.calls.filter(([name]) => name === "stall_resolved")).toHaveLength(1);
    expect(measurementSpy.mock.calls.filter(([name]) => name === "stall_duration_ms")).toHaveLength(
      1,
    );
    videoView.unmount();
  });

  it("resets the loading state for a camera or profile URL change", () => {
    const view = render(<TestPlayer url="/cam-114/index.m3u8" onStartupMeasured={vi.fn()} />);
    const video = screen.getByTestId("video");

    fireEvent(video, new Event("playing"));
    expect(screen.getByTestId("state").textContent).toBe("live");
    view.rerender(<TestPlayer url="/cam-114--main/index.m3u8" onStartupMeasured={vi.fn()} />);

    expect(screen.getByTestId("state").textContent).toBe("connecting");
    expect(screen.getByTestId("attempt").textContent).toBe("0");
  });

  it("exposes bounded retry metadata and reaches a manual-retry error", () => {
    vi.useFakeTimers();
    render(<TestPlayer url="/cam-114/index.m3u8" onStartupMeasured={vi.fn()} />);
    const video = screen.getByTestId("video");

    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      act(() => {
        fireEvent(video, new Event("stalled"));
        vi.advanceTimersByTime(HLS_STALL_GRACE_MS);
      });
      expect(screen.getByTestId("state").textContent).toBe("retrying");
      act(() => vi.advanceTimersByTime(delay));
    }
    act(() => {
      fireEvent(video, new Event("stalled"));
      vi.advanceTimersByTime(HLS_STALL_GRACE_MS);
    });
    expect(screen.getByTestId("state").textContent).toBe("error");
    expect(screen.getByTestId("attempt").textContent).toBe("4");
  });

  it("does not reload after a short stalled event when media keeps progressing", () => {
    vi.useFakeTimers();
    render(<TestPlayer url="/cam-114/index.m3u8" onStartupMeasured={vi.fn()} />);
    const video = screen.getByTestId("video");

    fireEvent(video, new Event("playing"));
    for (let index = 0; index < 3; index += 1) {
      act(() => fireEvent(video, new Event("stalled")));
      expect(screen.getByTestId("state").textContent).toBe("live");
      act(() => {
        vi.advanceTimersByTime(HLS_STALL_GRACE_MS - 500);
        fireEvent(video, new Event("timeupdate"));
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByTestId("state").textContent).toBe("live");
    }
  });

  it("keeps the retry budget after a brief recovery and only resets after healthy playback", () => {
    vi.useFakeTimers();
    render(<TestPlayer url="/cam-114/index.m3u8" onStartupMeasured={vi.fn()} />);
    const video = screen.getByTestId("video");

    act(() => {
      fireEvent(video, new Event("stalled"));
      vi.advanceTimersByTime(HLS_STALL_GRACE_MS);
    });
    expect(screen.getByTestId("attempt").textContent).toBe("1");
    act(() => vi.advanceTimersByTime(1_000));
    fireEvent(video, new Event("playing"));
    act(() => {
      fireEvent(video, new Event("stalled"));
      vi.advanceTimersByTime(HLS_STALL_GRACE_MS);
    });
    expect(screen.getByTestId("attempt").textContent).toBe("2");
  });

  it("cleans a scheduled retry when the player unmounts", () => {
    vi.useFakeTimers();
    const view = render(<TestPlayer url="/cam-114/index.m3u8" onStartupMeasured={vi.fn()} />);
    fireEvent(screen.getByTestId("video"), new Event("stalled"));
    view.unmount();

    expect(() => vi.advanceTimersByTime(8_000)).not.toThrow();
  });

  it("retries once when connectivity returns while the stream is not live", () => {
    vi.useFakeTimers();
    render(<TestPlayer url="/cam-114/index.m3u8" onStartupMeasured={vi.fn()} />);

    act(() => window.dispatchEvent(new Event("offline")));
    act(() => window.dispatchEvent(new Event("online")));

    expect(screen.getByTestId("state").textContent).toBe("retrying");
    expect(screen.getByTestId("attempt").textContent).toBe("1");
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId("state").textContent).toBe("connecting");
  });

  it("opens a fresh bounded recovery cycle after a long outage reaches terminal error", () => {
    vi.useFakeTimers();
    render(<TestPlayer url="/cam-114/index.m3u8" onStartupMeasured={vi.fn()} />);
    const video = screen.getByTestId("video");

    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      act(() => {
        fireEvent(video, new Event("stalled"));
        vi.advanceTimersByTime(HLS_STALL_GRACE_MS);
        vi.advanceTimersByTime(delay);
      });
    }
    act(() => {
      fireEvent(video, new Event("stalled"));
      vi.advanceTimersByTime(HLS_STALL_GRACE_MS);
    });
    expect(screen.getByTestId("state").textContent).toBe("error");

    act(() => window.dispatchEvent(new Event("online")));
    expect(screen.getByTestId("state").textContent).toBe("retrying");
    expect(screen.getByTestId("attempt").textContent).toBe("1");
  });
});
