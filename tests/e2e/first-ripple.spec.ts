import { expect, test } from "@playwright/test";

test("shows the minimal empty-project home", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("NovelRipple", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/NovelRipple 把完成的小说变成一张/),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    /当前(?:没有故事项目|有 \d+ 个故事项目)/,
  );
  await expect(
    page.getByRole("link", { name: "创建故事项目" }),
  ).toBeVisible();
});

test("does not expose the legacy demo write path", async ({ page }) => {
  const response = await page.goto("/demo");

  expect(response?.status()).toBe(404);
});
