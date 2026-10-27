import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { databaseFilePath, migrationsDirectory } from './paths';

const BOOKKEEPING_TABLE = '_easyreporter_migrations';
const REQUIRED_TABLES = ['AiModel', 'DbConnection'] as const;

async function tableExists(
  client: ReturnType<typeof createClient>,
  name: string,
): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [name],
  });
  return result.rows.length > 0;
}

/**
 * Applies bundled Prisma migrations to the user's local database. Packaged
 * builds have no Prisma CLI, so this small runner owns first-run setup.
 */
export async function runMigrations(): Promise<void> {
  const databaseFile = databaseFilePath();
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });

  const directory = migrationsDirectory();
  if (!fs.existsSync(directory)) {
    throw new Error(
      `No migration directory found at ${directory}. The local database cannot be prepared.`,
    );
  }

  const names = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (names.length === 0) {
    throw new Error(`Migration directory is empty: ${directory}`);
  }

  console.info(`[migrations] database=${databaseFile}`);
  console.info(`[migrations] directory=${directory}`);

  const client = createClient({ url: pathToFileURL(databaseFile).href, intMode: 'bigint' });

  try {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS "${BOOKKEEPING_TABLE}" (name TEXT NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL)`,
    );

    const appliedRows = await client.execute(`SELECT name FROM "${BOOKKEEPING_TABLE}"`);
    const applied = new Set(appliedRows.rows.map((row) => String(row[0])));

    if (await tableExists(client, '_prisma_migrations')) {
      const baseline = await client.execute(
        'SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
      );
      for (const row of baseline.rows) {
        const name = String(row[0]);
        if (applied.has(name)) continue;
        await client.execute({
          sql: `INSERT OR IGNORE INTO "${BOOKKEEPING_TABLE}" (name, applied_at) VALUES (?, ?)`,
          args: [name, String(row[1] ?? new Date().toISOString())],
        });
        applied.add(name);
      }
    }

    for (const name of names) {
      if (applied.has(name)) continue;
      const sqlPath = path.join(directory, name, 'migration.sql');
      if (!fs.existsSync(sqlPath)) continue;

      const sql = fs.readFileSync(sqlPath, 'utf8');
      const transaction = await client.transaction('write');
      try {
        await transaction.executeMultiple(sql);
        await transaction.execute({
          sql: `INSERT INTO "${BOOKKEEPING_TABLE}" (name, applied_at) VALUES (?, ?)`,
          args: [name, new Date().toISOString()],
        });
        await transaction.commit();
        console.info(`[migrations] applied ${name}`);
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw new Error(
          `Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      applied.add(name);
    }

    for (const table of REQUIRED_TABLES) {
      if (!(await tableExists(client, table))) {
        throw new Error(
          `Database at ${databaseFile} is missing table "${table}" after migrations. Delete the file and restart, or run npm run db:migrate.`,
        );
      }
    }
  } finally {
    client.close();
  }
}
