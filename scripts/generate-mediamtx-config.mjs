import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const outputIndex = process.argv.indexOf("--output");
const outputFromArgs =
  outputArgument?.slice("--output=".length) ??
  (outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined);
if ((outputIndex >= 0 || outputArgument) && !outputFromArgs) {
  throw new Error("--output requires a file path");
}
const outputFile = resolve(
  outputFromArgs ??
    process.env.MEDIAMTX_OUTPUT_FILE ??
    resolve(projectRoot, "runtime/mediamtx.yml"),
);
const username = process.env.CAMERA_USERNAME ?? "admin";
const password = process.env.CAMERA_PASSWORD;
if (!password) {
  throw new Error("CAMERA_PASSWORD is required to generate the MediaMTX configuration");
}
const profilesFile = resolve(projectRoot, "src/config/stream-profiles.json");
const inventoryFile = resolve(projectRoot, "src/config/camera-inventory.json");

const streamProfiles = JSON.parse(await readFile(profilesFile, "utf8"));
const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));

function safePathSegment(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, _ or -: ${String(value)}`);
  }
  return value;
}

if (!Array.isArray(streamProfiles) || streamProfiles.length === 0) {
  throw new Error(`No stream profiles found in ${profilesFile}`);
}

const profilePaths = new Set();
for (const profile of streamProfiles) {
  safePathSegment(profile.id, "Stream profile id");
  if (!Number.isInteger(profile.subtype) || profile.subtype < 0) {
    throw new Error(
      `Stream profile subtype must be a non-negative integer: ${String(profile.subtype)}`,
    );
  }
  if (
    typeof profile.pathSuffix !== "string" ||
    !/^$|^--[a-z0-9][a-z0-9_-]*$/i.test(profile.pathSuffix)
  ) {
    throw new Error(`Invalid stream profile path suffix: ${String(profile.pathSuffix)}`);
  }
}

function yamlString(value) {
  return JSON.stringify(value);
}

function validateInventory(rawInventory) {
  if (!Array.isArray(rawInventory) || rawInventory.length !== 12) {
    throw new Error(`Camera inventory must contain exactly 12 cameras: ${inventoryFile}`);
  }
  const defaults = rawInventory.filter((camera) => camera && camera.isDefault === true);
  if (defaults.length !== 1) {
    throw new Error(`Camera inventory must contain exactly one default camera: ${inventoryFile}`);
  }

  const ids = new Set();
  const ips = new Set();
  const paths = new Set();
  const shortcuts = new Set();
  for (const camera of rawInventory) {
    if (!camera || typeof camera !== "object")
      throw new Error("Camera inventory entries must be objects");
    if (typeof camera.id !== "string" || !/^cam-[a-z0-9-]+$/i.test(camera.id) || ids.has(camera.id))
      throw new Error(`Invalid or duplicate camera id: ${String(camera.id)}`);
    if (
      typeof camera.ip !== "string" ||
      !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(camera.ip) ||
      camera.ip.split(".").some((octet) => Number(octet) > 255) ||
      ips.has(camera.ip)
    )
      throw new Error(`Invalid or duplicate camera IP: ${String(camera.ip)}`);
    if (
      typeof camera.streamPath !== "string" ||
      !/^[a-z0-9][a-z0-9_-]*$/i.test(camera.streamPath) ||
      paths.has(camera.streamPath)
    )
      throw new Error(`Invalid or duplicate camera path: ${String(camera.streamPath)}`);
    if (
      typeof camera.shortcut !== "string" ||
      !/^\d+$/.test(camera.shortcut) ||
      shortcuts.has(camera.shortcut)
    )
      throw new Error(`Invalid or duplicate camera shortcut: ${String(camera.shortcut)}`);
    if (camera.availability !== "available" && camera.availability !== "locked")
      throw new Error(`Invalid availability for ${camera.id}`);
    if (
      camera.ptz !== undefined &&
      (!camera.ptz || typeof camera.ptz !== "object" || camera.ptz.directions !== true)
    )
      throw new Error(`Invalid PTZ capability for ${camera.id}`);
    ids.add(camera.id);
    ips.add(camera.ip);
    paths.add(camera.streamPath);
    shortcuts.add(camera.shortcut);
  }
  const available = rawInventory.filter((camera) => camera.availability === "available");
  if (available.length === 0)
    throw new Error("Camera inventory must contain at least one available camera");
  if (defaults[0].availability !== "available")
    throw new Error(`The default camera must be available: ${defaults[0].id}`);
  return available;
}

const cameras = validateInventory(inventory).map((camera) => ({
  path: camera.streamPath,
  ip: camera.ip,
}));

const encodedUsername = encodeURIComponent(username);
const encodedPassword = encodeURIComponent(password);

const paths = cameras
  .flatMap(({ path, ip }) => {
    safePathSegment(path, "Camera path");

    return streamProfiles.map((profile) => {
      const profilePath = `${path}${profile.pathSuffix}`;
      if (profilePaths.has(profilePath)) throw new Error(`Duplicate MediaMTX path: ${profilePath}`);
      profilePaths.add(profilePath);

      const source = `rtsp://${encodedUsername}:${encodedPassword}@${ip}:554/cam/realmonitor?channel=1&subtype=${profile.subtype}`;
      return `  ${profilePath}:\n    source: ${yamlString(source)}`;
    });
  })
  .join("\n");

const expectedPathCount = cameras.length * streamProfiles.length;
if (profilePaths.size !== expectedPathCount) {
  throw new Error(`Expected ${expectedPathCount} relay paths, generated ${profilePaths.size}`);
}
const config = `# Generated locally. Contains camera credentials; never commit this file.
logLevel: info
rtsp: true
rtspAddress: :8554
rtspTransports: [tcp]
rtmp: false
webrtc: false
srt: false
moq: false
hls: true
hlsAddress: :8888
hlsAllowOrigins: ["*"]
hlsVariant: mpegts
hlsSegmentCount: 6
hlsSegmentDuration: 1s
api: true
apiAddress: :9997
apiAllowOrigins: ["http://127.0.0.1:8787", "http://localhost:8787"]
metrics: true
metricsAddress: :9998

authInternalUsers:
  - user: any
    pass:
    ips: []
    permissions:
      - action: read
        path:
      - action: playback
        path:
  # The API/metrics listeners are mapped to host loopback in compose. The
  # Docker bridge range is the only non-loopback source allowed here.
  - user: any
    pass:
    ips: ["127.0.0.1", "::1", "172.16.0.0/12"]
    permissions:
      - action: api
        path:
      - action: metrics
        path:

pathDefaults:
  sourceOnDemand: true
  sourceOnDemandStartTimeout: 12s
  sourceOnDemandCloseAfter: 10s
  rtspTransport: tcp

paths:
${paths}
`;

await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
await writeFile(outputFile, config, { encoding: "utf8", mode: 0o600 });
await chmod(outputFile, 0o600);

console.log(
  `Generated ${outputFile} for ${cameras.length} available cameras and ${streamProfiles.length} stream profiles (${profilePaths.size} paths).`,
);
