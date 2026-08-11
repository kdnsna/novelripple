import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";

import {
  closeDatabase,
  getDatabase,
  getDatabasePath,
} from "../src/server/db/client";

try {
  migrate(getDatabase(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
  console.log(`Database ready: ${getDatabasePath()}`);
} finally {
  closeDatabase();
}
