import { expect, test } from "@playwright/test";

test("creates an idempotent worldline and restores it after refresh", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /改变一个选择/ }),
  ).toBeVisible();
  await page.getByRole("link", { name: /进入基准故事/ }).click();

  await expect(page.getByRole("heading", { name: "故事因果地图" })).toBeVisible();
  await page.getByTestId("event-node-event_07").click();
  await page.getByRole("button", { name: "改变这个节点" }).click();

  await expect(page.getByTestId("ripple-preview")).toBeVisible();
  await expect(page.getByText("Rerouted · 改道")).toBeVisible();
  await page
    .getByRole("button", { name: /确认影响并创建世界线/ })
    .click();

  const saved = page.getByRole("status");
  await expect(saved).toContainText("新世界线已保存");
  const worldlineId = await saved.locator("span").innerText();

  await page.reload();
  await expect(page.getByText("原著基线")).toBeVisible();
  await expect(page.getByText(worldlineId)).toBeVisible();
});

test("blocks an incompatible hard anchor before persistence", async ({ page }) => {
  await page.goto("/demo");
  await page.getByTestId("event-node-event_07").click();
  await page
    .getByRole("button", { name: /当场烧毁红色账簿/ })
    .click();
  await page.getByRole("button", { name: "改变这个节点" }).click();

  await expect(page.getByText("Incompatible · 不兼容")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /确认影响并创建世界线/ }),
  ).toBeDisabled();
});

test("shows the exact source evidence for a selected event", async ({ page }) => {
  await page.goto("/demo");
  await page.getByTestId("event-node-event_10").click();

  await expect(
    page.getByText(/锤壳里塞着一只密封玻璃管/),
  ).toBeVisible();
  await expect(page.getByText("Hash 已验证")).toBeVisible();
});
