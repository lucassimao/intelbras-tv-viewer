import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

const lanAddresses = Object.values(networkInterfaces())
  .flatMap((interfaces) => interfaces ?? [])
  .filter((address) => address.family === "IPv4" && !address.internal)
  .map((address) => address.address);

console.log("Intelbras TV Viewer development services");
console.log("  Local:   http://localhost:8080");
for (const address of lanAddresses) {
  console.log(`  LAN:     http://${address}:8080`);
}
console.log("  API:     loopback only (proxied as /api)");

const children = [
  spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
    env: process.env,
  }),
];

let shuttingDown = false;

function stopChildren(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 500);
}

for (const child of children) {
  child.once("error", (error) => {
    console.error("Development service failed to start", error);
    stopChildren(1);
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    const exitCode = code ?? (signal ? 1 : 0);
    if (exitCode !== 0) {
      console.error(`Development service stopped (${signal ?? `code ${exitCode}`})`);
      stopChildren(exitCode);
    }
  });
}

process.once("SIGINT", () => stopChildren());
process.once("SIGTERM", () => stopChildren());
