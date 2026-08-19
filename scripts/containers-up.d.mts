export function main(options?: {
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<number>;
}): Promise<number>;
