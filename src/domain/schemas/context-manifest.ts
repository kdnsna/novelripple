import { z } from "zod";

export const ContextManifestSectionKindSchema = z.enum([
  "worldline_setup",
  "canon_events",
  "setting_deltas",
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
    /** 被整体丢弃的条目 id（证据、设定增量、旧场景、路径摘要行）。 */
    droppedItemIds: z.array(z.string()),
    /** 用自身摘要替换正文的条目 id（当前只会是最新场景）。 */
    summarizedItemIds: z.array(z.string()).optional(),
    /** 因没有可用摘要而被句末截断的条目 id（v1 场景）。 */
    truncatedItemIds: z.array(z.string()).optional(),
    /** 本分支期间旧 manifest 可能写入的回填证据 id；新 manifest 不再写入，仅为解析兼容保留。 */
    backfilledItemIds: z.array(z.string()).optional(),
    /** worldline_setup 启用紧凑形式时实际移除的字段名，不含正文。 */
    compactedFields: z.array(z.string()).optional(),
    /** 只记录条目 id，供路径摘要说明实际覆盖了哪些场景。 */
    coveredItemIds: z.array(z.string()).optional(),
    watermarkId: z.string().nullable().optional(),
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
