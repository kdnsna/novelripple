import { z } from "zod";

import { DivergenceSchema } from "./divergence";
import { StateFactIdSchema } from "./state-fact-id";

export const ReasonPathSchema = z
  .array(z.string().min(1))
  .min(1)
  .superRefine((reasonPath, context) => {
    const seen = new Set<string>();
    reasonPath.forEach((eventId, index) => {
      if (seen.has(eventId)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `reasonPath 不得重复 Event：${eventId}`,
        });
      }
      seen.add(eventId);
    });
  });

export const AnchorSchema = z
  .object({
    id: StateFactIdSchema,
    targetEventId: z.string().min(1),
    requirement: z.string().min(1),
    strength: z.literal("hard"),
  })
  .strict();

export const AnchorEvaluationSchema = z
  .object({
    anchorId: z.string().min(1),
    status: z.enum(["preserved", "rerouted", "threatened", "incompatible"]),
    explanation: z.string().min(1),
    reasonPath: ReasonPathSchema,
  })
  .strict();

export const ImpactItemSchema = z
  .object({
    id: StateFactIdSchema,
    scope: z.enum(["direct", "downstream", "ending"]),
    changeType: z.enum(["added", "modified", "removed", "preserved"]),
    fromEventId: z.string().min(1),
    affectedEventId: z.string().min(1).nullable(),
    summary: z.string().min(1),
    explanation: z.string().min(1),
    reasonPath: ReasonPathSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const CharacterChangeSchema = z
  .object({
    characterId: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

export const ThreadChangesSchema = z
  .object({
    opened: z.array(z.string().min(1)),
    closed: z.array(z.string().min(1)),
  })
  .strict();

export const ImpactPlanModelOutputSchema = z
  .object({
    impacts: z.array(ImpactItemSchema).min(1),
    characterChanges: z.array(CharacterChangeSchema),
    threadChanges: ThreadChangesSchema,
    anchorEvaluations: z.array(AnchorEvaluationSchema),
    uncertainties: z.array(z.string().min(1)),
  })
  .strict();

export const ImpactPlanSchema = z
  .object({
    id: z.string().min(1),
    storyMapId: z.string().min(1),
    mode: z.enum(["strict", "open"]),
    divergence: DivergenceSchema,
    anchors: z.array(AnchorSchema),
    impacts: z.array(ImpactItemSchema).min(1),
    characterChanges: z.array(CharacterChangeSchema),
    threadChanges: ThreadChangesSchema,
    anchorEvaluations: z.array(AnchorEvaluationSchema),
    uncertainties: z.array(z.string().min(1)),
    /**
     * 生成该计划时，确认 Story Map 中被判为“不确定”的 Edge ID。
     * 旧 Artifact 没有该字段仍可解析；下游 Continuation/Worldline 忽略它。
     */
    uncertainEdgeIds: z.array(z.string().min(1)).optional(),
    /**
     * 服务端确定性标记：reasonPath 全程只由不确定 Edge 支撑的 Impact ID。
     * 这些 Impact 在 UI 中只能作为“可能”展示。
     */
    uncertainImpactIds: z.array(z.string().min(1)).optional(),
    /**
     * 本次计划实际用到的（作为某项 Impact reasonPath 相邻两步出现的）
     * 不确定 Edge ID，按首次使用顺序去重。旧 Artifact 没有该字段；
     * 预览摘要按该字段计数，缺失时回退到 `uncertainEdgeIds`。
     */
    usedUncertainEdgeIds: z.array(z.string().min(1)).optional(),
    status: z.enum(["candidate", "accepted", "rejected"]),
  })
  .strict()
  .superRefine((plan, context) => {
    // 不确定项只是服务端派生的索引，必须指向本计划内真实存在的对象。
    // 旧 Artifact 缺少这些字段时保持原样，下面的检查自然跳过。
    const impactIds = new Set(plan.impacts.map((impact) => impact.id));
    for (const [field, values] of [
      ["uncertainEdgeIds", plan.uncertainEdgeIds],
      ["uncertainImpactIds", plan.uncertainImpactIds],
      ["usedUncertainEdgeIds", plan.usedUncertainEdgeIds],
    ] as const) {
      if (!values) continue;
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            path: [field, index],
            message: `${field} 不得重复：${value}`,
          });
        }
        seen.add(value);
      });
    }
    plan.uncertainImpactIds?.forEach((impactId, index) => {
      if (!impactIds.has(impactId)) {
        context.addIssue({
          code: "custom",
          path: ["uncertainImpactIds", index],
          message: `uncertainImpactIds 引用了本计划中不存在的 Impact：${impactId}`,
        });
      }
    });
    if (plan.uncertainEdgeIds && plan.usedUncertainEdgeIds) {
      const uncertainEdgeIds = new Set(plan.uncertainEdgeIds);
      plan.usedUncertainEdgeIds.forEach((edgeId, index) => {
        if (!uncertainEdgeIds.has(edgeId)) {
          context.addIssue({
            code: "custom",
            path: ["usedUncertainEdgeIds", index],
            message: `usedUncertainEdgeIds 必须是 uncertainEdgeIds 的子集：${edgeId}`,
          });
        }
      });
    }

    if (plan.mode === "open") {
      if (plan.anchors.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["anchors"],
          message: "开放模式不能包含结局 Anchor",
        });
      }
      if (plan.anchorEvaluations.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["anchorEvaluations"],
          message: "开放模式不能包含 Anchor 评估",
        });
      }
      return;
    }

    if (plan.anchors.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["anchors"],
        message: "严格模式必须至少选择一个结局 Anchor",
      });
    }
  });

export type Anchor = z.infer<typeof AnchorSchema>;
export type AnchorEvaluation = z.infer<typeof AnchorEvaluationSchema>;
export type ImpactItem = z.infer<typeof ImpactItemSchema>;
export type CharacterChange = z.infer<typeof CharacterChangeSchema>;
export type ThreadChanges = z.infer<typeof ThreadChangesSchema>;
export type ImpactPlanModelOutput = z.infer<
  typeof ImpactPlanModelOutputSchema
>;
export type ImpactPlan = z.infer<typeof ImpactPlanSchema>;
