import { z } from "zod";

export const ProjectSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;
