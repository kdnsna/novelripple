import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import playwrightConfig from "../../playwright.config";

describe("test isolation", () => {
  it("keeps Playwright automation non-interactive and rejects test.only in CI", () => {
    expect(playwrightConfig.reporter).toEqual([
      ["html", { open: "never" }],
    ]);
    expect(playwrightConfig.forbidOnly).toBe(Boolean(process.env.CI));
  });

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

  it("defines the single Node 22 and Chromium M0 GitHub Actions gate", () => {
    const workflow = readFileSync(
      path.join(process.cwd(), ".github", "workflows", "m0.yml"),
      "utf8",
    );
    const commands = [
      "npm ci",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "npx playwright install --with-deps chromium",
      "CI=1 npm run test:e2e",
    ];

    expect(workflow).toContain("node-version: 22");
    expect(workflow).toMatch(/push:\s*[\s\S]*branches:\s*\[main\]/);
    expect(workflow).toMatch(/pull_request:\s*[\s\S]*branches:\s*\[main\]/);
    expect(workflow).toContain("if: failure()");
    expect(workflow).toContain("playwright-report/");
    expect(workflow).toContain("test-results/");
    expect(workflow).not.toContain("eval:live");
    // npm test 已包含单元与契约测试，CI 不重复执行 test:unit / test:contract。
    expect(workflow).not.toContain("run: npm run test:unit");
    expect(workflow).not.toContain("run: npm run test:contract");
    const commandPositions = commands.map((command) => workflow.indexOf(command));
    expect(commandPositions.every((position) => position >= 0)).toBe(true);
    expect(commandPositions).toEqual(
      [...commandPositions].sort((left, right) => left - right),
    );
  });

  it("provides a sanitized manual Live Eval review template", () => {
    const template = readFileSync(
      path.join(process.cwd(), "docs", "evals", "m0-live-review-template.md"),
      "utf8",
    );

    for (const required of [
      "Provider / model",
      "Commit SHA",
      "Prompt versions",
      "主要因果边认可率",
      "Unmatched Event 处置",
      "Continuation 正文矛盾检查",
      "最终结论：PASS / FAIL",
    ]) {
      expect(template).toContain(required);
    }
    expect(template).toContain("每个 source-backed unmatched Event");
    expect(template).toContain("不得粘贴 Source 正文、完整 Prompt、密钥或 raw model output");
  });
});
