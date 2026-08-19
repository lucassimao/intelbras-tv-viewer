import { afterEach, describe, expect, it, vi } from "vitest";
import { createReliabilityService } from "../server/reliability-service.ts";

describe("reliability service", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not attribute aggregate RTSP metrics to individual paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/metrics")
          ? new Response(
              'rtsp_sessions_inbound_rtp_packets_lost{session="aggregate"} 3\n' +
                'rtsp_sessions_inbound_rtp_packets_jitter{session="aggregate"} 4\n',
            )
          : new Response(JSON.stringify({ items: [] }), {
              headers: { "Content-Type": "application/json" },
            }),
      ),
    );
    const service = createReliabilityService({
      apiUrl: "http://mediamtx.test",
      metricsUrl: "http://mediamtx.test/metrics",
    });

    await service.refresh();

    expect(service.snapshot().cameras.every((camera) => camera.packetLossPct === null)).toBe(true);
    expect(service.snapshot().cameras.every((camera) => camera.jitterMs === null)).toBe(true);
    service.stop();
  });
});
