import { z } from "zod";

import {
  ContinuationDirectionsSchema,
  ContinuationSchema,
} from "./continuation";
import { SourceReferenceSchema } from "./source";
import { ImpactPlanSchema } from "./impact-plan";
import { StoryMapSchema } from "./story-map";

export const EvidenceConfirmationSchema = z
  .object({
    eventId: z.string().min(1),
    evidence: SourceReferenceSchema,
  })
  .strict();

export const StoryMapReviewSchema = z
  .object({
    evidenceConfirmations: z.array(EvidenceConfirmationSchema),
  })
  .strict();

const UpdateEventChangeSchema = z
  .object({
    type: z.literal("update_event"),
    eventId: z.string().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().min(1).max(2_000).optional(),
    participants: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine(
    (change) =>
      change.title !== undefined ||
      change.summary !== undefined ||
      change.participants !== undefined,
    { message: "事件修改必须至少包含一个字段" },
  );

export const StoryMapRevisionChangeSchema = z.discriminatedUnion("type", [
  UpdateEventChangeSchema,
  z
    .object({
      type: z.literal("delete_edge"),
      edgeId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("confirm_evidence"),
      eventId: z.string().min(1),
      evidence: SourceReferenceSchema,
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

export const ImpactPlanArtifactSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    sourceId: z.string().min(1),
    storyMapArtifactId: z.string().min(1),
    kind: z.literal("impact_plan"),
    schemaVersion: z.literal(1),
    impactPlan: ImpactPlanSchema,
    basedOnArtifactId: z.string().min(1),
    generationRunId: z.string().min(1).nullable(),
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
      if (artifact.basedOnArtifactId !== artifact.storyMapArtifactId) {
        context.addIssue({
          code: "custom",
          path: ["basedOnArtifactId"],
          message: "候选 Impact Plan 必须直接基于 confirmed Story Map Artifact",
        });
      }
      if (artifact.generationRunId === null) {
        context.addIssue({
          code: "custom",
          path: ["generationRunId"],
          message: "候选 Impact Plan 必须绑定 Generation Run",
        });
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
