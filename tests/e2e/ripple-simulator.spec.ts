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
  await expect(page.getByTestId("story-map-job-progress")).toBeVisible();
  await expect(page.getByText("Story Map v1 · draft")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "查看完整图" }).click();
  await page.getByTestId("event-node-event_07").click();
  await expect(page.getByRole("heading", { name: "许澄交出红账" })).toBeVisible();
  await page.getByRole("button", { name: "在原文中定位" }).click();
  await expect(page.locator("mark[data-active-evidence='true']")).toContainText(
    "许澄把红色账簿交给周岚",
  );
  await page.getByRole("button", { name: "返回核对队列" }).click();
  await completeRequiredReview(page);
  await page
    .getByRole("button", { name: "确认 Story Map 并进入 Ripple" })
    .click();
  await expect(page.getByText(/Story Map v\d+ · confirmed/)).toBeVisible();
}

/** 走通标准 rerouted 分歧并进入第一条子 Worldline，供世界线树场景复用。 */
async function enterReroutedWorldline(page: Page, title: string) {
  await createConfirmedFixtureProject(page, title);
  await page.getByTestId("event-node-event_07").click();
  await page.getByRole("button", { name: "为所选事件创建 Ripple" }).click();
  await page.getByLabel("分歧类型").selectOption("prevent");
  await page
    .getByLabel("改变内容")
    .fill("许澄没有把红色账簿交给周岚");
  await page.getByLabel("保留原结局").check();
  await page
    .getByLabel("白鸥号沉船事故的系统性真相最终进入公共记录")
    .check();
  await page.getByRole("button", { name: "生成 Ripple Preview" }).click();
  await expect(page.getByTestId("ripple-preview")).toBeVisible();
  await page.getByRole("button", { name: "进入新世界线" }).click();
  await expect(page.getByTestId("worldline-continuation")).toBeVisible();
  await expect(page.locator(".direction-card")).toHaveCount(3, {
    timeout: 15_000,
  });
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
  await page.getByLabel("保留原结局").check();
  await page
    .getByLabel("白鸥号沉船事故的系统性真相最终进入公共记录")
    .check();
  await page.getByRole("button", { name: "生成 Ripple Preview" }).click();

  await expect(page.getByTestId("ripple-preview")).toBeVisible();
  await expect(page.getByTestId("impact-summary")).toContainText("直接影响");
  await expect(page.getByTestId("impact-summary")).toContainText("中期影响");
  await expect(page.getByTestId("impact-summary")).toContainText("结局影响");
  await expect(page.getByTestId("impact-summary")).toContainText(
    "原结局保住了 · 改道",
  );
  await expect(page.getByText("接受前不会创建 Worldline")).toBeVisible();

  // 完整因果路径与 Anchor 解释收在“查看完整影响”里，信息不删除。
  await page.getByTestId("impact-details").locator(":scope > summary").click();
  await expect(page.getByText(/因果路径：许澄交出红账/).first()).toBeVisible();
  await expect(page.getByText("Rerouted · 改道")).toBeVisible();
  await expect(
    page.getByText(/Anchor · 白鸥号沉船事故的系统性真相最终进入公共记录/),
  ).toBeVisible();
  await expect(page.getByText(/Anchor 因果路径：许澄交出红账/)).toBeVisible();

  await page.getByRole("button", { name: "进入新世界线" }).click();
  await expect(page.getByTestId("worldline-continuation")).toBeVisible();
  await expect(page.getByText("已创建 1 条子 Worldline")).toBeVisible();
  await expect(page.getByText("Canon", { exact: true })).toBeVisible();
  await expect(page.getByText("Divergence", { exact: true })).toBeVisible();
  await expect(page.getByText("当前 Worldline", { exact: true })).toBeVisible();
  await expect(page.getByTestId("worldline-delta")).toContainText(
    "许澄交出红账",
  );

  // 进入新世界线后自动请求根方向，不需要再次点击“生成 3 个后续方向”。
  await expect(page.locator(".direction-card")).toHaveCount(3, {
    timeout: 15_000,
  });
  await expect(page.getByText("方向批次 1")).toBeVisible();
  await expect(page.getByText("把证据藏进潮标站")).toBeVisible();

  // 换一批：同一父节点创建新批次，旧批次不覆盖；界面切到新批次。
  await page.getByRole("button", { name: "换一批" }).click();
  await expect(page.getByText("方向批次 2")).toBeVisible();
  await expect(page.locator(".direction-card")).toHaveCount(3);
  await page
    .locator(".direction-card")
    .first()
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
  await expect(page.getByText(/Story Map v\d+ · confirmed/)).toBeVisible();
  await page.getByRole("button", { name: "继续最近 Worldline" }).click();
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站的第二把锁",
  );

  // 从当前场景继续：先取 3 个方向，再选择第一个方向生成第二幕。
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.locator(".direction-card")).toHaveCount(3);
  await page
    .locator(".direction-card")
    .first()
    .getByRole("button", { name: "选择此方向" })
    .click();
  await expect(page.getByTestId("continuation-path")).toContainText("第 1 幕");
  await expect(page.getByTestId("continuation-scene")).toContainText("第 2 幕");
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站之后",
  );

  // 重试本幕生成同父节点的新兄弟；切回首次尝试时导航显示 1/2。
  await page.getByRole("button", { name: "重试本幕" }).click();
  await expect(page.getByTestId("continuation-scene")).toContainText("第 2 幕");
  await expect(page.getByTestId("continuation-scene")).toContainText("重试");
  await expect(page.getByTestId("scene-siblings")).toContainText("2/2");
  await page.getByRole("button", { name: "上一个兄弟场景" }).click();
  await expect(page.getByTestId("scene-siblings")).toContainText("1/2");
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站之后",
  );
  await expect(page.getByTestId("continuation-scene")).not.toContainText(
    "重试",
  );

  // Context Viewer 只展示段名/计数，不展示正文。
  await page.getByTestId("context-viewer").locator("summary").click();
  await expect(page.getByTestId("context-viewer")).toContainText("预算使用");
  for (const section of ["世界线设定", "原著证据", "最近场景", "所选方向"]) {
    await expect(page.getByTestId("context-viewer")).toContainText(section);
  }
});

