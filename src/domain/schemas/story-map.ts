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

export const StoryMapExtractionCandidateSchema = z
  .object({
    title: z.string().min(1),
    logline: z.string().min(1),
    characters: z.array(CharacterSchema).min(1),
    events: z.array(StoryMapCandidateEventSchema).min(1),
    edges: z.array(StoryMapCandidateEdgeSchema),
  })
  .strict();

export const StoryMapContentCandidateSchema =
  StoryMapExtractionCandidateSchema.extend({
    endingCandidates: z.array(StoryMapCandidateEndingSchema).min(1),
  });

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
