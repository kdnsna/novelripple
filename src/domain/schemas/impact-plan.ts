import { z } from "zod";

import { DivergenceSchema } from "./divergence";

export const AnchorSchema = z
  .object({
    id: z.string().min(1),
    targetEventId: z.string().min(1),
    requirement: z.string().min(1),
    strength: z.enum(["hard", "soft"]),
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
    id: z.string().min(1),
    horizon: z.enum(["immediate", "midterm", "ending"]),
    changeType: z.enum(["added", "modified", "removed", "preserved"]),
    summary: z.string().min(1),
    explanation: z.string().min(1),
    reasonPath: z.array(z.string().min(1)).min(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const ImpactPlanSchema = z
  .object({
    id: z.string().min(1),
    storyMapId: z.string().min(1),
    divergence: DivergenceSchema,
    anchors: z.array(AnchorSchema),
    impacts: z.array(ImpactItemSchema).min(1),
    characterChanges: z.array(z.string().min(1)),
    threadChanges: z.array(z.string().min(1)),
    anchorEvaluations: z.array(AnchorEvaluationSchema),
    uncertainties: z.array(z.string().min(1)),
    status: z.enum(["candidate", "accepted", "rejected"]),
  })
  .strict();

export type Anchor = z.infer<typeof AnchorSchema>;
export type AnchorEvaluation = z.infer<typeof AnchorEvaluationSchema>;
export type ImpactItem = z.infer<typeof ImpactItemSchema>;
export type ImpactPlan = z.infer<typeof ImpactPlanSchema>;
