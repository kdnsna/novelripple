import { z } from "zod";

export const RippleSuggestionSchema = z
  .object({
    eventId: z.string().min(1),
    divergenceType: z.enum(["prevent", "choice", "outcome"]),
    instruction: z.string().trim().min(1).max(500),
    whyInteresting: z.string().trim().min(1).max(1_000),
    affectedCharacterIds: z.array(z.string().min(1)).min(1),
    anchorRisk: z.enum(["low", "medium", "high"]),
  })
  .strict();

export const RippleSuggestionsModelOutputSchema = z
  .object({
    suggestions: z.array(RippleSuggestionSchema).min(1).max(3),
  })
  .strict();

export type RippleSuggestion = z.infer<typeof RippleSuggestionSchema>;
export type RippleSuggestionsModelOutput = z.infer<
  typeof RippleSuggestionsModelOutputSchema
>;
