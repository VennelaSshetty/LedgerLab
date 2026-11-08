import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { migrationPool } from "./migration-pool";

async function runMigrations(): Promise<void> {
  const migrationsDirectory = path.resolve(process.cwd(), "migrations");

  // Track migrations that have already been executed.
  await migrationPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migrations found.");
    return;
  }

  for (const file of files) {
    const result = await migrationPool.query(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      [file]
    );

    if (result.rowCount && result.rowCount > 0) {
      console.log(`Already applied: ${file}`);
      continue;
    }

    const sql = await readFile(
      path.join(migrationsDirectory, file),
      "utf-8"
    );

    const client = await migrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(sql);

      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file]
      );

      await client.query("COMMIT");

      console.log(`Successfully applied: ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

runMigrations()
  .catch((error: unknown) => {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await migrationPool.end();
  });