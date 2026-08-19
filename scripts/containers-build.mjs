import {
  buildCommands,
  createBuildNonce,
  requireSourceMapApiKey,
  runCommands,
} from "./container-commands.mjs";

export async function main({ env = process.env, run = runCommands } = {}) {
  requireSourceMapApiKey(env);
  const nonce = createBuildNonce();
  const exitCode = await run(buildCommands(nonce), { env });
  if (exitCode !== 0) process.exitCode = exitCode;
  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
