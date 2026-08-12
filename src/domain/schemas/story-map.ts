import { z } from "zod";

import { SourceReferenceSchema } from "./source";
import { StateFactIdSchema } from "./state-fact-id";

export const EvidenceKindSchema = z.enum(["fact", "inference"]);

export const EvidenceClaimSchema = z
  .object({
    sectionId: z.string().min(1),
    exactQuote: z.string().min(1),
  })
  .strict();

const evidenceReferenceIdsShape = {
  evidenceReferenceIds: z.array(z.string().min(1)).min(1),
};

const characterShape = {
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  role: z.enum(["protagonist", "antagonist", "supporting", "deceased"]),
  initialState: z.string().min(1),
};

export const CharacterSchema = z
  .object({ id: z.string().min(1), ...characterShape })
  .strict();

export const LocalCharacterCandidateSchema = z
  .object({ localId: z.string().min(1), ...characterShape })
  .strict();

const eventContentShape = {
  title: z.string().min(1),
  summary: z.string().min(1),
  sequence: z.number().int().positive(),
  participants: z.array(z.string().min(1)).min(1),
  stateChanges: z.array(z.string().min(1)),
  evidenceKind: EvidenceKindSchema,
  confidence: z.number().min(0).max(1).optional(),
};

const eventShape = {
  id: StateFactIdSchema,
  ...eventContentShape,
};

function requireInferenceConfidence(
  event: {
    evidenceKind: z.infer<typeof EvidenceKindSchema>;
    confidence?: number;
  },
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
  .superRefine(requireInferenceConfidence);

export const LocalEventCandidateSchema = z
  .object({
    localId: z.string().min(1),
    ...eventContentShape,
    evidence: z.array(EvidenceClaimSchema).min(1),
  })
  .strict()
  .superRefine(requireInferenceConfidence);

export const ReconciledEventCandidateSchema = z
  .object({ ...eventShape, ...evidenceReferenceIdsShape })
  .strict()
  .superRefine(requireInferenceConfidence);

const storyEdgeContentShape = {
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(["causes", "enables", "foreshadows"]),
  explanation: z.string().min(1),
  confidence: z.number().min(0).max(1),
  confirmed: z.boolean(),
};

const storyEdgeShape = {
  id: z.string().min(1),
  ...storyEdgeContentShape,
};

export const StoryEdgeSchema = z
  .object({ ...storyEdgeShape, evidence: z.array(SourceReferenceSchema).min(1) })
  .strict();

export const LocalStoryEdgeCandidateSchema = z
  .object({
    localId: z.string().min(1),
    ...storyEdgeContentShape,
    evidence: z.array(EvidenceClaimSchema).min(1),
  })
  .strict();

export const ReconciledStoryEdgeCandidateSchema = z
  .object({ ...storyEdgeShape, ...evidenceReferenceIdsShape })
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

export const ReconciledEndingCandidateSchema = z
  .object({ ...endingCandidateShape, ...evidenceReferenceIdsShape })
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

export const StoryMapLocalExtractionCandidateSchema = z
  .object({
    characters: z.array(LocalCharacterCandidateSchema),
    events: z.array(LocalEventCandidateSchema),
    edges: z.array(LocalStoryEdgeCandidateSchema),
  })
  .strict();

export const StoryMapReconciliationCandidateSchema = z
  .object({
    title: z.string().min(1),
    logline: z.string().min(1),
    characters: z.array(CharacterSchema).min(1),
    events: z.array(ReconciledEventCandidateSchema).min(1),
    edges: z.array(ReconciledStoryEdgeCandidateSchema),
    endingCandidates: z.array(ReconciledEndingCandidateSchema).min(1),
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
export type Event = z.infer<typeof EventSchema>;
export type StoryEdge = z.infer<typeof StoryEdgeSchema>;
export type EvidenceClaim = z.infer<typeof EvidenceClaimSchema>;
export type StoryMapContent = z.infer<typeof StoryMapContentSchema>;
export type StoryMapLocalExtractionCandidate = z.infer<
  typeof StoryMapLocalExtractionCandidateSchema
>;
export type StoryMapReconciliationCandidate = z.infer<
  typeof StoryMapReconciliationCandidateSchema
>;
export type StoryMap = z.infer<typeof StoryMapSchema>;
