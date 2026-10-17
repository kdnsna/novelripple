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
    const prefix = `更早剧情（第 1–${compressed} 幕）：`;
    const available =
      maxChars - (remaining.length > 0 ? remainingText.length + 1 : 0);
    if (available < prefix.length) continue;

    const marker = buildCompressedLine(
      prefix,
      summarized.slice(0, compressed),
      available,
    );
    const text =
      remaining.length === 0 ? marker : `${marker}\n${remainingText}`;
    if (text.length > maxChars) continue;

    return {
      text,
      coveredSceneIds: summarized.map((node) => node.id),
      watermarkSceneId: summarized[summarized.length - 1]!.id,
      truncated: true,
    };
  }

  const minimalMarker = "更早剧情（第 1–1 幕）：";
  throw new Error(
    `路径摘要预算过小：maxChars=${maxChars}，至少需要 ${minimalMarker.length} 字符`,
  );
}

/** 把最早的若干场景标题拼成一行；只接受完整标题，不做字符截断。 */
function buildCompressedLine(
  prefix: string,
  nodes: readonly PathSummaryNode[],
  available: number,
): string {
  let line = prefix;
  for (const node of nodes) {
    const title = node.title.trim();
    if (title.length === 0) continue;
    const separator = line === prefix ? "" : "；";
    const candidate = `${line}${separator}${title}`;
    if (candidate.length > available) break;
    line = candidate;
  }
  return line;
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
