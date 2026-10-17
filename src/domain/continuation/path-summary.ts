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
 * 超预算时从最旧的行开始丢弃，始终优先保留较新的摘要；
 * 发生截断时在开头加一行省略提示。结果确定：同一输入逐字节相同。
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

  // 从最旧的一行开始丢弃，直到“省略提示 + 保留行”进入预算。
  for (let dropped = 1; dropped <= summarized.length; dropped += 1) {
    const remaining = lines.slice(dropped);
    const marker = `（更早的 ${dropped} 幕已省略）`;
    const text =
      remaining.length === 0 ? marker : `${marker}\n${remaining.join("\n")}`;
    if (text.length <= maxChars) {
      const covered = summarized.slice(dropped);
      return {
        text,
        coveredSceneIds: covered.map((node) => node.id),
        watermarkSceneId:
          covered.length === 0 ? null : covered[covered.length - 1]!.id,
        truncated: true,
      };
    }
  }

  const minimalMarker = `（更早的 ${summarized.length} 幕已省略）`;
  throw new Error(
    `路径摘要预算过小：maxChars=${maxChars}，至少需要 ${minimalMarker.length} 字符`,
  );
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
