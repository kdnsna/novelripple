import type { ImpactPlan, StoryEdge } from "@/domain/schemas";

/**
 * 被判定为“只可能发生”的 Impact，其 confidence 服务端封顶值。
 *
 * 模型仍可给出更高置信度，但生成计划时统一取 min(model, cap)，避免
 * “可能”的 Impact 在界面上看起来像已确认事实。
 */
export const UNCERTAIN_IMPACT_MAX_CONFIDENCE = 0.5;

type ImpactReasonPath = {
  id: string;
  reasonPath: string[];
};

type EdgeEndpoint = Pick<StoryEdge, "id" | "from" | "to">;

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
  impacts: ImpactReasonPath[];
  edges: EdgeEndpoint[];
  uncertainEdgeIds: string[];
}): string[] {
  const uncertain = new Set(input.uncertainEdgeIds);
  const edgeIdsByStep = groupEdgeIdsByStep(input.edges);

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

/**
 * 本次计划实际“用到”的不确定 Edge：只保留作为某项 Impact reasonPath
 * 相邻两步（from/to pair）出现的不确定 Edge，按首次使用顺序去重。
 *
 * 这与 `uncertainEdgeIds`（本次上下文中的全部不确定 Edge）不同：没有被
 * 任何路径走过的关系不计入预览摘要。
 */
export function deriveUsedUncertainEdgeIds(input: {
  impacts: ImpactReasonPath[];
  edges: EdgeEndpoint[];
  uncertainEdgeIds: string[];
}): string[] {
  const uncertain = new Set(input.uncertainEdgeIds);
  const edgeIdsByStep = groupEdgeIdsByStep(input.edges);
  const seen = new Set<string>();
  const used: string[] = [];

  for (const impact of input.impacts) {
    for (let index = 0; index < impact.reasonPath.length - 1; index += 1) {
      const edgeIds =
        edgeIdsByStep.get(
          stepKey(impact.reasonPath[index]!, impact.reasonPath[index + 1]!),
        ) ?? [];
      for (const edgeId of edgeIds) {
        if (!uncertain.has(edgeId) || seen.has(edgeId)) continue;
        seen.add(edgeId);
        used.push(edgeId);
      }
    }
  }

  return used;
}

/** 服务端确定性标记的不确定 Impact 判定；旧计划缺少字段时视为确定。 */
export function isUncertainImpact(
  plan: Pick<ImpactPlan, "uncertainImpactIds">,
  impactId: string,
): boolean {
  return plan.uncertainImpactIds?.includes(impactId) ?? false;
}

/** 对不确定 Impact 应用 confidence 封顶；确定 Impact 原样返回。 */
export function capUncertainImpactConfidence<
  T extends { id: string; confidence: number },
>(impacts: readonly T[], uncertainImpactIds: readonly string[]): T[] {
  const uncertain = new Set(uncertainImpactIds);
  return impacts.map((impact) =>
    uncertain.has(impact.id)
      ? {
          ...impact,
          confidence: Math.min(
            impact.confidence,
            UNCERTAIN_IMPACT_MAX_CONFIDENCE,
          ),
        }
      : impact,
  );
}

/**
 * 预览实际展示的不确定关系 ID。
 *
 * 新计划使用 `usedUncertainEdgeIds`；旧计划没有该字段时回退到旧的
 * `uncertainEdgeIds`（历史行为可能多算），两者都没有则显示 0。
 */
export function listUsedUncertainEdgeIds(
  plan: Pick<ImpactPlan, "usedUncertainEdgeIds" | "uncertainEdgeIds">,
): string[] {
  return plan.usedUncertainEdgeIds ?? plan.uncertainEdgeIds ?? [];
}

function groupEdgeIdsByStep(
  edges: readonly EdgeEndpoint[],
): Map<string, string[]> {
  const edgeIdsByStep = new Map<string, string[]>();
  for (const edge of edges) {
    const key = stepKey(edge.from, edge.to);
    edgeIdsByStep.set(key, [...(edgeIdsByStep.get(key) ?? []), edge.id]);
  }
  return edgeIdsByStep;
}

function stepKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}
