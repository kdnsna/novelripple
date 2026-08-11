import { z } from "zod";

export const DivergenceSchema = z
  .object({
    id: z.string().min(1),
    eventId: z.string().min(1),
    type: z.enum(["prevent", "alternate_choice", "alternate_outcome"]),
    instruction: z.string().min(1),
  })
  .strict();

export type Divergence = z.infer<typeof DivergenceSchema>;
