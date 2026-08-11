import { z } from "zod";

import { DivergenceSchema } from "./divergence";
import { StateFactIdSchema } from "./state-fact-id";

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
    reasonPath: z.array(z.string().min(1)).min(1),
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
    reasonPath: z.array(z.string().min(1)).min(1),
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
    status: z.enum(["candidate", "accepted", "rejected"]),
  })
  .strict()
  .superRefine((plan, context) => {
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
