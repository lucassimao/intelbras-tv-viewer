export const APP_IMAGE: string;
export const RELAY_CONFIG_IMAGE: string;
export function requireSourceMapApiKey(env?: NodeJS.ProcessEnv): void;
export function createBuildNonce(random?: (size: number) => Buffer): string;
export function buildCommands(nonce: string): Array<[string, string[]]>;
export function upCommand(): string[];
export function requiredImages(): string[];
export function projectRoot(): string;
export function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    spawnImpl?: (...args: never[]) => unknown;
    stdio?: "inherit" | "ignore";
  },
): Promise<number>;
export function runCommands(
  commands: Array<[string, string[]]>,
  options?: Parameters<typeof runCommand>[2],
): Promise<number>;
