import { z } from "zod";

/** 设定词条名与规则说明的输入上限；Schema 与界面共用同一份常量。 */
export const SETTING_DELTA_TERM_NAME_MAX_CHARS = 40;
export const SETTING_DELTA_STATEMENT_MAX_CHARS = 200;

/** 输入里出现不可见或畸形字符时统一使用这条中文说明。 */
export const SETTING_DELTA_FORBIDDEN_CHAR_MESSAGE =
  "设定说明/词条名不能包含控制字符、不可见字符或换行";

/**
 * 不可见/畸形字符按 Unicode 大类拒收：
 * - Cc：C0/C1 控制字符（含 \n \r \t、DEL）；
 * - Cf：格式字符（零宽 U+200B/U+200D/FEFF/00AD、方向控制符、标签字符等）；
 * - Cs：孤立代理码位；
 * - Co：私用区字符；
 * - Zl/Zp：行/段分隔符。
 *
 * 变体选择符（U+FE00–FE0F、U+E0100–E01EF）不在上述大类里，单独拒收。
 * 这些字符既不能稳定显示，也会让“写时测量”和 Prompt 实际渲染长度脱节。
 */
const SETTING_DELTA_FORBIDDEN_CATEGORY =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const SETTING_DELTA_VARIATION_SELECTOR =
  /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;

/**
 * 返回第一个不可见/畸形字符；没有则返回 null。
 *
 * Zod Schema、服务端与界面共用这一份 helper，避免三处规则漂移。孤立代理
 * 依赖 JS 字符串的 UTF-16 码元配对判断：有 `isWellFormed()` 时先用它快速
 * 排除合法字符串，否则（或为 false 时）逐码元检查代理对。
 */
export function findForbiddenSettingDeltaChar(text: string): string | null {
  const loneSurrogate = findLoneSurrogate(text);
  if (loneSurrogate !== null) return loneSurrogate;
  return (
    SETTING_DELTA_FORBIDDEN_CATEGORY.exec(text)?.[0] ??
    SETTING_DELTA_VARIATION_SELECTOR.exec(text)?.[0] ??
    null
  );
}

function findLoneSurrogate(text: string): string | null {
  const wellFormed = (
    text as string & { isWellFormed?: () => boolean }
  ).isWellFormed;
  if (typeof wellFormed === "function" && wellFormed.call(text)) return null;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return text[index]!;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return text[index]!;
  }
  return null;
}

/**
 * 写入前统一 NFC + trim；存储与渲染使用同一份文本。
 *
 * 这里刻意不用 NFKC：读者输入的 ，！？：（）；…① 等字符必须原样保留。
 * NFKC 只用于术语主体匹配（`normalizeTermName`）。
 */
export function normalizeSettingDeltaText(text: string): string {
  return text.normalize("NFC").trim();
}

function settingDeltaTextSchema(maxChars: number, label: string) {
  return z
    .string()
    .superRefine((value, context) => {
      if (findForbiddenSettingDeltaChar(value) !== null) {
        context.addIssue({
          code: "custom",
          message: SETTING_DELTA_FORBIDDEN_CHAR_MESSAGE,
        });
      }
    })
    .transform(normalizeSettingDeltaText)
    .pipe(
      z
        .string()
        .min(1, `${label}不能为空`)
        .max(maxChars, `${label}不能超过 ${maxChars} 个字符`),
    );
}

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
      name: settingDeltaTextSchema(
        SETTING_DELTA_TERM_NAME_MAX_CHARS,
        "设定词条名称",
      ),
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
    statement: settingDeltaTextSchema(
      SETTING_DELTA_STATEMENT_MAX_CHARS,
      "设定说明",
    ),
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
