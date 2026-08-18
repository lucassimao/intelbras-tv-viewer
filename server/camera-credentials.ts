import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type CameraCredentials = {
  username: string;
  password: string;
};

const DEFAULT_PASSWORD_FILE = resolve(import.meta.dirname, "../runtime/camera-password.txt");

function passwordFromContents(contents: string, source: string) {
  const candidate = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!candidate) throw new Error(`No camera password found in ${source}`);
  if (candidate.startsWith("password=")) return candidate.slice("password=".length);
  if (candidate.startsWith("rtsp://")) {
    try {
      const password = new URL(candidate).password;
      if (password) return decodeURIComponent(password);
    } catch {
      // Fall through to the raw candidate error below.
    }
  }
  return candidate;
}

export async function loadCameraCredentials(): Promise<CameraCredentials> {
  const source = process.env.CAMERA_PASSWORD_FILE ?? DEFAULT_PASSWORD_FILE;
  const password = passwordFromContents(await readFile(source, "utf8"), source);
  const username = process.env.CAMERA_USERNAME ?? "admin";
  if (!/^[\u0021-\u007e]+$/.test(username) || !password) {
    throw new Error("Invalid camera credentials configuration");
  }
  return { username, password };
}
