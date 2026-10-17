import { expect, test } from "@playwright/test";
import path from "node:path";

test("shows resumable Story Map job progress across refresh and opens the candidate map", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: /创建故事项目/ }).click();
  await page.getByLabel("项目名称").fill(`后台生成进度 ${Date.now()}`);
  await page.getByRole("button", { name: "创建 Project" }).click();
  await page.getByLabel("故事文件").setInputFiles(
    path.join(process.cwd(), "fixtures/ripple-001/source.md"),
  );
  await page.getByRole("button", { name: "导入 Source" }).click();
  await expect(page.getByRole("status")).toContainText("Source 导入成功");

  await page.getByRole("button", { name: "生成 Story Map" }).click();

  const progress = page.getByTestId("story-map-job-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute(
    "data-job-status",
    /queued|running|succeeded/,
  );

  // fixture provider 很快完成：刷新时任务可能仍在跑（继续显示进度），也可能已结束
  // （页面直接打开新 Artifact）。两种情况都必须最终到达同一张候选 Story Map。
  await page.reload();
  await expect(page.getByText("Story Map v1 · draft")).toBeVisible({
    timeout: 15_000,
  });
});
