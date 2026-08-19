import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const APP_IMAGE = "intelbras-tv-viewer:local";
export const RELAY_CONFIG_IMAGE = "intelbras-tv-viewer:init";

const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export function requireSourceMapApiKey(env = process.env) {
  if (!env.FARO_SOURCE_MAP_API_KEY?.trim()) {
    throw new Error(
      "FARO_SOURCE_MAP_API_KEY is required for docker:build; set it in the ignored .env file.",
    );
  }
}

export function createBuildNonce(random = randomBytes) {
  return random(16).toString("hex");
}

export function buildCommands(nonce) {
  if (!nonce || !/^[a-z0-9-]+$/i.test(nonce)) {
    throw new Error("A non-secret Docker build nonce is required.");
  }

  const args = ["compose", "build", "--build-arg", `FARO_UPLOAD_NONCE=${nonce}`];
  return [
    ["docker", [...args, "app"]],
    ["docker", [...args, "relay-config"]],
  ];
}

export function upCommand() {
  return ["compose", "up", "-d", "--no-build", "--pull", "never"];
}

export function requiredImages() {
  return [APP_IMAGE, RELAY_CONFIG_IMAGE];
}

export function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function runCommand(
  command,
  args,
  { cwd = projectRoot(), env = process.env, spawnImpl = spawn, stdio = "inherit" } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        shell: false,
        stdio,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let forwardedSignal;
    const signalHandlers = Object.keys(SIGNAL_EXIT_CODES).map((signal) => {
      const handler = () => {
        forwardedSignal = signal;
        child.kill(signal);
      };
      process.once(signal, handler);
      return [signal, handler];
    });

    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    };

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolve(
        forwardedSignal
          ? SIGNAL_EXIT_CODES[forwardedSignal]
          : signal
            ? (SIGNAL_EXIT_CODES[signal] ?? 1)
            : (code ?? 1),
      );
    });
  });
}

export async function runCommands(commands, options) {
  for (const [command, args] of commands) {
    const exitCode = await runCommand(command, args, options);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}
