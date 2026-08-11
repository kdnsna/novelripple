import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const temporaryDirectory = mkdtempSync(
  path.join(tmpdir(), "novelripple-playwright-"),
);
const databasePath = path.join(temporaryDirectory, "playwright.db");
process.env.DB_FILE_NAME = databasePath;

try {
  console.log(`Playwright empty database path ready: ${databasePath}`);

  const result = spawnSync(
    process.execPath,
    [
      require.resolve("@playwright/test/cli"),
      "test",
      ...process.argv.slice(2),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_FILE_NAME: databasePath,
        AI_PROVIDER_NAME: "mock",
        OPENAI_MODEL: "mock-story-model",
        OPENAI_STRUCTURED_OUTPUT_MODE: "json_schema",
      },
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true });
}
