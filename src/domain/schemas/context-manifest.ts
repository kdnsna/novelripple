import { z } from "zod";

export const ContextManifestSectionKindSchema = z.enum([
  "worldline_setup",
  "path_summary",
  "canon_evidence",
  "recent_scenes",
  "selected_direction",
  "anchor_reminder",
]);

/**
 * 上下文清单只记录“组装了什么”，不保存任何正文或原文。
 * 字段仅允许段名、条目 id 与字符计数，`.strict()` 保证不会混入 prose。
 */
export const ContextManifestSectionSchema = z
  .object({
    kind: ContextManifestSectionKindSchema,
    included: z.boolean(),
    chars: z.number().int().min(0),
    trimmed: z.boolean(),
    droppedItemIds: z.array(z.string()),
  })
  .strict();

export const ContextManifestBudgetSchema = z
  .object({
    totalChars: z.number().int().min(0),
    maxChars: z.number().int().positive(),
    percentageUsed: z.number().min(0).max(100),
  })
  .strict();

export const ContextManifestSchema = z
  .object({
    budget: ContextManifestBudgetSchema,
    sections: z.array(ContextManifestSectionSchema),
  })
  .strict();

export type ContextManifestSectionKind = z.infer<
  typeof ContextManifestSectionKindSchema
>;
export type ContextManifestSection = z.infer<typeof ContextManifestSectionSchema>;
export type ContextManifestBudget = z.infer<typeof ContextManifestBudgetSchema>;
export type ContextManifest = z.infer<typeof ContextManifestSchema>;
