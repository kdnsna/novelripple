import { expect, test } from "@playwright/test";
import path from "node:path";

test("reader starts a ripple directly, previews it, and enters the first scene", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: /创建故事项目/ }).click();
  await page.getByLabel("项目名称").fill(`读者优先 ${Date.now()}`);
  await page.getByRole("button", { name: "创建 Project" }).click();
  await page.getByLabel("故事文件").setInputFiles(
    path.join(process.cwd(), "fixtures/ripple-001/source.md"),
  );
  await page.getByRole("button", { name: "导入 Source" }).click();
  await expect(page.getByRole("status")).toContainText("Source 导入成功");

  await page.getByRole("button", { name: "生成 Story Map" }).click();
  await expect(page.getByTestId("story-map-job-progress")).toBeVisible();
  await expect(page.getByText("Story Map v1 · draft")).toBeVisible({
    timeout: 15_000,
  });

  // 不做 Guided Review，直接确认并进入 Ripple。
  await page.getByRole("button", { name: "直接开始涟漪" }).click();
  await expect(page.getByText(/Story Map v\d+ · confirmed/)).toBeVisible();
  await expect(page.getByText("未精修 · 可随时进入精修模式")).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "3 个值得改变的瞬间" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "从时间线上自己选一个事件" }),
  ).toBeVisible();
  // 当前 revision 没有建议时自动生成一次，不需要额外点击。
  await expect(page.locator(".ripple-suggestion-card")).toHaveCount(3, {
    timeout: 15_000,
  });

  // 关闭面板并切换事件后重开：建议已在工作区缓存，不得再次显示加载态。
  await page.getByRole("button", { name: "返回 Evidence" }).click();
  await page.getByTestId("event-node-event_06").click();
  await page.getByRole("button", { name: "为所选事件创建 Ripple" }).click();
  await expect(page.locator(".ripple-suggestion-card")).toHaveCount(3);
  await expect(page.getByText("正在寻找值得改变的瞬间…")).toHaveCount(0);

  const card = page
    .locator(".ripple-suggestion-card")
    .filter({ hasText: "许澄没有把红色账簿交给周岚" });
  await expect(card).toContainText("为什么值得改变");
  await expect(card).toContainText("建议改动");
  await card.getByRole("button", { name: "从这里改变" }).click();

  await expect(page.getByLabel("分歧类型")).toHaveValue("prevent");
  await expect(page.getByLabel("改变内容")).toHaveValue(
    "许澄没有把红色账簿交给周岚",
  );
  await page.getByLabel("保留原结局").check();
  await expect(
    page.getByText("选择要保住的结局；新剧情会绕路回到这些结局"),
  ).toBeVisible();
  await page
    .getByLabel("白鸥号沉船事故的系统性真相最终进入公共记录")
    .check();
  await page.getByRole("button", { name: "生成 Ripple Preview" }).click();

  // 默认先展示一屏摘要：三类影响各一行 + 原结局状态 + 主操作。
  await expect(page.getByTestId("ripple-preview")).toBeVisible();
  await expect(page.locator(".mode-badge")).toHaveText("保留原结局");
  await expect(page.getByTestId("impact-summary")).toContainText("直接影响");
  await expect(page.getByTestId("impact-summary")).toContainText("中期影响");
  await expect(page.getByTestId("impact-summary")).toContainText("结局影响");
  await expect(page.getByTestId("impact-summary")).toContainText(
    "原结局保住了 · 改道",
  );
  await expect(page.getByText("接受前不会创建 Worldline")).toBeVisible();

  // 完整因果路径与 Anchor 解释仍在“查看完整影响”中。
  await page.getByTestId("impact-details").locator(":scope > summary").click();
  await expect(page.getByText("Rerouted · 改道")).toBeVisible();
  await expect(page.getByText(/因果路径：许澄交出红账/).first()).toBeVisible();

  // 一键接受并进入新世界线；根方向自动出现，不需要再次点击生成。
  await page.getByRole("button", { name: "进入新世界线" }).click();
  await expect(page.getByTestId("worldline-continuation")).toBeVisible();
  await expect(
    page
      .getByText("正在构思 3 个方向…")
      .or(page.locator(".direction-card").first()),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".direction-card")).toHaveCount(3, {
    timeout: 15_000,
  });

  // 选择一个方向后按现有流程得到第一幕。
  await page
    .locator(".direction-card")
    .first()
    .getByRole("button", { name: "选择此方向" })
    .click();
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站的第二把锁",
  );
});
