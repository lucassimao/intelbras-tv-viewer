import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getWebInstrumentations: vi.fn(() => []),
  initializeFaro: vi.fn(),
}));
const tracing = vi.hoisted(() => ({
  TracingInstrumentation: vi.fn(function TracingInstrumentation() {
    return { name: "@grafana/faro-web-tracing" };
  }),
}));

vi.mock("@grafana/faro-web-sdk", () => sdk);
vi.mock("@grafana/faro-web-tracing", () => tracing);

import {
  initTelemetry,
  resetTelemetryForTests,
  sanitizePlainText,
  sanitizeUnknown,
  setTelemetryEnvForTests,
  telemetryConfig,
  telemetryError,
  telemetryEvent,
  telemetryPendingCountForTests,
  telemetryState,
} from "../src/telemetry";

function makeFaro() {
  return {
    api: {
      pushEvent: vi.fn(),
      pushMeasurement: vi.fn(),
      pushError: vi.fn(),
    },
  };
}

describe("Faro telemetry adapter", () => {
  afterEach(() => {
    resetTelemetryForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    sdk.getWebInstrumentations.mockReset().mockReturnValue([]);
    sdk.initializeFaro.mockReset();
    tracing.TracingInstrumentation.mockClear();
  });

  it("is disabled without a collector URL and makes no requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setTelemetryEnvForTests({});

    await initTelemetry();
    telemetryEvent("stream_requested", undefined, { cameraId: "cam-124" });

    expect(telemetryState()).toBe("disabled");
    expect(telemetryConfig()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tracing.TracingInstrumentation).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("adds privacy-bounded tracing without cross-origin propagation", async () => {
    const faro = makeFaro();
    sdk.initializeFaro.mockReturnValue(faro);
    setTelemetryEnvForTests({ VITE_FARO_URL: "https://collector.example.invalid/collect" });

    await initTelemetry();

    const options = sdk.initializeFaro.mock.calls[0][0];
    expect(options.ignoreUrls).toEqual(expect.arrayContaining([expect.any(RegExp)]));
    expect(
      options.ignoreUrls.some((pattern: RegExp) =>
        pattern.test("http://192.168.1.10:8888/cam-124/index.m3u8"),
      ),
    ).toBe(true);
    expect(options.ignoreUrls.some((pattern: RegExp) => pattern.test("/api/ptz"))).toBe(true);
    expect(tracing.TracingInstrumentation).toHaveBeenCalledWith({
      instrumentationOptions: { propagateTraceHeaderCorsUrls: [] },
    });
  });

  it("retries a transient initialization failure with bounded backoff", async () => {
    vi.useFakeTimers();
    const faro = makeFaro();
    sdk.initializeFaro
      .mockImplementationOnce(() => {
        throw new Error("temporary collector failure");
      })
      .mockImplementationOnce(() => {
        throw new Error("temporary collector failure");
      })
      .mockReturnValueOnce(faro);
    setTelemetryEnvForTests({ VITE_FARO_URL: "https://collector.example.invalid/collect" });

    const initialization = initTelemetry();
    telemetryEvent("stream_requested", { source: "queued" });
    await vi.advanceTimersByTimeAsync(0);
    expect(telemetryState()).toBe("retrying");
    expect(sdk.initializeFaro).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(sdk.initializeFaro).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.initializeFaro).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(initialization).resolves.toBeUndefined();
    expect(sdk.initializeFaro).toHaveBeenCalledTimes(3);
    expect(telemetryState()).toBe("ready");
    expect(faro.api.pushEvent).toHaveBeenCalledTimes(1);
  });

  it("fails open after the terminal attempt and does not retry on later calls", async () => {
    vi.useFakeTimers();
    sdk.initializeFaro.mockImplementation(() => {
      throw new Error("collector unavailable");
    });
    setTelemetryEnvForTests({ VITE_FARO_URL: "http://127.0.0.1:9999/collect" });

    const initialization = initTelemetry();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(initialization).resolves.toBeUndefined();

    expect(telemetryState()).toBe("failed");
    expect(sdk.initializeFaro).toHaveBeenCalledTimes(3);
    await initTelemetry();
    expect(sdk.initializeFaro).toHaveBeenCalledTimes(3);
  });

  it("shares one retry sequence across concurrent callers and drains once", async () => {
    vi.useFakeTimers();
    const faro = makeFaro();
    sdk.initializeFaro
      .mockImplementationOnce(() => {
        throw new Error("temporary collector failure");
      })
      .mockReturnValueOnce(faro);
    setTelemetryEnvForTests({ VITE_FARO_URL: "https://collector.example.invalid/collect" });

    const first = initTelemetry();
    const second = initTelemetry();
    expect(first).toBe(second);
    telemetryEvent("stream_requested");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toBeUndefined();
    expect(sdk.initializeFaro).toHaveBeenCalledTimes(2);
    expect(faro.api.pushEvent).toHaveBeenCalledTimes(1);
    expect(telemetryPendingCountForTests()).toBe(0);
  });

  it("bounds events queued while the lazy SDK is loading", () => {
    setTelemetryEnvForTests({ VITE_FARO_URL: "https://collector.example.invalid/collect" });
    void initTelemetry();

    for (let index = 0; index < 50; index += 1) {
      telemetryEvent("stream_requested", { index }, { cameraId: "cam-124" });
    }

    expect(telemetryPendingCountForTests()).toBe(32);
  });

  it("redacts IPv4/IPv6 variants while preserving versions and ordinary text", () => {
    const value = sanitizePlainText(
      "IPv4 192.168.1.10 IPv6 2001:0db8:0000:0000:0000:0000:0000:0001 compressed 2001:db8::1 link-local fe80::1%eth0 loopback ::1 bracketed [::1]:443",
    );

    expect(value).not.toMatch(/192\.168\.1\.10|2001:|fe80:|::1/);
    expect(sanitizePlainText("version 1.2.3.4 release 2026.08.19 ordinary text")).toContain(
      "1.2.3.4",
    );
    expect(sanitizePlainText("time 12:34:56 and ratio 1:2")).toBe("time 12:34:56 and ratio 1:2");
  });

  it("applies the same sanitizer to nested context values", () => {
    const nested = sanitizeUnknown({
      context: {
        address: "[2001:db8::1]",
        url: "http://192.168.1.10/a?x=1",
        headers: { token: "abc" },
      },
    });

    expect(nested).toEqual({ context: { address: "[redacted-ip]" } });
  });

  it("preserves the original error stack after sanitizing sensitive frames", async () => {
    const faro = makeFaro();
    sdk.initializeFaro.mockReturnValue(faro);
    setTelemetryEnvForTests({ VITE_FARO_URL: "https://collector.example.invalid/collect" });
    await initTelemetry();

    const source = new Error("camera failed at 192.168.1.10");
    source.name = "PlayerError";
    source.stack =
      "PlayerError: camera failed at 192.168.1.10\n" +
      "    at start (https://admin:secret@192.168.1.10:443/player.js?token=abc)\n" +
      "    at version 1.2.3.4 (http://[2001:db8::1]/player.js?x=1)";
    telemetryError(source, { component: "player", errorType: "startup" });

    const [safeError, options] = faro.api.pushError.mock.calls[0];
    expect(safeError.name).toBe("PlayerError");
    expect(safeError.stack).toContain("at start");
    expect(safeError.stack).toContain("at version 1.2.3.4");
    expect(safeError.stack).not.toMatch(/admin|secret|192\.168\.1\.10|2001:db8|token=abc/);
    expect(safeError.stack).not.toContain("safeError");
    expect(options.context).toEqual({ component: "player", errorType: "startup" });
  });
});
