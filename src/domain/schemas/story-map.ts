import { z } from "zod";

import { SourceReferenceSchema } from "./source";
import { StateFactIdSchema } from "./state-fact-id";

export const EvidenceKindSchema = z.enum(["fact", "inference"]);

const evidenceUnitIdsShape = {
  evidenceUnitIds: z.array(z.string().min(1)).min(1),
};

export const CharacterSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    role: z.enum([
      "protagonist",
      "antagonist",
      "supporting",
      "deceased",
    ]),
    initialState: z.string().min(1),
  })
  .strict();

const eventShape = {
  id: StateFactIdSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  sequence: z.number().int().positive(),
  participants: z.array(z.string().min(1)).min(1),
  stateChanges: z.array(z.string().min(1)),
  evidenceKind: EvidenceKindSchema,
  confidence: z.number().min(0).max(1).optional(),
};

function requireInferenceConfidence(
  event: { evidenceKind: z.infer<typeof EvidenceKindSchema>; confidence?: number },
  context: z.RefinementCtx,
): void {
  if (event.evidenceKind === "inference" && event.confidence === undefined) {
    context.addIssue({
      code: "custom",
      path: ["confidence"],
      message: "推断事件必须包含置信度",
    });
  }
}

export const EventSchema = z
  .object({ ...eventShape, evidence: z.array(SourceReferenceSchema).min(1) })
  .strict()
  .superRefine((event, context) => {
    requireInferenceConfidence(event, context);
  });

export const StoryMapCandidateEventSchema = z
  .object({
    ...eventShape,
    evidenceKind: EvidenceKindSchema,
    ...evidenceUnitIdsShape,
  })
  .strict()
  .superRefine(requireInferenceConfidence);

const storyEdgeShape = {
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(["causes", "enables", "foreshadows"]),
  explanation: z.string().min(1),
  confidence: z.number().min(0).max(1),
  confirmed: z.boolean(),
};

export const StoryEdgeSchema = z
  .object({ ...storyEdgeShape, evidence: z.array(SourceReferenceSchema).min(1) })
  .strict();

export const StoryMapCandidateEdgeSchema = z
  .object({ ...storyEdgeShape, ...evidenceUnitIdsShape })
  .strict();

const endingCandidateShape = {
  id: StateFactIdSchema,
  targetEventId: z.string().min(1),
  requirement: z.string().min(1),
};

export const EndingCandidateSchema = z
  .object({
    ...endingCandidateShape,
    evidence: z.array(SourceReferenceSchema).min(1),
  })
  .strict();

export const StoryMapCandidateEndingSchema = z
  .object({
    ...endingCandidateShape,
    ...evidenceUnitIdsShape,
  })
  .strict();

const storyMapContentShape = {
  title: z.string().min(1),
  logline: z.string().min(1),
  characters: z.array(CharacterSchema).min(1),
  events: z.array(EventSchema).min(1),
  edges: z.array(StoryEdgeSchema),
  endingCandidates: z.array(EndingCandidateSchema).min(1),
};

export const StoryMapContentSchema = z.object(storyMapContentShape).strict();

/**
 * 分块抽取 / 补抽阶段的人物候选：模型必须区分「具体个体」与「群体/家族/机构」。
 * 只存在于生成过程中；最终的 CharacterSchema 不增加 kind。
 */
export const StoryMapCandidateCharacterSchema = CharacterSchema.extend({
  kind: z.enum(["individual", "group"]),
}).strict();

const storyMapCandidateGraphShape = {
  title: z.string().min(1),
  logline: z.string().min(1),
  events: z.array(StoryMapCandidateEventSchema).min(1),
  edges: z.array(StoryMapCandidateEdgeSchema),
};

export const StoryMapExtractionCandidateSchema = z
  .object({
    ...storyMapCandidateGraphShape,
    characters: z.array(StoryMapCandidateCharacterSchema).min(1),
  })
  .strict();