test("reopens an inner scene from the worldline tree and branches a new sibling act", async ({
  page,
}) => {
  await enterReroutedWorldline(page, `Worldline tree ${Date.now()}`);

  // 根批次 → 第 1 幕；再为第 1 幕生成方向 → 第 2 幕。
  await page
    .locator(".direction-card")
    .first()
    .getByRole("button", { name: "选择此方向" })
    .click();
  const firstScene = page.getByTestId("continuation-scene");
  await expect(firstScene).toContainText("潮标站的第二把锁");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.locator(".direction-card")).toHaveCount(3);
  await page
    .locator(".direction-card")
    .first()
    .getByRole("button", { name: "选择此方向" })
    .click();
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站之后",
  );

  const tree = page.getByTestId("worldline-tree");
  await expect(tree).toBeVisible();
  await expect(tree.getByRole("treeitem")).toHaveCount(3);
  await expect(
    tree.getByRole("button", { name: "第 1 幕 · 潮标站的第二把锁" }),
  ).toBeVisible();
  await expect(
    tree.getByRole("button", { name: "第 2 幕 · 潮标站之后" }),
  ).toBeVisible();
  await expect(tree).toContainText(
    "点任意节点即可从那里重开；已有内容不会被覆盖，新内容会成为新的分支。",
  );

  // 从第 1 幕重开：路径只剩第 1 幕，旧方向批次仍可读，已生成方向显示查看入口。
  await tree
    .getByRole("button", { name: "第 1 幕 · 潮标站的第二把锁" })
    .click();
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站的第二把锁",
  );
  await expect(page.getByTestId("continuation-scene")).not.toContainText(
    "潮标站之后",
  );
  const firstDirection = page.locator(".direction-card").first();
  await expect(firstDirection).toContainText("查看已生成（1 版）");
  await expect(
    firstDirection.getByRole("button", { name: "选择此方向" }),
  ).toHaveCount(0);
  await expect(
    firstDirection.getByRole("button", { name: "再写一版" }),
  ).toBeVisible();

  // 选择同批次里尚未探索的方向，创建第 2 幕的新兄弟分支。
  await page
    .locator(".direction-card")
    .nth(1)
    .getByRole("button", { name: "选择此方向" })
    .click();
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站之后",
  );
  await expect(tree.getByRole("treeitem")).toHaveCount(4);
  const secondActRows = tree
    .getByTestId("worldline-tree-row")
    .filter({ hasText: "第 2 幕 · 潮标站之后" });
  await expect(secondActRows).toHaveCount(2);

  // 原始第 2 幕仍可回读：它是第一个兄弟，导航显示 1/2。
  await secondActRows
    .first()
    .getByRole("button", { name: "第 2 幕 · 潮标站之后" })
    .click();
  await expect(page.getByTestId("scene-siblings")).toContainText("1/2");
  await expect(secondActRows.first()).toHaveAttribute("aria-current", "true");

  // 回到分歧点：路径清空，根批次仍然显示，且第一个方向已生成第 1 幕。
  await tree.getByRole("button", { name: "分歧点", exact: true }).click();
  await expect(page.getByTestId("continuation-path")).toHaveCount(0);
  await expect(page.getByTestId("continuation-directions")).toBeVisible();
  await expect(page.locator(".direction-card")).toHaveCount(3);
  await expect(page.locator(".direction-card").first()).toContainText(
    "查看已生成（1 版）",
  );
  await expect(
    tree.getByTestId("worldline-tree-row").first(),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("path-character-states")).toBeVisible();
});

