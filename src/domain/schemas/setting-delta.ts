import { z } from "zod";

/** 设定词条名与规则说明的输入上限；Schema 与界面共用同一份常量。 */
export const SETTING_DELTA_TERM_NAME_MAX_CHARS = 40;
export const SETTING_DELTA_STATEMENT_MAX_CHARS = 200;

/**
 * 设定增量（setting delta）是读者在某个场景节点新增的短设定规则。
 *
 * 它不是 Canon，也不是 statePatch：沿当前路径可见的设定增量单独进入生成
 * 上下文的可裁剪 `setting_deltas` 段，只影响该节点及其后代；停用/软删除
 * 由不可变的 `setting_delta_lifecycle` Artifact 表达，不 UPDATE 本行。
 */
export const SettingDeltaSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("character"),
      characterId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("term"),
      name: z
        .string()
        .trim()
        .min(1)
        .max(SETTING_DELTA_TERM_NAME_MAX_CHARS),
    })
    .strict(),
]);

export const SettingDeltaV1Schema = z
  .object({
    id: z.string().min(1),
    worldlineId: z.string().min(1),
    /** null 表示从分歧点起整条世界线生效。 */
    anchorSceneId: z.string().min(1).nullable(),
    subject: SettingDeltaSubjectSchema,
    statement: z
      .string()
      .trim()
      .min(1)
      .max(SETTING_DELTA_STATEMENT_MAX_CHARS),
    contentKind: z.literal("user"),
    createdAt: z.iso.datetime(),
  })
  .strict();

/**
 * 设定增量的不可变生命周期事件。
 *
 * Artifact 只追加：停用、重新启用与软删除都不 UPDATE 原 `setting_delta` 行，
 * 而是新增一条 `setting_delta_lifecycle`。同一 targetDeltaId 的需求按
 * (createdAt, id) 取最新一条生效。
 */
export const SettingDeltaLifecycleStatusSchema = z.enum([
  "deactivated",
  "reactivated",
  "deleted",
]);

export const SettingDeltaLifecycleV1Schema = z
  .object({
    id: z.string().min(1),
    worldlineId: z.string().min(1),
    targetDeltaId: z.string().min(1),
    status: SettingDeltaLifecycleStatusSchema,
    contentKind: z.literal("user"),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type SettingDeltaSubject = z.infer<typeof SettingDeltaSubjectSchema>;
export type SettingDeltaV1 = z.infer<typeof SettingDeltaV1Schema>;
export type SettingDeltaLifecycleStatus = z.infer<
  typeof SettingDeltaLifecycleStatusSchema
>;
export type SettingDeltaLifecycleV1 = z.infer<
  typeof SettingDeltaLifecycleV1Schema
>;
