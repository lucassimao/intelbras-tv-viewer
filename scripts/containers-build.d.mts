export function main(options?: {
  env?: NodeJS.ProcessEnv;
  run?: (
    commands: Array<[string, string[]]>,
    options?: { env?: NodeJS.ProcessEnv },
  ) => Promise<number>;
}): Promise<number>;
