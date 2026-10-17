import type { StoryEdge } from "@/domain/schemas";

/**
 * 找出“只依赖不确定因果关系”的 Impact。
 *
 * `reasonPath` 是 Event ID 序列；相邻两个 Event 若对应一条不确定 Edge，
 * 这一段路径就是不确定的。只有整条路径（至少一段）都由不确定 Edge 组成
 * 时才标记该项；任意一段由已确认关系支撑，就视为有确定依据。
 *
 * 这是服务端的 fail-safe：不依赖模型是否遵守 Prompt。
 */
export function deriveUncertainImpactIds(input: {
  impacts: Array<{ id: string; reasonPath: string[] }>;
  edges: Array<Pick<StoryEdge, "id" | "from" | "to">>;
  uncertainEdgeIds: string[];
}): string[] {
  const uncertain = new Set(input.uncertainEdgeIds);
  const edgeIdsByStep = new Map<string, string[]>();
  for (const edge of input.edges) {
    const key = stepKey(edge.from, edge.to);
    edgeIdsByStep.set(key, [...(edgeIdsByStep.get(key) ?? []), edge.id]);
  }

  return input.impacts
    .filter((impact) => {
      if (impact.reasonPath.length < 2) return false;
      for (let index = 0; index < impact.reasonPath.length - 1; index += 1) {
        const edgeIds =
          edgeIdsByStep.get(
            stepKey(impact.reasonPath[index]!, impact.reasonPath[index + 1]!),
          ) ?? [];
        if (edgeIds.length === 0) return false;
        if (!edgeIds.every((edgeId) => uncertain.has(edgeId))) return false;
      }
      return true;
    })
    .map((impact) => impact.id);
}

function stepKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}
