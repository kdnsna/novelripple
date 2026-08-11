import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

async function createConfirmedFixtureProject(page: Page, title: string) {
  await page.goto("/");
  await page.getByRole("link", { name: /创建故事项目/ }).click();
  await page.getByLabel("项目名称").fill(title);
  await page.getByRole("button", { name: "创建 Project" }).click();
  await page.getByLabel("故事文件").setInputFiles(
    path.join(process.cwd(), "fixtures/ripple-001/source.md"),
  );
  await page.getByRole("button", { name: "导入 Source" }).click();
  await page.getByRole("button", { name: "生成 Story Map" }).click();
  await expect(page.getByText("Story Map v1 · draft")).toBeVisible();
  await page.getByTestId("event-node-event_07").click();
  await expect(page.getByRole("heading", { name: "许澄交出红账" })).toBeVisible();
  await page.getByRole("button", { name: "在原文中定位" }).click();
  await expect(page.locator("mark[data-active-evidence='true']")).toContainText(
    "许澄把红色账簿交给周岚",
  );
  await page.getByRole("button", { name: "确认 Story Map" }).click();
  await expect(page.getByText("Story Map v2 · confirmed")).toBeVisible();
}

test("generates a strict rerouted preview and creates one child only after acceptance", async ({
  page,
}) => {
  await createConfirmedFixtureProject(page, `Ripple rerouted ${Date.now()}`);
  await page.getByTestId("event-node-event_07").click();
  await page.getByRole("button", { name: "为所选事件创建 Ripple" }).click();
  await page.getByLabel("分歧类型").selectOption("prevent");
  await page
    .getByLabel("改变内容")
    .fill("许澄没有把红色账簿交给周岚");
  await page.getByLabel("严格模式").check();
  await page
    .getByLabel("白鸥号沉船事故的系统性真相最终进入公共记录")
    .check();
  await page.getByRole("button", { name: "生成 Ripple Preview" }).click();

  await expect(page.getByTestId("ripple-preview")).toBeVisible();
  await expect(page.getByText("直接影响")).toBeVisible();
  await expect(page.getByText("中期影响")).toBeVisible();
  await expect(page.getByText("结局影响")).toBeVisible();
  await expect(page.getByText(/因果路径：许澄交出红账/).first()).toBeVisible();
  await expect(page.getByText("Rerouted · 改道")).toBeVisible();
  await expect(
    page.getByText(/Anchor · 白鸥号沉船事故的系统性真相最终进入公共记录/),
  ).toBeVisible();
  await expect(page.getByText(/Anchor 因果路径：许澄交出红账/)).toBeVisible();
  await expect(page.getByText("接受前不会创建 Worldline")).toBeVisible();

  await page
    .getByRole("button", { name: "接受 ImpactPlan 并创建 Worldline" })
    .click();
  await expect(page.getByRole("status")).toContainText("新 Worldline 已创建");
  await expect(page.getByText("已创建 1 条子 Worldline")).toBeVisible();

  await page.getByRole("button", { name: "进入新 Worldline" }).click();
  await expect(page.getByTestId("worldline-continuation")).toBeVisible();
  await expect(page.getByText("Canon", { exact: true })).toBeVisible();
  await expect(page.getByText("Divergence", { exact: true })).toBeVisible();
  await expect(page.getByText("当前 Worldline", { exact: true })).toBeVisible();
  await expect(page.getByTestId("worldline-delta")).toContainText(
    "许澄交出红账",
  );

  await page.getByRole("button", { name: "生成 3 个后续方向" }).click();
  await expect(page.locator(".direction-card")).toHaveCount(3);
  await expect(page.getByText("把证据藏进潮标站")).toBeVisible();
  await page
    .getByText("把证据藏进潮标站")
    .locator("xpath=ancestor::article[1]")
    .getByRole("button", { name: "选择此方向" })
    .click();
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站的第二把锁",
  );
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "没有把红账带去报社",
  );

  await page.reload();
  await expect(page.getByText("已创建 1 条子 Worldline")).toBeVisible();
  await expect(page.getByText("Story Map v2 · confirmed")).toBeVisible();
  await page.getByRole("button", { name: "继续最近 Worldline" }).click();
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站的第二把锁",
  );
});

test("shows incompatible and blocks strict acceptance", async ({ page }) => {
  await createConfirmedFixtureProject(page, `Ripple incompatible ${Date.now()}`);
  await page.getByTestId("event-node-event_07").click();
  await page.getByRole("button", { name: "为所选事件创建 Ripple" }).click();
  await page.getByLabel("分歧类型").selectOption("choice");
  await page
    .getByLabel("改变内容")
    .fill("许澄当场烧毁红色账簿，并拒绝保留任何副本");
  await page.getByLabel("严格模式").check();
  await page.getByLabel("红色账簿原件最终进入市档案馆").check();
  await page.getByRole("button", { name: "生成 Ripple Preview" }).click();

  await expect(page.getByText("Incompatible · 不兼容")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "接受 ImpactPlan 并创建 Worldline",
    }),
  ).toBeDisabled();
  await expect(page.getByText("尚未创建子 Worldline")).toBeVisible();
});

test("generates and accepts an open-mode preview without ending Anchors", async ({
  page,
}) => {
  await createConfirmedFixtureProject(page, `Ripple open ${Date.now()}`);
  await page.getByTestId("event-node-event_09").click();
  await page.getByRole("button", { name: "为所选事件创建 Ripple" }).click();
  await page.getByLabel("分歧类型").selectOption("outcome");
  await page
    .getByLabel("改变内容")
    .fill("许澄仍启动旧东闸，但闸门只抬起一半便彻底卡死");
  await page.getByLabel("完全开放模式").check();
  await page.getByRole("button", { name: "生成 Ripple Preview" }).click();

  await expect(page.getByTestId("ripple-preview")).toBeVisible();
  await expect(page.getByText("开放模式 · 无结局 Anchor")).toBeVisible();
  await expect(page.getByText("旧东闸的实际泄洪能力低于原路径")).toBeVisible();
  await page
    .getByRole("button", { name: "接受 ImpactPlan 并创建 Worldline" })
    .click();
  await expect(page.getByRole("status")).toContainText("新 Worldline 已创建");
});
