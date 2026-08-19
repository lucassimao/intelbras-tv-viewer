import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_CAMERA_NAME_LENGTH } from "./camera-names.ts";

export type CameraNamesRepository = {
  getAll(): Record<string, string>;
  remove(cameraId: string): void;
  upsert(cameraId: string, name: string, updatedAt: string): void;
  close(): void;
};

export function createCameraNamesRepository(
  databasePath: string,
  cameraIds: ReadonlySet<string>,
): CameraNamesRepository {
  let database: DatabaseSync | undefined;
  let closed = false;

  function connection() {
    if (closed) throw new Error("camera_names_repository_closed");
    if (database) return database;
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    database = new DatabaseSync(databasePath, { timeout: 2_000, defensive: true });
    database.exec(`
      CREATE TABLE IF NOT EXISTS camera_names (
        camera_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_CAMERA_NAME_LENGTH}),
        updated_at TEXT NOT NULL
      ) STRICT
    `);
    return database;
  }

  return {
    getAll() {
      const rows = connection().prepare("SELECT camera_id, name FROM camera_names").all();
      const names: Record<string, string> = {};
      for (const row of rows) {
        if (
          typeof row.camera_id === "string" &&
          typeof row.name === "string" &&
          cameraIds.has(row.camera_id)
        ) {
          names[row.camera_id] = row.name;
        }
      }
      return names;
    },
    remove(cameraId) {
      connection().prepare("DELETE FROM camera_names WHERE camera_id = ?").run(cameraId);
    },
    upsert(cameraId, name, updatedAt) {
      connection()
        .prepare(`
          INSERT INTO camera_names (camera_id, name, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(camera_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
        `)
        .run(cameraId, name, updatedAt);
    },
    close() {
      if (closed) return;
      closed = true;
      database?.close();
      database = undefined;
    },
  };
}
