import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

test("guides review by priority, invalidates changed Evidence, confirms, and recovers after refresh", async ({
  page,
}) => {
  await createFixtureStoryMap(page, "Guided Review 完整旅程");

  await expect(page.getByRole("heading", { name: "优先核对队列" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "进入 Ripple 前" })).toBeVisible();
  await expect(page.getByText("关键 Event 均有 Evidence")).toBeVisible();
  await expect(page.getByRole("heading", { name: "故事因果地图" })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "确认 Story Map 并进入 Ripple" }),
  ).toBeDisabled();
  await expect(page.locator("[data-review-score]")).toHaveCount(0);

  await page.getByRole("button", { name: "查看完整图" }).click();
  await expect(page.getByRole("heading", { name: "故事因果地图" })).toBeVisible();
  await expect(page.locator('[data-testid^="event-node-"]')).toHaveCount(12);
  await page.getByLabel("按角色筛选").selectOption("char_xuchuan");
  await expect(page.locator('[data-testid^="event-node-"]')).toHaveCount(6);
  await page.getByLabel("按角色筛选").selectOption("");

  const canvas = page.locator(".story-map-canvas");
  const edgeCountBeforeDrag = await canvas.getAttribute("data-edge-count");
  const draggableNode = page
    .getByTestId("event-node-event_01")
    .locator("xpath=ancestor::*[contains(@class, 'react-flow__node')][1]");
  await draggableNode.scrollIntoViewIfNeeded();
  const beforeDrag = await draggableNode.boundingBox();
  expect(beforeDrag).not.toBeNull();
  const dragStartX = (beforeDrag?.x ?? 0) + (beforeDrag?.width ?? 0) / 2;
  const dragStartY = (beforeDrag?.y ?? 0) + (beforeDrag?.height ?? 0) / 2;
  await page.mouse.move(dragStartX, dragStartY);
  await page.mouse.down();
  await page.mouse.move(dragStartX + 110, dragStartY + 70, { steps: 12 });
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-last-dragged-node", "event_01");
  await expect(canvas).toHaveAttribute("data-edge-count", edgeCountBeforeDrag ?? "");

  await page.getByTestId("event-node-event_01").click();
  await expect(page.getByRole("heading", { name: "许澄重返祁雾港" })).toBeVisible();
  await page.getByRole("button", { name: "在原文中定位" }).click();
  await expect(page.locator("mark[data-active-evidence='true']")).toContainText(
    "渡船靠上祁雾港",
  );
  await clickRevisionAction(page, page.getByRole("button", { name: "确认 Evidence 1" }));

  // revision 后工作区保持当前视图（不再整体重挂载）
  await page.getByTestId("event-node-event_01").click();
  await page.getByRole("button", { name: "修正事件" }).click();
  await page.getByLabel("事件标题").fill("许澄回到祁雾港");
  await clickRevisionAction(
    page,
    page.getByRole("button", { name: "保存为新 revision" }),
  );

  await page.getByTestId("event-node-event_01").click();
  await expect(page.getByRole("button", { name: "确认 Evidence 1" })).toBeEnabled();
  await clickRevisionAction(page, page.getByRole("button", { name: "确认 Evidence 1" }));

  await page.getByRole("button", { name: "返回核对队列" }).click();
  await completeRequiredReview(page);
  const finalAction = page.getByRole("button", {
    name: "确认 Story Map 并进入 Ripple",
  });
  await expect(finalAction).toBeEnabled();
  await finalAction.click();
  await expect(page.getByText(/Story Map v\d+ · confirmed/)).toBeVisible();
  await expect(page.getByText("已通过 Ripple 前置确认门")).toBeVisible();
  await expect(page.getByText(/Ripple Simulator · 事件/)).toBeVisible();
  // 等待 confirm 的 replace 导航把 confirmed revision 与 ripple 参数写进 URL。
  await page.waitForURL(/ripple=opened/);

  const confirmedVersion = await currentVersionText(page);
  await page.reload();
  await expect(page.getByText(confirmedVersion, { exact: true })).toBeVisible();
  await expect(page.getByTestId("source-reader")).toContainText(
    "潮汐钟正停在凌晨四点十二分",
  );
  await expect(page.getByText("Source 版本 v1")).toBeVisible();
});

