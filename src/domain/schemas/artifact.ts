import { z } from "zod";

import {
  ContinuationDirectionsSchema,
  ContinuationSchema,
} from "./continuation";
import { SourceReferenceSchema } from "./source";
import { ImpactPlanSchema } from "./impact-plan";
import { EvidenceKindSchema, StoryMapSchema } from "./story-map";
import { RippleSuggestionSchema } from "./ripple-suggestion";

export const EvidenceConfirmationSchema = z
  .object({
    eventId: z.string().min(1),
    evidence: SourceReferenceSchema,
  })
  .strict();

export const EdgeEvidenceConfirmationSchema = z
  .object({
    edgeId: z.string().min(1),
    evidence: SourceReferenceSchema,
  })
  .strict();

export const StoryMapReviewOperationTypeSchema = z.enum([
  "update_character",
  "merge_characters",
  "confirm_character",
  "update_event",
  "delete_event",
  "add_event",
  "reorder_events",
  "delete_edge",
  "add_edge",
  "update_edge",
  "confirm_evidence",
  "confirm_edge_evidence",
  "confirm_ending_candidate",
  "confirm_story_map",
]);

export const StoryMapReviewOperationSchema = z
  .object({
    type: StoryMapReviewOperationTypeSchema,
    timestamp: z.iso.datetime(),
    storyMapVersion: z.number().int().positive(),
  })
  .strict();

export const StoryMapReviewSchema = z
  .object({
    evidenceConfirmations: z.array(EvidenceConfirmationSchema),
    edgeEvidenceConfirmations: z
      .array(EdgeEvidenceConfirmationSchema)
      .default([]),
    characterConfirmations: z.array(z.string().min(1)).default([]),
    endingCandidateConfirmations: z.array(z.string().min(1)).default([]),
    operation: StoryMapReviewOperationSchema.nullable().default(null),
  })
  .strict();

const UpdateCharacterChangeSchema = z
  .object({
    type: z.literal("update_character"),
    characterId: z.string().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    aliases: z.array(z.string().trim().min(1).max(200)).optional(),
    role: z
      .enum(["protagonist", "antagonist", "supporting", "deceased"])
      .optional(),
  })
  .strict()
  .refine(
    (change) =>
      change.name !== undefined ||
      change.aliases !== undefined ||
      change.role !== undefined,
    { message: "人物修改必须至少包含一个字段" },
  );

const UpdateEventChangeSchema = z
  .object({
    type: z.literal("update_event"),
    eventId: z.string().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().min(1).max(2_000).optional(),
    participants: z.array(z.string().min(1)).min(1).optional(),
    stateChanges: z.array(z.string().trim().min(1).max(1_000)).optional(),
    evidenceKind: EvidenceKindSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine(
    (change) =>
      change.title !== undefined ||
      change.summary !== undefined ||
      change.participants !== undefined ||
      change.stateChanges !== undefined ||
      change.evidenceKind !== undefined ||
      change.confidence !== undefined,
    { message: "事件修改必须至少包含一个字段" },
  );

const UpdateEdgeChangeSchema = z
  .object({
    type: z.literal("update_edge"),
    edgeId: z.string().min(1),
    edgeType: z.enum(["causes", "enables", "foreshadows"]).optional(),
    explanation: z.string().trim().min(1).max(2_000).optional(),
    evidence: z.array(SourceReferenceSchema).min(1).optional(),
  })
  .strict()
  .refine(
    (change) =>
      change.edgeType !== undefined ||
      change.explanation !== undefined ||
      change.evidence !== undefined,
    { message: "Edge 修改必须至少包含一个字段" },
  );

export const StoryMapRevisionChangeSchema = z.discriminatedUnion("type", [
  UpdateCharacterChangeSchema,
  z
    .object({
      type: z.literal("merge_characters"),
      targetCharacterId: z.string().min(1),
      mergedCharacterIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("confirm_character"),
      characterId: z.string().min(1),
    })
    .strict(),
  UpdateEventChangeSchema,
  z
    .object({
      type: z.literal("delete_event"),
      eventId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("add_event"),
      title: z.string().trim().min(1).max(200),
      summary: z.string().trim().min(1).max(2_000),
      participants: z.array(z.string().min(1)).min(1),
      stateChanges: z.array(z.string().trim().min(1).max(1_000)),
      evidenceKind: EvidenceKindSchema,
      confidence: z.number().min(0).max(1).optional(),
      evidence: z.array(SourceReferenceSchema).min(1),
    })
    .strict()
    .superRefine((change, context) => {
      if (change.evidenceKind === "inference" && change.confidence === undefined) {
        context.addIssue({
          code: "custom",
          path: ["confidence"],
          message: "推断事件必须包含置信度",
        });
      }
    }),
  z
    .object({
      type: z.literal("reorder_events"),
      eventIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("delete_edge"),
      edgeId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("add_edge"),
      from: z.string().min(1),
      to: z.string().min(1),
      edgeType: z.enum(["causes", "enables", "foreshadows"]),
      explanation: z.string().trim().min(1).max(2_000),
      evidence: z.array(SourceReferenceSchema).min(1),
    })
    .strict(),
  UpdateEdgeChangeSchema,
  z
    .object({
      type: z.literal("confirm_evidence"),
      eventId: z.string().min(1),
      evidence: SourceReferenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("confirm_edge_evidence"),
      edgeId: z.string().min(1),
      evidence: SourceReferenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("confirm_ending_candidate"),
      endingCandidateId: z.string().min(1),
    })
    .strict(),
]);

export const StoryMapArtifactSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    sourceId: z.string().min(1),
    kind: z.enum(["story_map", "story_map_revision"]),
    schemaVersion: z.literal(2),
    version: z.number().int().positive(),
    storyMap: StoryMapSchema,
    review: StoryMapReviewSchema,
    basedOnArtifactId: z.string().min(1).nullable(),
    generationRunId: z.string().min(1).nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.storyMap.sourceId !== artifact.sourceId) {
      context.addIssue({
        code: "custom",
        path: ["storyMap", "sourceId"],
        message: "Artifact 与 Story Map 必须绑定同一 Source",
      });
    }
    if (artifact.storyMap.version !== artifact.version) {
      context.addIssue({
        code: "custom",
        path: ["storyMap", "version"],
        message: "Artifact 与 Story Map 版本必须一致",
      });
    }
    if (artifact.version === 1 && artifact.kind !== "story_map") {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "首个 Story Map Artifact 类型必须是 story_map",
      });
    }
    if (artifact.version > 1 && artifact.kind !== "story_map_revision") {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "后续 Story Map Artifact 类型必须是 story_map_revision",
      });
    }
  });

