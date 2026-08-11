import { expect, test } from "@playwright/test";

test("creates a Project, imports a txt Source, and reads it after refresh", async ({
  page,
}) => {
  const projectTitle = `浏览器导入 ${Date.now()}`;
  const sourceText = "第一段：潮水退去。\r\n\r\n第二段：钟重新开始行走。";

  await page.goto("/");
  await page.getByRole("link", { name: "创建故事项目" }).click();
  await expect(
    page.getByRole("heading", { name: "创建故事项目" }),
  ).toBeVisible();

  await page.getByLabel("项目名称").fill(projectTitle);
  await page.getByRole("button", { name: "创建 Project" }).click();

  await expect(page.getByRole("heading", { name: projectTitle })).toBeVisible();
  await expect(page.getByText("尚未导入 Source")).toBeVisible();

  await page.getByLabel("故事文件").setInputFiles({
    name: "潮汐测试.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(sourceText, "utf8"),
  });
  await page.getByRole("button", { name: "导入 Source" }).click();

  await expect(page.getByRole("status")).toContainText("Source 导入成功");
  await expect(page.getByTestId("source-reader")).toContainText(
    "第一段：潮水退去。",
  );
  await expect(page.getByTestId("source-reader")).toContainText(
    "第二段：钟重新开始行走。",
  );

  const projectUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(projectUrl);
  await expect(page.getByTestId("source-reader")).toContainText(
    "第一段：潮水退去。",
  );

  await page.goto("/");
  await expect(page.getByRole("link", { name: projectTitle })).toBeVisible();
});
