import { z } from "zod";

export const SourceReferenceSchema = z
  .object({
    sourceId: z.string().min(1),
    sectionId: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    excerptHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
  .refine((reference) => reference.start < reference.end, {
    message: "SourceReference 必须是非空范围",
    path: ["end"],
  });

export const SourceSectionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();

export const SourceSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().min(1),
    originalText: z.string().min(1),
    normalizedText: z.string().min(1),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sections: z.array(SourceSectionSchema).min(1),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type Source = z.infer<typeof SourceSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type SourceSection = z.infer<typeof SourceSectionSchema>;
