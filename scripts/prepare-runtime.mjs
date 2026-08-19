import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const legacyFile = "/legacy-runtime/cameras.sqlite";
const databaseFile = process.env.CAMERA_DB_PATH ?? "/app/runtime/cameras.sqlite";

await mkdir(dirname(databaseFile), { recursive: true });

try {
  await access(databaseFile);
} catch {
  try {
    await access(legacyFile);
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${legacyFile}${suffix}`;
      try {
        await access(source);
        await copyFile(source, `${databaseFile}${suffix}`);
      } catch {
        // SQLite auxiliary files are optional and may not exist.
      }
    }
    await chmod(databaseFile, 0o600);
    console.log("Migrated the existing runtime SQLite database into the Docker volume.");
  } catch {
    // A fresh installation has no legacy database to migrate.
  }
}