test("supports merge, evidenced Event add/delete, reorder, Edge lifecycle, and stale recovery", async ({
  context,
  page,
}) => {
  await createFixtureStoryMap(page, "Guided Review 修正操作");
  const stalePage = await context.newPage();
  await stalePage.goto(page.url());

  await page.getByRole("button", { name: "调整顺序" }).click();
  await page.getByRole("button", { name: "下移 许澄重返祁雾港" }).click();
  await clickRevisionAction(
    page,
    page.getByRole("button", { name: "保存顺序 revision" }),
  );

  await stalePage.getByRole("button", { name: "调整顺序" }).click();
  await stalePage.getByRole("button", { name: "下移 许澄重返祁雾港" }).click();
  await stalePage.getByRole("button", { name: "保存顺序 revision" }).click();
  await expect(stalePage.locator(".workspace-action-error")).toContainText(
    "Story Map 版本已更新",
  );
  await stalePage.close();

  await page.getByRole("button", { name: "人物修正" }).click();
  await page.getByText("合并两个重复人物").click();
  await clickRevisionAction(
    page,
    page.getByRole("button", { name: "合并并创建 revision" }),
  );
  await page.getByRole("button", { name: "查看完整图" }).click();
  await expect(
    page.getByLabel("按角色筛选").locator('option[value="char_zhoulan"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "返回核对队列" }).click();

  await page.getByRole("button", { name: "补充 Event" }).click();
  await page.getByRole("button", { name: "选择这段 Evidence" }).click();
  await page.getByLabel("事件标题").fill("人工新增测试事件");
  await page.getByLabel("事件摘要").fill("读者从选定 Evidence 补充遗漏事件。");
  await page.getByLabel("状态变化（每行一项）").fill("遗漏事实进入地图");
  await page.getByRole("checkbox", { name: "许澄" }).check();
  await clickRevisionAction(
    page,
    page.getByRole("button", { name: "新增 Event revision" }),
  );

  await page.getByRole("button", { name: "查看完整图" }).click();
  const addedEvent = page
    .locator('[data-testid^="event-node-"]')
    .filter({ hasText: "人工新增测试事件" });
  await expect(addedEvent).toHaveCount(1);
  await addedEvent.click();
  await page.getByRole("button", { name: "返回核对队列" }).click();
  await page.getByRole("button", { name: "删除错误 Event" }).click();
  await clickRevisionAction(
    page,
    page.getByRole("button", { name: "确认删除 Event" }),
  );

  await page.getByRole("button", { name: "新增 Edge" }).click();
  await page.getByRole("button", { name: "选择这段 Evidence" }).click();
  await page.getByLabel("Edge 起点 Event").selectOption("event_01");
  await page.getByLabel("Edge 终点 Event").selectOption("event_03");
  await page.getByLabel("Edge 类型").selectOption("enables");
  await page.getByLabel("解释").fill("人工添加的测试关系");
  await clickRevisionAction(
    page,
    page.getByRole("button", { name: "新增 Edge revision" }),
  );

  await openManualEdgeAdvisory(page);
  await clickRevisionAction(
    page,
    page.getByRole("button", { name: "确认 Edge Evidence 1" }),
  );
  await openManualEdgeAdvisory(page);
  await page.getByLabel("Edge 类型").selectOption("causes");
  await page.getByLabel("解释").fill("人工修改后的直接因果");
  await clickRevisionAction(
    page,
    page.getByRole("button", { name: "保存 Edge revision" }),
  );

  await openManualEdgeAdvisory(page);
  await expect(
    page.getByRole("button", { name: "确认 Edge Evidence 1" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "删除错误 Edge" }).click();
  await clickRevisionAction(
    page,
    page.getByRole("button", { name: "确认删除 Edge" }),
  );

  const recoveredVersion = await currentVersionText(page);
  await page.reload();
  await expect(page.getByText(recoveredVersion, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "优先核对队列" })).toBeVisible();
});

async function createFixtureStoryMap(page: Page, projectTitle: string) {
  await page.goto("/");
  await page.getByRole("link", { name: /创建故事项目/ }).click();
  await page.getByLabel("项目名称").fill(projectTitle);
  await page.getByRole("button", { name: "创建 Project" }).click();
  await page.getByLabel("故事文件").setInputFiles(
    path.join(process.cwd(), "fixtures/ripple-001/source.md"),
  );
  await page.getByRole("button", { name: "导入 Source" }).click();
  await expect(page.getByRole("status")).toContainText("Source 导入成功");
  await page.getByRole("button", { name: "生成 Story Map" }).click();
  await expect(page.getByText("Story Map v1 · draft")).toBeVisible();
}

async function clickRevisionAction(page: Page, action: ReturnType<Page["locator"]>) {
  const before = await currentVersionText(page);
  const urlBefore = page.url();
  await action.click();
  await expect(page.getByText(before, { exact: true })).toBeHidden();
  // revision 成功后会以 replace 导航同步 URL（含新 artifact id）；
  // 等待其完成，保证后续 reload 恢复的是最新 revision。
  await page.waitForURL((url) => url.href !== urlBefore);
}

async function completeRequiredReview(page: Page) {
  for (let index = 0; index < 40; index += 1) {
    const finalAction = page.getByRole("button", {
      name: "确认 Story Map 并进入 Ripple",
    });
    if (await finalAction.isEnabled()) return;

    const actionCandidates = [
      page.getByRole("button", { name: "确认 Ending Candidate" }),
      page.getByRole("button", { name: "确认人物身份" }),
      page
        .locator("button:not(:disabled)")
        .filter({ hasText: /^确认 Edge Evidence \d+$/u }),
      page
        .locator("button:not(:disabled)")
        .filter({ hasText: /^确认 Evidence \d+$/u }),
    ];
    let acted = false;
    for (const candidate of actionCandidates) {
      if ((await candidate.count()) > 0 && (await candidate.first().isVisible())) {
        await clickRevisionAction(page, candidate.first());
        acted = true;
        break;
      }
    }
    if (!acted) {
      // 当前选择可能是图中 Event 或已核对项：切到第一个待核队列项再试。
      const firstPending = page.locator(".review-queue-list button").first();
      if ((await firstPending.count()) > 0) {
        await firstPending.click();
        acted = true;
      }
    }
    if (!acted) {
      throw new Error("Review Queue 有待核项目，但当前编辑器没有可执行核对操作");
    }
  }
  throw new Error("Review Queue 未在 40 次核对内达到 readiness");
}

async function currentVersionText(page: Page): Promise<string> {
  return (await page.getByText(/Story Map v\d+ · (draft|confirmed)/).textContent())!;
}

async function openManualEdgeAdvisory(page: Page) {
  // revision 后工作区不再重挂载，<details> 会保持用户打开/关闭的状态；
  // 仅在当前处于关闭状态时点击 summary 展开。
  const details = page.locator("details.advisory-queue");
  if ((await details.getAttribute("open")) === null) {
    await page.getByText(/项分叉建议与软提示/).click();
  }
  await page
    .locator(
      '[data-testid^="review-queue-item-validator_advisory:edge_unconfirmed:edge_manual_"]',
    )
    .click();
}
