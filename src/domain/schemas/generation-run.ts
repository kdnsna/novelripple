import { z } from "zod";

export const GenerationRunStatusSchema = z.enum([
  "pending",
  "succeeded",
  "failed",
]);

export const GenerationRunSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    worldlineId: z.string().min(1).nullable(),
    kind: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: GenerationRunStatusSchema,
    rawOutput: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.status === "pending") {
      if (run.completedAt !== null) {
        context.addIssue({
          code: "custom",
          path: ["completedAt"],
          message: "pending run cannot have completedAt",
        });
      }
      if (run.error !== null) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "pending run cannot have an error",
        });
      }
    }

    if (run.status === "succeeded") {
      if (run.completedAt === null) {
        context.addIssue({
          code: "custom",
          path: ["completedAt"],
          message: "succeeded run requires completedAt",
        });
      }
      if (run.rawOutput === null) {
        context.addIssue({
          code: "custom",
          path: ["rawOutput"],
          message: "succeeded run requires rawOutput",
        });
      }
      if (run.error !== null) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "succeeded run cannot have an error",
        });
      }
    }

    if (run.status === "failed") {
      if (run.completedAt === null) {
        context.addIssue({
          code: "custom",
          path: ["completedAt"],
          message: "failed run requires completedAt",
        });
      }
      if (run.error === null) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "failed run requires an error",
        });
      }
    }
  });

export type GenerationRun = z.infer<typeof GenerationRunSchema>;
export type GenerationRunStatus = z.infer<typeof GenerationRunStatusSchema>;
