import { serve } from "@hono/node-server";
import { CAMERAS } from "../src/config/cameras.ts";
import { createApp } from "./app.ts";
import { loadCameraCredentials, loadServerConfig } from "./config.ts";
import { createCameraNamesRepository } from "./camera-names-repository.ts";
import { createDigestPtzTransport, PtzController } from "./ptz.ts";
import { createReliabilityService } from "./reliability-service.ts";
import { createSnapshotService } from "./snapshot-service.ts";

const config = loadServerConfig();
const cameraIds = new Set(CAMERAS.map((camera) => camera.id));
const names = createCameraNamesRepository(config.databasePath, cameraIds);
const snapshots = createSnapshotService({
  ffmpeg: config.snapshotFfmpeg,
  rtspOrigin: config.snapshotRtspOrigin,
});
const reliability = createReliabilityService({
  apiUrl: config.mediamtxApiUrl,
  metricsUrl: config.mediamtxMetricsUrl,
});
let ptzController: PtzController | undefined;
const getPtzController = async () => {
  if (ptzController) return ptzController;
  const credentials = loadCameraCredentials();
  ptzController = new PtzController(CAMERAS, createDigestPtzTransport(credentials));
  return ptzController;
};
const app = createApp({ cameraIds, names, snapshots, reliability, getPtzController });

reliability.start();
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Camera name API listening on http://${info.address}:${info.port}`);
  console.log(`Camera names database: ${config.databasePath}`);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  reliability.stop();
  snapshots.stop();
  names.close();
  const stopPtz = ptzController?.stopAll() ?? Promise.resolve();
  void stopPtz.finally(() => server.close());
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