const ImpactPlanFeedbackLineageSchema = z
  .object({
    priorCandidateArtifactId: z.string().min(1),
    feedback: z.string().trim().min(1).max(2_000),
    newGenerationRunId: z.string().min(1),
    sameStoryMapArtifactId: z.string().min(1),
    sameDivergence: ImpactPlanSchema.shape.divergence,
    sameMode: ImpactPlanSchema.shape.mode,
    sameAnchors: ImpactPlanSchema.shape.anchors,
  })
  .strict();

export const ImpactPlanArtifactSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    sourceId: z.string().min(1),
    storyMapArtifactId: z.string().min(1),
    kind: z.literal("impact_plan"),
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    impactPlan: ImpactPlanSchema,
    basedOnArtifactId: z.string().min(1),
    generationRunId: z.string().min(1).nullable(),
    lineage: ImpactPlanFeedbackLineageSchema.nullable().default(null),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.impactPlan.id !== artifact.id) {
      context.addIssue({
        code: "custom",
        path: ["impactPlan", "id"],
        message: "Impact Plan Artifact 与领域对象必须使用同一 ID",
      });
    }
    if (artifact.impactPlan.status === "candidate") {
      if (artifact.generationRunId === null) {
        context.addIssue({
          code: "custom",
          path: ["generationRunId"],
          message: "候选 Impact Plan 必须绑定 Generation Run",
        });
      }
      if (artifact.lineage === null) {
        if (
          artifact.schemaVersion !== 1 ||
          artifact.basedOnArtifactId !== artifact.storyMapArtifactId
        ) {
          context.addIssue({
            code: "custom",
            path: ["basedOnArtifactId"],
            message: "首个候选 Impact Plan 必须直接基于 confirmed Story Map Artifact",
          });
        }
      } else {
        const lineage = artifact.lineage;
        const frozenContractMatches =
          lineage.priorCandidateArtifactId === artifact.basedOnArtifactId &&
          lineage.newGenerationRunId === artifact.generationRunId &&
          lineage.sameStoryMapArtifactId === artifact.storyMapArtifactId &&
          lineage.sameMode === artifact.impactPlan.mode &&
          JSON.stringify(lineage.sameDivergence) ===
            JSON.stringify(artifact.impactPlan.divergence) &&
          JSON.stringify(lineage.sameAnchors) ===
            JSON.stringify(artifact.impactPlan.anchors);
        if (artifact.schemaVersion !== 2 || !frozenContractMatches) {
          context.addIssue({
            code: "custom",
            path: ["lineage"],
            message: "反馈候选必须保持 Story Map、Divergence、模式与 Anchor 不变",
          });
        }
      }
    } else {
      if (artifact.basedOnArtifactId === artifact.storyMapArtifactId) {
        context.addIssue({
          code: "custom",
          path: ["basedOnArtifactId"],
          message: "人工决策 revision 必须基于候选 Impact Plan Artifact",
        });
      }
      if (artifact.generationRunId !== null) {
        context.addIssue({
          code: "custom",
          path: ["generationRunId"],
          message: "人工决策 revision 不得伪装成模型生成结果",
        });
      }
      if (artifact.schemaVersion !== 1 || artifact.lineage !== null) {
        context.addIssue({
          code: "custom",
          path: ["lineage"],
          message: "人工决策 revision 不得携带模型反馈 lineage",
        });
      }
    }
  });

export const RippleSuggestionsArtifactSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    sourceId: z.string().min(1),
    storyMapArtifactId: z.string().min(1),
    kind: z.literal("ripple_suggestions"),
    schemaVersion: z.literal(1),
    suggestions: z.array(RippleSuggestionSchema).min(1).max(3),
    basedOnArtifactId: z.string().min(1),
    generationRunId: z.string().min(1),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.basedOnArtifactId !== artifact.storyMapArtifactId) {
      context.addIssue({
        code: "custom",
        path: ["basedOnArtifactId"],
        message: "Ripple Suggestions 必须直接基于 confirmed Story Map Artifact",
      });
    }
  });

const ContinuationArtifactBaseSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    sourceId: z.string().min(1),
    worldlineId: z.string().min(1),
    kind: z.literal("continuation"),
    schemaVersion: z.literal(1),
    basedOnArtifactId: z.string().min(1),
    generationRunId: z.string().min(1),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const ContinuationDirectionsArtifactSchema =
  ContinuationArtifactBaseSchema.extend({
    artifactType: z.literal("directions"),
    continuation: ContinuationDirectionsSchema,
  })
    .strict()
    .superRefine((artifact, context) => {
      if (
        artifact.continuation.id !== artifact.id ||
        artifact.continuation.worldlineId !== artifact.worldlineId
      ) {
        context.addIssue({
          code: "custom",
          path: ["continuation"],
          message: "后续方向 Artifact 与领域对象引用不一致",
        });
      }
      if (
        artifact.continuation.acceptedImpactPlanId !==
        artifact.basedOnArtifactId
      ) {
        context.addIssue({
          code: "custom",
          path: ["basedOnArtifactId"],
          message: "后续方向必须直接基于 accepted Impact Plan Artifact",
        });
      }
    });

export const ContinuationSceneArtifactSchema =
  ContinuationArtifactBaseSchema.extend({
    artifactType: z.literal("scene"),
    continuation: ContinuationSchema,
  })
    .strict()
    .superRefine((artifact, context) => {
      if (
        artifact.continuation.id !== artifact.id ||
        artifact.continuation.worldlineId !== artifact.worldlineId
      ) {
        context.addIssue({
          code: "custom",
          path: ["continuation"],
          message: "后续场景 Artifact 与领域对象引用不一致",
        });
      }
      if (
        artifact.continuation.directionsArtifactId !==
        artifact.basedOnArtifactId
      ) {
        context.addIssue({
          code: "custom",
          path: ["basedOnArtifactId"],
          message: "后续场景必须直接基于方向 Artifact",
        });
      }
    });

export const ContinuationArtifactSchema = z.discriminatedUnion(
  "artifactType",
  [ContinuationDirectionsArtifactSchema, ContinuationSceneArtifactSchema],
);

export type StoryMapArtifact = z.infer<typeof StoryMapArtifactSchema>;
export type ImpactPlanArtifact = z.infer<typeof ImpactPlanArtifactSchema>;
export type ImpactPlanFeedbackLineage = z.infer<
  typeof ImpactPlanFeedbackLineageSchema
>;
export type RippleSuggestionsArtifact = z.infer<
  typeof RippleSuggestionsArtifactSchema
>;
export type ContinuationDirectionsArtifact = z.infer<
  typeof ContinuationDirectionsArtifactSchema
>;
export type ContinuationSceneArtifact = z.infer<
  typeof ContinuationSceneArtifactSchema
>;
export type ContinuationArtifact = z.infer<typeof ContinuationArtifactSchema>;
export type StoryMapReview = z.infer<typeof StoryMapReviewSchema>;
export type StoryMapRevisionChange = z.infer<
  typeof StoryMapRevisionChangeSchema
>;