export const StoryMapContentCandidateSchema = z
  .object({
    ...storyMapCandidateGraphShape,
    characters: z.array(CharacterSchema).min(1),
    endingCandidates: z.array(StoryMapCandidateEndingSchema).min(1),
  })
  .strict();

// ── 分块抽取管线的中间候选（只存在于生成过程中，不持久化）──

/** “还漏了什么”补抽：只返回新增内容，可以为空。 */
export const StoryMapGleaningCandidateSchema = z
  .object({
    characters: z.array(StoryMapCandidateCharacterSchema),
    events: z.array(StoryMapCandidateEventSchema),
    edges: z.array(StoryMapCandidateEdgeSchema),
  })
  .strict();

/**
 * 人名轮次：把各块的人物候选归并成最终名单；每个候选必须恰好归入一个人物，
 * 或明确列入 `rejectedCandidateIds`（只被提及/回忆、群体、只评论的叙事者等）。
 */
export const StoryMapRosterCandidateSchema = z
  .object({
    characters: z
      .array(
        CharacterSchema.extend({
          mergedFrom: z.array(z.string().min(1)).min(1),
        }).strict(),
      )
      .min(1),
    rejectedCandidateIds: z.array(z.string().min(1)),
  })
  .strict();

/** 结局轮次：故事结局 + 人物结局，必要时补充收尾事件。 */
export const StoryMapEndingPassCandidateSchema = z
  .object({
    additionalEvents: z.array(StoryMapCandidateEventSchema),
    endings: z.array(StoryMapCandidateEndingSchema).min(1),
    characterEndings: z.array(
      z
        .object({
          id: StateFactIdSchema,
          characterId: z.string().min(1),
          targetEventId: z.string().min(1),
          fate: z.string().min(1),
          ...evidenceUnitIdsShape,
        })
        .strict(),
    ),
  })
  .strict();

/** 最终合并：指出重复或粒度过细的同场景事件、重复结局，补充跨块因果边，并给出全书标题与梗概。 */
export const StoryMapMergeCandidateSchema = z
  .object({
    title: z.string().min(1),
    logline: z.string().min(1),
    duplicateEventGroups: z.array(
      z
        .object({
          keepEventId: z.string().min(1),
          duplicateEventIds: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    duplicateEndingGroups: z.array(
      z
        .object({
          keepEndingId: z.string().min(1),
          duplicateEndingIds: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    edges: z.array(StoryMapCandidateEdgeSchema),
  })
  .strict();

export const StoryMapSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    sourceId: z.string().min(1),
    version: z.number().int().positive(),
    status: z.enum(["draft", "confirmed"]),
    ...storyMapContentShape,
  })
  .strict();

export type Character = z.infer<typeof CharacterSchema>;
export type StoryMapCandidateCharacter = z.infer<
  typeof StoryMapCandidateCharacterSchema
>;
export type Event = z.infer<typeof EventSchema>;
export type StoryEdge = z.infer<typeof StoryEdgeSchema>;
export type StoryMapContent = z.infer<typeof StoryMapContentSchema>;
export type StoryMapExtractionCandidate = z.infer<
  typeof StoryMapExtractionCandidateSchema
>;
export type StoryMapContentCandidate = z.infer<
  typeof StoryMapContentCandidateSchema
>;
export type StoryMap = z.infer<typeof StoryMapSchema>;
export type StoryMapCandidateEvent = z.infer<typeof StoryMapCandidateEventSchema>;
export type StoryMapCandidateEdge = z.infer<typeof StoryMapCandidateEdgeSchema>;
export type StoryMapCandidateEnding = z.infer<typeof StoryMapCandidateEndingSchema>;
export type StoryMapGleaningCandidate = z.infer<typeof StoryMapGleaningCandidateSchema>;
export type StoryMapRosterCandidate = z.infer<typeof StoryMapRosterCandidateSchema>;
export type StoryMapEndingPassCandidate = z.infer<typeof StoryMapEndingPassCandidateSchema>;
export type StoryMapMergeCandidate = z.infer<typeof StoryMapMergeCandidateSchema>;
