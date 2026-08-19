import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const host = process.env.TV_HOST ?? "0.0.0.0";
const port = Number(process.env.TV_PORT ?? 8080);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const api = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
  env: { ...process.env, CAMERA_API_HOST: "127.0.0.1", CAMERA_API_PORT: "8787" },
  stdio: "inherit",
});

function safePath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://tv.local").pathname);
  // Hidden source maps are retained for a private release upload only; never
  // serve them from the LAN viewer.
  if (pathname.endsWith(".map")) return null;
  const relative = pathname === "/" ? "/index.html" : pathname;
  const candidate = resolve(join(root, `.${normalize(relative)}`));
  return candidate.startsWith(`${root}/`) ? candidate : null;
}

const server = createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400).end();
    return;
  }
  const requestPath = new URL(request.url, "http://tv.local").pathname;
  if (requestPath.endsWith(".map")) {
    response.writeHead(404, { "Cache-Control": "no-store" }).end();
    return;
  }
  if (request.url.startsWith("/api/")) {
    const apiMethods = new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]);
    if (!request.method || !apiMethods.has(request.method)) {
      response.writeHead(405, { Allow: [...apiMethods].join(", ") }).end();
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: 8787,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: "127.0.0.1:8787" },
      },
      (apiResponse) => {
        response.writeHead(apiResponse.statusCode ?? 502, apiResponse.headers);
        apiResponse.pipe(response);
      },
    );
    upstream.once("error", () => response.writeHead(502).end("Local API unavailable"));
    request.pipe(upstream);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const requested = safePath(request.url);
  const filePath =
    requested && (await stat(requested).catch(() => null)) ? requested : join(root, "index.html");
  const contentType = mimeTypes[extname(filePath)] ?? "application/octet-stream";
  response.writeHead(200, {
    "Cache-Control": filePath.endsWith("index.html")
      ? "no-store"
      : "public, max-age=31536000, immutable",
    "Content-Type": contentType,
    "X-Viewer-Build": "adaptive-production",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Intelbras TV Viewer production server: http://${host}:${port}`);
  console.log(`Serving the adaptive modern + legacy production build from ${root}`);
  console.log("Same-origin /api requests proxy to the loopback camera-name and telemetry API.");
});

process.once("SIGINT", () => server.close(() => process.exit(0)));
process.once("SIGTERM", () => server.close(() => process.exit(0)));
process.once("exit", () => api.kill("SIGTERM"));
