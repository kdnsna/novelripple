import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("privacy configuration", () => {
  it("disables Server Function argument logging in development", async () => {
    const config = await readFile(
      path.join(process.cwd(), "next.config.ts"),
      "utf8",
    );

    // 静态读取配置，不导入 Next 内部模块；action 会收到原著正文，开发日志
    // 不得记录 Server Function 名称与参数值。
    expect(config).toMatch(/logging\s*:\s*\{[\s\S]*?serverFunctions\s*:\s*false/);
    expect(config).not.toMatch(/serverFunctions\s*:\s*true/);
  });
});
