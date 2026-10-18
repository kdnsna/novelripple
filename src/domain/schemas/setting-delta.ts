import { z } from "zod";

/** 设定词条名与规则说明的输入上限；Schema 与界面共用同一份常量。 */
export const SETTING_DELTA_TERM_NAME_MAX_CHARS = 40;
export const SETTING_DELTA_STATEMENT_MAX_CHARS = 200;

/** 输入里出现不可见或畸形字符时统一使用这条前缀，后接具体码位。 */
export const SETTING_DELTA_FORBIDDEN_CHAR_PREFIX = "包含不允许的字符";

export type SettingDeltaCharLabel = "词条名" | "设定说明";

/**
 * 不可见/畸形字符按 Unicode 大类拒收：
 * - Cc：C0/C1 控制字符（含 \n \r \t、DEL）；
 * - Cf：格式字符（零宽、方向控制符、标签字符等，例外见下方 emoji 扫描器）；
 * - Cs：孤立代理码位；
 * - Co：私用区字符；
 * - Zl/Zp：行/段分隔符。
 *
 * 变体选择符与视觉空白字符另由扫描器判定。
 */
const SETTING_DELTA_FORBIDDEN_CATEGORY =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const SETTING_DELTA_EMOJI_CAPABLE = /\p{Emoji}/u;
const SETTING_DELTA_EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const SETTING_DELTA_EMOJI_MODIFIER_BASE = /\p{Emoji_Modifier_Base}/u;

/** 视觉上为空白、但不是普通空格的码位；普通空格与全角空格仍允许。 */
const SETTING_DELTA_VISUALLY_BLANK = new Set([
  0x034f, // COMBINING GRAPHEME JOINER
  0x115f, // HANGUL CHOSEONG FILLER
  0x1160, // HANGUL JUNGSEONG FILLER
  0x17b4, // KHMER VOWEL INHERENT AQ
  0x17b5, // KHMER VOWEL INHERENT AA
  0x180e, // MONGOLIAN VOWEL SEPARATOR
  0x2800, // BRAILLE PATTERN BLANK
  0x3164, // HANGUL FILLER
  0x1d159, // MUSICAL SYMBOL NULL NOTEHEAD
  0xffa0, // HALFWIDTH HANGUL FILLER
]);

const SETTING_DELTA_SKIN_TONE = { min: 0x1f3fb, max: 0x1f3ff } as const;
const SETTING_DELTA_REGIONAL_INDICATOR = {
  min: 0x1f1e6,
  max: 0x1f1ff,
} as const;
const SETTING_DELTA_TAG = { min: 0xe0020, max: 0xe007e } as const;
const SETTING_DELTA_TAG_TERMINATOR = 0xe007f;
const SETTING_DELTA_ZWJ = 0x200d;
const SETTING_DELTA_KEYCAP = 0x20e3;

/**
 * 返回第一个不允许的字符码位；没有则返回 null。
 *
 * Zod Schema、服务端与界面共用这一份 helper，避免三处规则漂移。扫描器
 * 先放行合法的 emoji 序列（变体选择符、ZWJ 家庭、肤色、键帽、国旗对、
 * 细分旗帜标签），再按 Unicode 大类与视觉空白表拒收其余字符。
 */
export function findForbiddenSettingDeltaChar(text: string): number | null {
  const loneSurrogate = findLoneSurrogate(text);
  if (loneSurrogate !== null) return loneSurrogate;

  const codePoints = Array.from(text, (char) => char.codePointAt(0)!);
  let index = 0;
  while (index < codePoints.length) {
    const consumed = consumeAllowedEmojiSequence(codePoints, index);
    if (consumed > 0) {
      index += consumed;
      continue;
    }
    const codePoint = codePoints[index]!;
    if (isForbiddenSettingDeltaCodePoint(codePoint)) return codePoint;
    index += 1;
  }
  return null;
}

/**
 * 面向读者的具体错误文案，例如
 * 「词条名包含不允许的字符 U+200B（零宽空格）」。
 */
export function settingDeltaForbiddenCharMessage(
  codePoint: number,
  label: SettingDeltaCharLabel,
): string {
  return `${label}${SETTING_DELTA_FORBIDDEN_CHAR_PREFIX} ${formatCodePoint(codePoint)}`;
}

export function isSettingDeltaForbiddenCharMessage(message: string): boolean {
  return message.includes(SETTING_DELTA_FORBIDDEN_CHAR_PREFIX);
}

function formatCodePoint(codePoint: number): string {
  const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
  const name = SETTING_DELTA_CHAR_NAMES[codePoint];
  return name ? `U+${hex}（${name}）` : `U+${hex}`;
}

