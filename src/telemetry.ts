import type { APIEvent, Faro, TransportItem, TransportItemPayload } from "@grafana/faro-web-sdk";

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
const SENSITIVE_KEY =
  /(?:url|uri|href|src|body|headers?|password|passwd|secret|token|credential|authorization|cookie|ip)/i;
const URL_VALUE = /(?:[a-z][a-z\d+.-]*):\/\/[^\s"'<>]+|\/\/[^\s"'<>]+/gi;
const IPV4_VALUE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const QUERY_VALUE = /([?&#])[^\s"'<>]*/g;
const SECRET_VALUE =
  /((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi;

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
    appName: sanitizePlainText(envValue("VITE_FARO_APP_NAME") ?? DEFAULT_APP_NAME, 80),
    environment: sanitizePlainText(envValue("VITE_FARO_ENVIRONMENT") ?? DEFAULT_ENVIRONMENT, 40),
    version: sanitizePlainText(envValue("VITE_APP_VERSION") ?? DEFAULT_VERSION, 80),
  };
}

export function sanitizePlainText(value: string, maxLength = 160) {
  const withoutControls = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("");
  return withoutControls
    .replace(URL_VALUE, "[redacted-url]")
    .replace(IPV4_VALUE, (candidate: string, offset: number, source: string) =>
      shouldRedactIpv4(candidate, source, offset) ? "[redacted-ip]" : candidate,
    )
    .replace(IPV6_VALUE, (candidate) => (isIpv6(candidate) ? "[redacted-ip]" : candidate))
    .replace(QUERY_VALUE, "$1[redacted-query]")
    .replace(SECRET_VALUE, "$1[redacted]")
    .slice(0, maxLength);
}

const IPV6_VALUE =
  /\[[0-9a-f:.]+(?:%[0-9a-z_.-]+)?\]|(?<![a-z0-9])[0-9a-f:.%]*:[0-9a-f:.%]+(?![a-z0-9])/gi;

function shouldRedactIpv4(candidate: string, source: string, offset: number) {
  const octets = candidate.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
    return false;
  }

  // A dotted build/version identifier is not a network address. URLs have
  // already been removed above, so this narrow exception avoids changing
  // ordinary release text while retaining standalone IP redaction.
  return (
    !/(?:\bversion|\brelease|\bbuild|\bv)\s*(?:[=:-]\s*)?$/i.test(
      source.slice(Math.max(0, offset - 20), offset),
    ) && !/^\s*\.\d+\b/.test(source.slice(offset + candidate.length))
  );
}

function isIpv6(value: string) {
  const candidate = value.replace(/^\[|\]$/g, "").split("%", 1)[0];
  if (!candidate || (candidate.match(/::/g) ?? []).length > 1) return false;

  const hasCompression = candidate.includes("::");
  const [left, right = ""] = candidate.split("::");
  const groups = [...(left ? left.split(":") : []), ...(right ? right.split(":") : [])];
  if (
    groups.some((group, index) => {
      if (/^[0-9a-f]{1,4}$/i.test(group)) return false;
      if (!group.includes(".") || index !== groups.length - 1) return true;
      const octets = group.split(".").map(Number);
      return octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255);
    })
  )
    return false;

  const groupCount = groups.reduce((count, group) => {
    if (group.includes(".")) return count + 2;
    return count + 1;
  }, 0);
  return hasCompression ? groupCount < 8 : groupCount === 8;
}

function safeKey(key: string) {
  return SENSITIVE_KEY.test(key) ? null : key.slice(0, 80);
}

/**
 * Faro's default metadata includes the current page URL. Keep the collector
 * useful while ensuring RTSP/HLS URLs, local IPs and credentials never leave
 * the browser, including in an automatically captured exception stack.
 */
export function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return sanitizePlainText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value))
    return value.slice(0, 32).map((item) => sanitizeUnknown(item, depth + 1));
  if (typeof value !== "object") return String(value);

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const cleanKey = safeKey(key);
    if (!cleanKey) continue;
    result[cleanKey] = sanitizeUnknown(item, depth + 1);
  }
  return result;
}

function sanitizeAttributes(attributes: TelemetryAttributes | undefined) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    const cleanKey = safeKey(key);
    if (!cleanKey || value === undefined) continue;
    result[cleanKey] = sanitizePlainText(String(value), 120);
  }
  return result;
}

function contextAttributes(context: TelemetryContext | undefined) {
  return sanitizeAttributes({
    cameraId: context?.cameraId,
    profileId: context?.profileId,
  });
}

function safeError(error: unknown) {
  const source = error instanceof Error ? error : new Error(String(error));
  const safe = new Error(sanitizePlainText(source.message || "unknown_error"));
  safe.name = sanitizePlainText(source.name || "Error", 80);
  if (source.stack) safe.stack = sanitizePlainText(source.stack, 8_000);
  return safe;
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

function beforeSend(item: TransportItem<APIEvent>): TransportItem<APIEvent> | null {
  const meta = sanitizeUnknown(item.meta) as typeof item.meta;
  const payload = sanitizeUnknown(item.payload) as TransportItemPayload<APIEvent>;
  return { ...item, meta, payload };
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
        // Keep capture opt-in and privacy-first. There is no session replay in
        // this configuration, and console/user-action/resource instrumentation
        // is disabled so custom camera names cannot become telemetry.
        beforeSend,
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
    attributes: { ...contextAttributes(context), ...sanitizeAttributes(attributes) },
  };
  if (state === "ready") dispatch(item);
  else if (state === "loading" || state === "retrying") enqueue(item);
}

export function telemetryMeasurement(type: string, value: number, context?: TelemetryContext) {
  if (!Number.isFinite(value) || value < 0) return;
  const item: PendingItem = {
    kind: "measurement",
    type: sanitizePlainText(type, 80),
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
    error: safeError(error),
    context: sanitizeAttributes(context),
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
