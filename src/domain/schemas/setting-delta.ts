import { z } from "zod";

/** 设定词条名与规则说明的输入上限；Schema 与界面共用同一份常量。 */
export const SETTING_DELTA_TERM_NAME_MAX_CHARS = 40;
export const SETTING_DELTA_STATEMENT_MAX_CHARS = 200;

/**
 * 设定增量（setting delta）是读者在某个场景节点新增的短设定规则。
 *
 * 它不是 Canon，也不是 statePatch：沿当前路径可见的设定增量单独进入生成
 * 上下文的 `worldline_setup.settingDeltas`，只影响该节点及其后代。
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

export type SettingDeltaSubject = z.infer<typeof SettingDeltaSubjectSchema>;
export type SettingDeltaV1 = z.infer<typeof SettingDeltaV1Schema>;
