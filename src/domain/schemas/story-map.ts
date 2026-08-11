import { z } from "zod";

export const EvidenceKindSchema = z.enum(["fact", "inference", "generated"]);

export const EvidenceReferenceSchema = z
  .object({
    sourceId: z.string().min(1),
    sectionId: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    excerptHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

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

export const StoryEventSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    sequence: z.number().int().positive(),
    participants: z.array(z.string().min(1)).min(1),
    stateChanges: z.array(z.string().min(1)),
    evidenceKind: EvidenceKindSchema,
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.array(EvidenceReferenceSchema),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.evidenceKind !== "generated" && event.evidence.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "事实与推断事件必须包含原文证据",
      });
    }

    if (event.evidenceKind === "inference" && event.confidence === undefined) {
      context.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "推断事件必须包含置信度",
      });
    }
  });

export const StoryEdgeSchema = z
  .object({
    id: z.string().min(1),
    sourceEventId: z.string().min(1),
    targetEventId: z.string().min(1),
    type: z.enum(["causes", "enables", "foreshadows"]),
    explanation: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidence: z.array(EvidenceReferenceSchema).min(1),
    confirmed: z.boolean(),
  })
  .strict();

export const EndingCandidateSchema = z
  .object({
    id: z.string().min(1),
    targetEventId: z.string().min(1),
    requirement: z.string().min(1),
    evidence: z.array(EvidenceReferenceSchema).min(1),
  })
  .strict();

export const StoryMapSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    version: z.number().int().positive(),
    status: z.enum(["draft", "confirmed"]),
    title: z.string().min(1),
    logline: z.string().min(1),
    characters: z.array(CharacterSchema).min(1),
    events: z.array(StoryEventSchema).min(1),
    edges: z.array(StoryEdgeSchema),
    endingCandidates: z.array(EndingCandidateSchema).min(1),
  })
  .strict();

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type StoryCharacter = z.infer<typeof CharacterSchema>;
export type StoryEvent = z.infer<typeof StoryEventSchema>;
export type StoryEdge = z.infer<typeof StoryEdgeSchema>;
export type StoryMap = z.infer<typeof StoryMapSchema>;
