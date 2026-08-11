import { z } from "zod";

import { StateFactIdSchema } from "./state-fact-id";

export const DivergenceSchema = z
  .object({
    id: StateFactIdSchema,
    eventId: z.string().min(1),
    type: z.enum(["prevent", "choice", "outcome"]),
    instruction: z.string().min(1),
  })
  .strict();

export type Divergence = z.infer<typeof DivergenceSchema>;
