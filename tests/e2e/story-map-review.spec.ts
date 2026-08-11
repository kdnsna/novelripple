import { expect, test } from "@playwright/test";
import path from "node:path";

test("imports, reviews, revises, confirms, and reloads a Story Map", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: /创建故事项目/ }).click();
  await page.getByLabel("项目名称").fill("Story Map 人工确认测试");
  await page.getByRole("button", { name: "创建 Project" }).click();

  await page.getByLabel("故事文件").setInputFiles(
    path.join(process.cwd(), "fixtures/ripple-001/source.md"),
  );
  await page.getByRole("button", { name: "导入 Source" }).click();
  await expect(page.getByRole("status")).toContainText("Source 导入成功");

  await page.getByRole("button", { name: "生成 Story Map" }).click();
  await expect(page.getByRole("heading", { name: "故事因果地图" })).toBeVisible();
  await expect(page.locator('[data-testid^="event-node-"]')).toHaveCount(12);
  await expect(page.getByText("Story Map v1 · draft")).toBeVisible();

  await page.getByLabel("按角色筛选").selectOption("char_xuchuan");
  await expect(page.locator('[data-testid^="event-node-"]')).toHaveCount(6);
  await page.getByLabel("按角色筛选").selectOption("");
  await expect(page.locator('[data-testid^="event-node-"]')).toHaveCount(12);

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
  await expect(page.getByText("Story Map v1 · draft")).toBeVisible();

  await page.getByTestId("event-node-event_01").click();
  await expect(page.getByRole("heading", { name: "许澄重返祁雾港" })).toBeVisible();
  await expect(page.getByText("许澄重新进入白鸥号事故的空间与人际网络")).toBeVisible();
  await page.getByRole("button", { name: "在原文中定位" }).click();
  await expect(page.locator("mark[data-active-evidence='true']")).toContainText(
    "渡船靠上祁雾港",
  );

  await page.getByRole("button", { name: "确认 Evidence 1" }).click();
  await expect(page.getByText("Story Map v2 · draft")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Evidence 已确认" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "修正事件" }).click();
  await page.getByLabel("事件标题").fill("许澄回到祁雾港");
  await page.getByRole("button", { name: "保存为新 revision" }).click();
  await expect(page.getByText("Story Map v3 · draft")).toBeVisible();
  await expect(page.getByRole("heading", { name: "许澄回到祁雾港" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认 Evidence 1" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "确认 Story Map" }).click();
  await expect(page.getByText("Story Map v4 · confirmed")).toBeVisible();
  await expect(page.getByText("已通过 Ripple 前置确认门")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Story Map v4 · confirmed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "许澄回到祁雾港" })).toBeVisible();
  await expect(page.getByTestId("source-reader")).toContainText(
    "潮汐钟正停在凌晨四点十二分",
  );
  await expect(page.getByText("Source 版本 v1")).toBeVisible();
  await expect(page.getByText("导入新 Source")).toBeVisible();
});
