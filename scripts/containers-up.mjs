import { requiredImages, runCommand, upCommand } from "./container-commands.mjs";

export async function main({ env = process.env, run = runCommand } = {}) {
  const dockerExitCode = await run("docker", ["info"], {
    env,
    stdio: "ignore",
  });
  if (dockerExitCode !== 0) {
    throw new Error("Docker is unavailable; start Docker Desktop or the Docker daemon first.");
  }

  for (const image of requiredImages()) {
    const exitCode = await run("docker", ["image", "inspect", image], {
      env,
      stdio: "ignore",
    });
    if (exitCode !== 0) {
      throw new Error(`Missing local image ${image}; run pnpm docker:build before docker:up.`);
    }
  }

  const exitCode = await run("docker", upCommand(), { env });
  if (exitCode !== 0) process.exitCode = exitCode;
  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