const SETTING_DELTA_CHAR_NAMES: Readonly<Record<number, string>> = {
  0x00ad: "软连字符",
  0x034f: "组合字形连接符",
  0x115f: "韩文字母填充符",
  0x1160: "韩文中声填充符",
  0x17b4: "高棉文元音分隔符",
  0x17b5: "高棉文元音分隔符",
  0x180e: "蒙古文元音分隔符",
  0x200b: "零宽空格",
  0x200c: "零宽非连接符",
  0x200d: "零宽连接符",
  0x200e: "从左到右标记",
  0x200f: "从右到左标记",
  0x202a: "从左到右嵌入",
  0x202b: "从右到左嵌入",
  0x202c: "方向格式结束",
  0x202d: "从左到右覆盖",
  0x202e: "从右到左覆盖",
  0x2066: "从左到右隔离",
  0x2067: "从右到左隔离",
  0x2068: "首强隔离",
  0x2069: "方向隔离结束",
  0x2800: "盲文空白",
  0x3164: "韩文填充符",
  0xfe0e: "文本样式变体选择符",
  0xfe0f: "emoji 样式变体选择符",
  0xfeff: "零宽不换行空格",
  0xffa0: "韩文半角填充符",
};

function isForbiddenSettingDeltaCodePoint(codePoint: number): boolean {
  if (SETTING_DELTA_VISUALLY_BLANK.has(codePoint)) return true;
  if (
    // 音乐符号中的不可见控制码位。
    (codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
    // 标签字符只允许出现在完整细分旗帜序列中，其余一律拒绝。
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  ) {
    return true;
  }
  // FE0E/FE0F 只有在合法 emoji 单元里才会被消费；孤立出现即拒绝。
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return true;
  }
  // 孤立区域指示符 / 肤色修饰符不构成合法 emoji 序列。
  if (
    isRegionalIndicator(codePoint) ||
    isSkinTone(codePoint) ||
    codePoint === SETTING_DELTA_ZWJ
  ) {
    return true;
  }
  return SETTING_DELTA_FORBIDDEN_CATEGORY.test(
    String.fromCodePoint(codePoint),
  );
}

/**
 * 尝试从 index 开始消费一个合法 emoji 序列；返回消费的码位数量。
 *
 * 允许：细分旗帜标签序列、国旗对、键帽、Extended_Pictographic 之间的
 * ZWJ 连接、emoji 基字后的 FE0E/FE0F 与肤色修饰符。任何不完整或位置
 * 错误的片段都返回 0，交给拒收逻辑报出具体码位。
 */
function consumeAllowedEmojiSequence(
  codePoints: readonly number[],
  index: number,
): number {
  const codePoint = codePoints[index]!;

  // 细分旗帜：U+1F3F4 + 至少一个 tag + U+E007F，必须完整。
  if (codePoint === 0x1f3f4) {
    let cursor = index + 1;
    while (
      cursor < codePoints.length &&
      codePoints[cursor]! >= SETTING_DELTA_TAG.min &&
      codePoints[cursor]! <= SETTING_DELTA_TAG.max
    ) {
      cursor += 1;
    }
    if (
      cursor > index + 1 &&
      codePoints[cursor] === SETTING_DELTA_TAG_TERMINATOR
    ) {
      return cursor + 1 - index;
    }
  }

  // 国旗只接受成对的区域指示符。
  if (isRegionalIndicator(codePoint)) {
    return index + 1 < codePoints.length &&
      isRegionalIndicator(codePoints[index + 1]!)
      ? 2
      : 0;
  }

  // 键帽：[0-9#*] FE0E? U+20E3。
  if (isKeycapBase(codePoint)) {
    let cursor = index + 1;
    if (cursor < codePoints.length && isVariationSelector(codePoints[cursor]!)) {
      cursor += 1;
    }
    if (codePoints[cursor] === SETTING_DELTA_KEYCAP) return cursor + 1 - index;
  }

  if (!isEmojiCapable(codePoint)) return 0;
  let cursor = consumeEmojiUnit(codePoints, index);
  if (cursor <= index) return 0;
  let lastBase = codePoint;
  while (
    cursor < codePoints.length &&
    codePoints[cursor] === SETTING_DELTA_ZWJ
  ) {
    if (!isExtendedPictographic(lastBase)) break;
    const nextBase = codePoints[cursor + 1];
    if (nextBase === undefined || !isExtendedPictographic(nextBase)) break;
    const next = consumeEmojiUnit(codePoints, cursor + 1);
    if (next <= cursor + 1) break;
    cursor = next;
    lastBase = nextBase;
  }
  return cursor - index;
}

/** emoji 基字 + 可选 FE0E/FE0F + 可选肤色修饰符。 */
function consumeEmojiUnit(
  codePoints: readonly number[],
  index: number,
): number {
  const base = codePoints[index]!;
  if (!isEmojiCapable(base)) return index;
  let cursor = index + 1;
  if (
    cursor < codePoints.length &&
    isVariationSelector(codePoints[cursor]!)
  ) {
    cursor += 1;
  }
  // 肤色修饰符只能跟在 Emoji_Modifier_Base 后；❤️🏽 这类序列仍会拒绝 🏽。
  if (
    cursor < codePoints.length &&
    isSkinTone(codePoints[cursor]!) &&
    isEmojiModifierBase(base)
  ) {
    cursor += 1;
  }
  return cursor;
}

