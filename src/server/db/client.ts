import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

import * as schema from "./schema";

type AppDatabase = ReturnType<typeof drizzle<typeof schema>>;

let database: AppDatabase | undefined;
let sqlite: Database.Database | undefined;

export function getDatabasePath(): string {
  const configuredPath = process.env.DB_FILE_NAME;
  if (configuredPath && path.isAbsolute(configuredPath)) return configuredPath;

  const fileName = configuredPath
    ? path.basename(configuredPath)
    : "novelripple.db";
  return path.join(process.cwd(), ".data", fileName);
}

export function getDatabase(): AppDatabase {
  if (database) return database;

  const databasePath = getDatabasePath();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  database = drizzle(sqlite, { schema });
  return database;
}

export function closeDatabase(): void {
  sqlite?.close();
  sqlite = undefined;
  database = undefined;
}
