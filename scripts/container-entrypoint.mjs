import { spawn } from "node:child_process";

await import("./prepare-runtime.mjs");

const child = spawn(process.execPath, ["scripts/serve.mjs"], {
  env: process.env,
  stdio: "inherit",
});

function forward(signal) {
  if (!child.killed) child.kill(signal);
}

process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));
child.once("error", (error) => {
  console.error("Container entrypoint failed to start the viewer", error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