test("adds a path-scoped setting delta and keeps it visible on descendants", async ({
  page,
}) => {
  await enterReroutedWorldline(page, `Setting delta ${Date.now()}`);

  // 根批次 → 第 1 幕；再为第 1 幕生成方向 → 第 2 幕（第一个方向）。
  await page
    .locator(".direction-card")
    .first()
    .getByRole("button", { name: "选择此方向" })
    .click();
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站的第二把锁",
  );
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.locator(".direction-card")).toHaveCount(3);
  await page
    .locator(".direction-card")
    .first()
    .getByRole("button", { name: "选择此方向" })
    .click();
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站之后",
  );

  // 回到第 1 幕添加一条术语设定增量；它只从第 1 幕起对本路径生效。
  const tree = page.getByTestId("worldline-tree");
  await tree
    .getByRole("button", { name: "第 1 幕 · 潮标站的第二把锁" })
    .click();
  await page.getByRole("button", { name: "添加设定增量" }).click();
  await page.getByLabel("主体类型").selectOption("term");
  await page.getByLabel("设定词条").fill("旧灯塔");
  await page.getByLabel("规则说明").fill("旧灯塔已被封锁");
  await page.getByRole("button", { name: "保存设定增量" }).click();

  const settingDeltas = page.getByTestId("path-setting-deltas");
  await expect(settingDeltas.getByTestId("path-setting-delta")).toHaveCount(1);
  await expect(settingDeltas).toContainText("旧灯塔");
  await expect(settingDeltas).toContainText("旧灯塔已被封锁");
  await expect(settingDeltas).toContainText("自第 1 幕起");

  // 设定更新后旧批次 stale：不自动重建，只提示换一批；未生成方向不可选。
  const staleBanner = page.getByTestId("setting-delta-stale-banner");
  await expect(staleBanner).toBeVisible();
  await expect(staleBanner).toHaveText("设定已更新，请换一批以生效");
  await expect(
    page
      .locator(".direction-card")
      .first()
      .getByRole("button", { name: "再写一版" }),
  ).toBeDisabled();
  await expect(
    page
      .locator(".direction-card")
      .nth(1)
      .getByRole("button", { name: "选择此方向" }),
  ).toBeDisabled();
  await expect(
    page
      .locator(".direction-card")
      .nth(2)
      .getByRole("button", { name: "选择此方向" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "换一批" })).toBeEnabled();

  // 显式换一批得到新批次；新批次基于更新后的规则，stale 提示消失。
  await page.getByRole("button", { name: "换一批" }).click();
  await expect(page.getByText("方向批次 2")).toBeVisible();
  await expect(staleBanner).toHaveCount(0);
  await expect(page.locator(".direction-card")).toHaveCount(3);

  // 选一个尚未探索的方向创建兄弟第 2 幕：规则作为祖先对后代可见。
  await page
    .locator(".direction-card")
    .nth(1)
    .getByRole("button", { name: "选择此方向" })
    .click();
  await expect(page.getByTestId("continuation-scene")).toContainText(
    "潮标站之后",
  );
  await expect(settingDeltas.getByTestId("path-setting-delta")).toHaveCount(1);

  // 原始第 2 幕同样是第 1 幕的后代，规则仍然可见。
  const secondActRows = tree
    .getByTestId("worldline-tree-row")
    .filter({ hasText: "第 2 幕 · 潮标站之后" });
  await expect(secondActRows).toHaveCount(2);
  await secondActRows
    .first()
    .getByRole("button", { name: "第 2 幕 · 潮标站之后" })
    .click();
  await expect(settingDeltas.getByTestId("path-setting-delta")).toHaveCount(1);

  // 分歧点不是任何场景的后代，规则不可见。
  await tree.getByRole("button", { name: "分歧点", exact: true }).click();
  await expect(settingDeltas).toContainText("本路径还没有设定增量。");

  // 刷新后规则仍在，并从最新 Worldline 的第 1 幕重新读到。
  await page.reload();
  await expect(page.getByText("已创建 1 条子 Worldline")).toBeVisible();
  await page.getByRole("button", { name: "继续最近 Worldline" }).click();
  await expect(page.getByTestId("worldline-continuation")).toBeVisible();
  await page
    .getByTestId("worldline-tree")
    .getByRole("button", { name: "第 1 幕 · 潮标站的第二把锁" })
    .click();
  await expect(
    page.getByTestId("path-setting-deltas").getByTestId("path-setting-delta"),
  ).toHaveCount(1);
  await expect(page.getByTestId("path-setting-deltas")).toContainText(
    "旧灯塔已被封锁",
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
  await page.getByLabel("保留原结局").check();
  await page.getByLabel("红色账簿原件最终进入市档案馆").check();
  await page.getByRole("button", { name: "生成 Ripple Preview" }).click();

  await expect(page.getByTestId("impact-summary")).toContainText(
    "原结局无法保留",
  );
  await page.getByTestId("impact-details").locator(":scope > summary").click();
  await expect(page.getByText("Incompatible · 不兼容")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "进入新世界线",
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
  await page.getByLabel("让故事自由发展").check();
  await page.getByRole("button", { name: "生成 Ripple Preview" }).click();

  await expect(page.getByTestId("ripple-preview")).toBeVisible();
  await expect(page.locator(".mode-badge")).toHaveText("让故事自由发展");
  await expect(page.getByTestId("impact-summary")).toContainText(
    "不锁定结局 · 让故事自由发展",
  );
  await page.getByTestId("impact-details").locator(":scope > summary").click();
  await expect(
    page.locator(".impact-item").getByText("旧东闸的实际泄洪能力低于原路径"),
  ).toBeVisible();
  await page.getByRole("button", { name: "进入新世界线" }).click();
  await expect(page.getByTestId("worldline-continuation")).toBeVisible();
});

