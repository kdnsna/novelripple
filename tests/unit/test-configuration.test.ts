import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import playwrightConfig from "../../playwright.config";

describe("test isolation", () => {
  it("never reuses an existing local server for E2E", () => {
    expect(Array.isArray(playwrightConfig.webServer)).toBe(false);
    if (Array.isArray(playwrightConfig.webServer)) {
      throw new Error("M0 只应配置一个隔离的 Playwright web server");
    }

    expect(playwrightConfig.webServer?.reuseExistingServer).toBe(false);
  });

  it("migrates an empty local database before dev and production start", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.predev).toBe("npm run db:migrate");
    expect(packageJson.scripts?.prestart).toBe("npm run db:migrate");
    expect(packageJson.scripts?.pretypecheck).toBe("next typegen");
    expect(packageJson.scripts?.["db:migrate"]).toBe(
      "node --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx scripts/migrate.ts",
    );
  });
});
