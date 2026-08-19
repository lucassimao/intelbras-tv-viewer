import type { Faro } from "@grafana/faro-web-sdk";

export const TELEMETRY_EVENT_NAMES = [
  "stream_requested",
  "first_frame",
  "stall_started",
  "stall_resolved",
  "player_retry",
  "player_error_terminal",
  "hls_error_fatal",
  "fullscreen_entered",
  "fullscreen_exited",
  "camera_changed",
  "profile_changed",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
export type TelemetryContext = {
  cameraId?: string;
  profileId?: string;
};
export type TelemetryAttributes = Record<string, string | number | boolean | undefined>;

type TelemetryState = "idle" | "disabled" | "loading" | "retrying" | "ready" | "failed";
type PendingItem =
  | { kind: "event"; name: TelemetryEventName; attributes: Record<string, string> }
  | {
      kind: "measurement";
      type: string;
      value: number;
      context: Record<string, string>;
    }
  | {
      kind: "error";
      error: Error;
      context: Record<string, string>;
      fatal: boolean;
    };

const MAX_PENDING_ITEMS = 32;
// One immediate attempt followed by two bounded retries. Keeping the retry
// timer in this module means StrictMode/concurrent callers share one attempt
// sequence instead of creating import storms.
const MAX_INIT_ATTEMPTS = 3;
const INIT_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const DEFAULT_APP_NAME = "intelbras-tv-viewer";
const DEFAULT_ENVIRONMENT = "local";
const DEFAULT_VERSION = "dev";
// Tracing must never follow requests that can identify a camera, expose a
// relay path, or reach the private bridge. Faro's tracing package forwards
// these patterns to both fetch and XHR instrumentation.
const TRACE_IGNORE_URLS = [
  /(?:^|\/\/)(?:localhost|127\.0\.0\.1|10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|\[[0-9a-f:]+\])(?::\d+)?(?:\/|$)/i,
  /(?:^|\/\/)[^/]+:8888(?:\/|$)/i,
  /\/api\/(?:ptz|snapshots|cameras|reliability)(?:\/|$|[?#])/i,
  /(?:^|\/)cam-[^/?#]+(?:\/|$|[?#])/i,
];
let state: TelemetryState = "idle";
let faro: Faro | null = null;
let initPromise: Promise<void> | null = null;
let pendingItems: PendingItem[] = [];
let environmentOverrideForTests: Record<string, unknown> | undefined;
let initGeneration = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryResolver: (() => void) | null = null;

function envValue(name: string): string | undefined {
  const env =
    environmentOverrideForTests ??
    (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  const value = env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function telemetryConfig() {
  const url = envValue("VITE_FARO_URL");
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }

  return {
    url,
    apiKey: envValue("VITE_FARO_APP_KEY"),
    appName: envValue("VITE_FARO_APP_NAME") ?? DEFAULT_APP_NAME,
    environment: envValue("VITE_FARO_ENVIRONMENT") ?? DEFAULT_ENVIRONMENT,
    version: envValue("VITE_APP_VERSION") ?? DEFAULT_VERSION,
  };
}
function stringAttributes(attributes: TelemetryAttributes | undefined) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined) continue;
    result[key] = String(value);
  }
  return result;
}

function contextAttributes(context: TelemetryContext | undefined) {
  return stringAttributes({
    cameraId: context?.cameraId,
    profileId: context?.profileId,
  });
}

function enqueue(item: PendingItem) {
  if (pendingItems.length >= MAX_PENDING_ITEMS) pendingItems.shift();
  pendingItems.push(item);
}

function dispatch(item: PendingItem) {
  if (!faro) return;
  try {
    if (item.kind === "event") {
      faro.api.pushEvent(item.name, item.attributes);
    } else if (item.kind === "measurement") {
      faro.api.pushMeasurement({
        type: item.type,
        values: { value: item.value },
        context: item.context,
      });
    } else {
      faro.api.pushError(item.error, {
        context: item.context,
        fatal: item.fatal,
      });
    }
  } catch {
    // Telemetry is strictly fail-open. A broken collector must not affect video.
  }
}

function flush() {
  const queued = pendingItems;
  pendingItems = [];
  queued.forEach(dispatch);
}

function waitForRetry(delayMs: number, generation: number) {
  return new Promise<void>((resolve) => {
    retryResolver = resolve;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryResolver = null;
      resolve();
    }, delayMs);
  }).then(() => {
    // resetTelemetryForTests can cancel a pending timer while an old
    // initialization is still awaiting it. The generation check in the
    // caller makes that stale run a no-op.
    if (generation !== initGeneration) return;
  });
}

