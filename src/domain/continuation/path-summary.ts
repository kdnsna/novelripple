import type { SceneNode } from "./scene-tree";

/**
 * 路径摘要只需要节点的不可变展示字段。
 *
 * 复用 `SceneNode` 的归一化结果：v1 场景的 `summary` 为 `null`，
 * 因此 v1 节点只贡献标题，不伪造摘要。
 */
export type PathSummaryNode = Pick<SceneNode, "id" | "title" | "summary">;

export type PathSummary = {
  text: string;
  coveredSceneIds: string[];
  watermarkSceneId: string | null;
  truncated: boolean;
};

/**
 * 沿给定路径构建滚动摘要（纯函数）。
 *
 * 只使用 `pathNodes` 本身，不查询场景树或世界线：
 * 兄弟分支的节点绝不会进入结果。路径按旧→新排列，
 * 最后 `recentSceneCount` 个场景留给最近场景原文，不进入摘要。
 *
 * 超预算时先压缩而不是直接丢弃：保留最新的若干行原文，把更早的场景
 * 合并成一行 `更早剧情（第 a–b 幕）：` + 场景标题（按整条标题截断）。
 * 发生压缩时 `truncated` 为 true。结果确定：同一输入逐字节相同。
 */
export function buildPathSummary(input: {
  pathNodes: readonly PathSummaryNode[];
  recentSceneCount?: number;
  maxChars?: number;
}): PathSummary {
  const recentSceneCount = input.recentSceneCount ?? 2;
  const maxChars = input.maxChars ?? 1_200;
  assertNonNegativeInteger(recentSceneCount, "recentSceneCount");
  assertPositiveInteger(maxChars, "maxChars");

  const pathNodes = input.pathNodes;
  const seen = new Set<string>();
  for (const node of pathNodes) {
    if (seen.has(node.id)) {
      throw new Error(`路径摘要包含重复节点：${node.id}`);
    }
    seen.add(node.id);
  }

  const summarizedCount = Math.max(0, pathNodes.length - recentSceneCount);
  const summarized = pathNodes.slice(0, summarizedCount);
  if (summarized.length === 0) {
    return {
      text: "",
      coveredSceneIds: [],
      watermarkSceneId: null,
      truncated: false,
    };
  }

  const lines = summarized.map((node, index) => formatLine(node, index + 1));
  const fullText = lines.join("\n");
  if (fullText.length <= maxChars) {
    return {
      text: fullText,
      coveredSceneIds: summarized.map((node) => node.id),
      watermarkSceneId: summarized[summarized.length - 1]!.id,
      truncated: false,
    };
  }

  // 从最早开始压缩，尽量保留更多最新行原文；标记行本身也要放得下。
  for (let compressed = 1; compressed <= summarized.length; compressed += 1) {
    const remaining = lines.slice(compressed);
    const remainingText = remaining.join("\n");
    const available =
      maxChars - (remaining.length > 0 ? remainingText.length + 1 : 0);
    if (available <= 0) continue;

    const compressedNodes = summarized.slice(0, compressed);
    const marker = buildCompressedLine(compressedNodes, compressed, available);
    if (marker === null) continue;
    const text =
      remaining.length === 0 ? marker.text : `${marker.text}\n${remainingText}`;
    if (text.length > maxChars) continue;

    // 只覆盖实际显示的场景：压缩行保留的是最靠近全文行的最近若干标题，
    // 更早的标题被丢弃，因此 watermark 不会越过实际显示范围。
    const shownCompressed = compressedNodes
      .slice(marker.startIndex)
      .map((node) => node.id);
    const shownFull = summarized
      .slice(compressed)
      .map((node) => node.id);
    const coveredSceneIds = [...shownCompressed, ...shownFull];

    return {
      text,
      coveredSceneIds,
      watermarkSceneId:
        coveredSceneIds[coveredSceneIds.length - 1] ?? null,
      truncated: true,
    };
  }

  const minimalMarker = "更早剧情（第 1–1 幕）：";
  throw new Error(
    `路径摘要预算过小：maxChars=${maxChars}，至少需要 ${minimalMarker.length} 字符`,
  );
}

/**
 * 把压缩场景标题拼成一行。
 *
 * 放不下全部标题时保留最靠近剩余全文行的最近若干条，丢弃更早的标题，
 * 因此显示范围始终是连续的 `第 a–b 幕`。只接受完整标题，不做字符截断。
 */
function buildCompressedLine(
  nodes: readonly PathSummaryNode[],
  lastPosition: number,
  available: number,
): { text: string; startIndex: number } | null {
  for (let startIndex = 0; startIndex < nodes.length; startIndex += 1) {
    const firstPosition = startIndex + 1;
    const prefix = `更早剧情（第 ${firstPosition}–${lastPosition} 幕）：`;
    const titles = nodes
      .slice(startIndex)
      .map((node) => node.title.trim())
      .filter((title) => title.length > 0);
    const line = `${prefix}${titles.join("；")}`;
    if (line.length <= available) return { text: line, startIndex };
  }
  return null;
}

function formatLine(node: PathSummaryNode, position: number): string {
  const title = node.title.trim();
  const summary = node.summary?.trim() ?? "";
  return summary.length === 0
    ? `第 ${position} 幕：${title}`
    : `第 ${position} 幕：${title}——${summary}`;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数：${value}`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数：${value}`);
  }
}