function isEmojiCapable(codePoint: number): boolean {
  // 肤色修饰符不是基字；孤立出现（或跟在非基字后）必须交给拒收逻辑。
  if (isSkinTone(codePoint)) return false;
  return SETTING_DELTA_EMOJI_CAPABLE.test(String.fromCodePoint(codePoint));
}

function isEmojiModifierBase(codePoint: number): boolean {
  return SETTING_DELTA_EMOJI_MODIFIER_BASE.test(
    String.fromCodePoint(codePoint),
  );
}

function isExtendedPictographic(codePoint: number): boolean {
  return SETTING_DELTA_EXTENDED_PICTOGRAPHIC.test(
    String.fromCodePoint(codePoint),
  );
}

function isKeycapBase(codePoint: number): boolean {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    codePoint === 0x23 ||
    codePoint === 0x2a
  );
}

function isVariationSelector(codePoint: number): boolean {
  return codePoint === 0xfe0e || codePoint === 0xfe0f;
}

function isSkinTone(codePoint: number): boolean {
  return (
    codePoint >= SETTING_DELTA_SKIN_TONE.min &&
    codePoint <= SETTING_DELTA_SKIN_TONE.max
  );
}

function isRegionalIndicator(codePoint: number): boolean {
  return (
    codePoint >= SETTING_DELTA_REGIONAL_INDICATOR.min &&
    codePoint <= SETTING_DELTA_REGIONAL_INDICATOR.max
  );
}

function findLoneSurrogate(text: string): number | null {
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
      return code;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return code;
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

function settingDeltaTextSchema(
  maxChars: number,
  label: string,
  charLabel: SettingDeltaCharLabel,
) {
  return z
    .string()
    .superRefine((value, context) => {
      addSettingDeltaForbiddenCharIssue(value, context, charLabel);
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
 * 已存储行的宽松文本 Schema：保留 NFC/trim 与长度上限，但不重复检查
 * 不可见/畸形字符。
 *
 * 历史行的文本在写入当时可能合法，之后规则收紧；读取、派生与生命周期
 * 操作必须仍能处理这些行，否则旧规则会变得无法停用或删除。新内容的
 * 创建路径继续使用 `settingDeltaTextSchema`（含 forbidden-char 检查）。
 */
function settingDeltaStoredTextSchema(maxChars: number, label: string) {
  return z
    .string()
    .transform(normalizeSettingDeltaText)
    .pipe(
      z
        .string()
        .min(1, `${label}不能为空`)
        .max(maxChars, `${label}不能超过 ${maxChars} 个字符`),
    );
}

/**
 * 只拒绝不可见/畸形字符、不做 NFC/trim 或长度限制的说明 Schema。
 *
 * Server Action 用它在进入仓储前把具体码位错误回给读者；trim/NFC 与
 * 1–200 字长度仍由仓储层按存储文本统一校验，避免原始长度抢先拒绝本应
 * 被规范化接受的文本。
 */
export const SettingDeltaStatementInputSchema = z
  .string()
  .superRefine((value, context) => {
    addSettingDeltaForbiddenCharIssue(value, context, "设定说明");
  });

function addSettingDeltaForbiddenCharIssue(
  value: string,
  context: z.RefinementCtx,
  charLabel: SettingDeltaCharLabel,
): void {
  const forbidden = findForbiddenSettingDeltaChar(value);
  if (forbidden === null) return;
  context.addIssue({
    code: "custom",
    message: settingDeltaForbiddenCharMessage(forbidden, charLabel),
  });
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
        "词条名",
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
      "设定说明",
    ),
    contentKind: z.literal("user"),
    createdAt: z.iso.datetime(),
  })
  .strict();

/**
 * 读取已存储设定增量时使用的宽松 Schema。
 *
 * 只跳过 forbidden-char refinement：创建/写入仍必须走上面的严格 Schema，
 * 历史行即使包含今天禁止的字符，也必须能读取、派生、停用、删除与重新启用。
 */
export const SettingDeltaSubjectStoredSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("character"),
      characterId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("term"),
      name: settingDeltaStoredTextSchema(
        SETTING_DELTA_TERM_NAME_MAX_CHARS,
        "设定词条名称",
      ),
    })
    .strict(),
]);

export const SettingDeltaV1StoredSchema = z
  .object({
    id: z.string().min(1),
    worldlineId: z.string().min(1),
    anchorSceneId: z.string().min(1).nullable(),
    subject: SettingDeltaSubjectStoredSchema,
    statement: settingDeltaStoredTextSchema(
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
export type SettingDeltaSubjectStored = z.infer<
  typeof SettingDeltaSubjectStoredSchema
>;
export type SettingDeltaV1 = z.infer<typeof SettingDeltaV1Schema>;
export type SettingDeltaV1Stored = z.infer<typeof SettingDeltaV1StoredSchema>;
export type SettingDeltaLifecycleStatus = z.infer<
  typeof SettingDeltaLifecycleStatusSchema
>;
export type SettingDeltaLifecycleV1 = z.infer<
  typeof SettingDeltaLifecycleV1Schema
>;