async function initializeWithRetries(
  config: NonNullable<ReturnType<typeof telemetryConfig>>,
  generation: number,
) {
  for (let attempt = 0; attempt < MAX_INIT_ATTEMPTS; attempt += 1) {
    try {
      const [{ getWebInstrumentations, initializeFaro }, { TracingInstrumentation }] =
        await Promise.all([import("@grafana/faro-web-sdk"), import("@grafana/faro-web-tracing")]);
      if (generation !== initGeneration) return;
      const webInstrumentations = getWebInstrumentations({
        captureConsole: false,
        enablePerformanceInstrumentation: false,
        enableContentSecurityPolicyInstrumentation: false,
      }).filter((instrumentation) => !instrumentation.name.includes("user-action"));
      const instance = initializeFaro({
        url: config.url,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        app: {
          name: config.appName,
          version: config.version,
          environment: config.environment,
        },
        ignoreUrls: TRACE_IGNORE_URLS,
        // Do not propagate trace headers to arbitrary cross-origin resources.
        // Private bridge/HLS requests are ignored above and never receive a
        // camera-bearing trace context.
        instrumentations: [
          ...webInstrumentations,
          new TracingInstrumentation({
            instrumentationOptions: { propagateTraceHeaderCorsUrls: [] },
          }),
        ],
        trackResources: false,
        preventGlobalExposure: true,
        batching: { enabled: true, itemLimit: 20, sendTimeout: 5_000 },
      });
      if (!instance) throw new Error("faro_initialization_failed");
      faro = instance;
      state = "ready";
      flush();
      return;
    } catch {
      if (generation !== initGeneration) return;
      faro = null;
      if (attempt === MAX_INIT_ATTEMPTS - 1) {
        state = "failed";
        // Nothing can consume these items after the terminal state. Dropping
        // them here also prevents retaining arbitrary error/context objects.
        pendingItems = [];
        return;
      }
      state = "retrying";
      await waitForRetry(INIT_RETRY_DELAYS_MS[attempt], generation);
      if (generation !== initGeneration) return;
      state = "loading";
    }
  }
}

export function initTelemetry(): Promise<void> {
  if (initPromise) return initPromise;
  const config = telemetryConfig();
  if (!config) {
    state = "disabled";
    pendingItems = [];
    initPromise = Promise.resolve();
    return initPromise;
  }
  if (state === "failed") return Promise.resolve();

  state = "loading";
  const generation = initGeneration;
  initPromise = initializeWithRetries(config, generation);
  return initPromise;
}

export function telemetryEvent(
  name: TelemetryEventName,
  attributes?: TelemetryAttributes,
  context?: TelemetryContext,
) {
  const item: PendingItem = {
    kind: "event",
    name,
    attributes: { ...contextAttributes(context), ...stringAttributes(attributes) },
  };
  if (state === "ready") dispatch(item);
  else if (state === "loading" || state === "retrying") enqueue(item);
}

export function telemetryMeasurement(type: string, value: number, context?: TelemetryContext) {
  if (!Number.isFinite(value) || value < 0) return;
  const item: PendingItem = {
    kind: "measurement",
    type,
    value: Math.round(value),
    context: contextAttributes(context),
  };
  if (state === "ready") dispatch(item);
  else if (state === "loading" || state === "retrying") enqueue(item);
}

export function telemetryError(
  error: unknown,
  context?: TelemetryContext & { component?: string; errorType?: string },
  fatal = false,
) {
  const item: PendingItem = {
    kind: "error",
    error: error instanceof Error ? error : new Error(String(error)),
    context: stringAttributes(context),
    fatal,
  };
  if (state === "ready") dispatch(item);
  else if (state === "loading" || state === "retrying") enqueue(item);
}

export function telemetryState() {
  return state;
}

export function telemetryPendingCountForTests() {
  return pendingItems.length;
}

/** Test-only reset hook; no network or external state is touched. */
export function resetTelemetryForTests() {
  initGeneration += 1;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryResolver?.();
  retryResolver = null;
  faro = null;
  state = "idle";
  initPromise = null;
  pendingItems = [];
  environmentOverrideForTests = undefined;
}

export function setTelemetryEnvForTests(values: Record<string, unknown>) {
  environmentOverrideForTests = values;
}