test("uses suggestions as candidates and regenerates one immutable feedback lineage", async ({
  page,
}) => {
  await createConfirmedFixtureProject(page, `Ripple guidance ${Date.now()}`);

  await expect(page.locator(".ripple-suggestion-card")).toHaveCount(3, {
    timeout: 15_000,
  });
  await expect(page.getByText("尚未创建子 Worldline")).toBeVisible();
  await page
    .locator(".ripple-suggestion-card")
    .filter({ hasText: "许澄没有把红色账簿交给周岚" })
    .getByRole("button", { name: "从这里改变" })
    .click();

  await expect(page.getByLabel("分歧类型")).toHaveValue("prevent");
  await expect(page.getByLabel("改变内容")).toHaveValue(
    "许澄没有把红色账簿交给周岚",
  );
  await expect(page.getByTestId("ripple-preview")).toHaveCount(0);

  await page.getByLabel("保留原结局").check();
  await page
    .getByLabel("白鸥号沉船事故的系统性真相最终进入公共记录")
    .check();
  await page.getByRole("button", { name: "生成 Ripple Preview" }).click();

  await expect(page.getByTestId("impact-summary")).toBeVisible();
  await page.getByTestId("impact-details").locator(":scope > summary").click();
  await expect(page.getByRole("heading", { name: "原路径" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "新路径" })).toBeVisible();
  for (const heading of ["删除", "修改", "新增", "保持不变的关键事实"]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  await page
    .getByLabel("指出一个关键判断问题")
    .fill("人物已经看过照片，因此不应退出调查。");
  await page.getByRole("button", { name: "根据反馈重新推演" }).click();

  await expect(page.getByText("基于上一候选重新推演")).toBeVisible();
  await expect(page.getByText(/已根据明确反馈重新判断/)).toBeVisible();
  await expect(page.getByText("已创建 0 条子 Worldline")).toHaveCount(0);
  await expect(page.getByText("尚未创建子 Worldline")).toBeVisible();

  await page.getByRole("button", { name: "进入新世界线" }).click();
  await expect(page.getByTestId("worldline-continuation")).toBeVisible();
  await expect(page.getByText("已创建 1 条子 Worldline")).toBeVisible();
});

async function completeRequiredReview(page: Page) {
  for (let index = 0; index < 30; index += 1) {
    const finalAction = page.getByRole("button", {
      name: "确认 Story Map 并进入 Ripple",
    });
    if (await finalAction.isEnabled()) return;
    const candidates = [
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
    for (const candidate of candidates) {
      if ((await candidate.count()) > 0 && (await candidate.first().isVisible())) {
        const before = await currentVersionText(page);
        await candidate.first().click();
        await expect(page.getByText(before, { exact: true })).toBeHidden();
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
    if (!acted) throw new Error("Readiness 尚未完成，但没有可执行核对操作");
  }
  throw new Error("Readiness 未在 30 次核对内完成");
}

async function currentVersionText(page: Page): Promise<string> {
  return (await page.getByText(/Story Map v\d+ · (draft|confirmed)/).textContent())!;
}
