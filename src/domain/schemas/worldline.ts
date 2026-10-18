import { z } from "zod";

import { AnchorSchema, CharacterStatusSchema } from "./impact-plan";
import { DivergenceSchema } from "./divergence";
import { findForbiddenSettingDeltaChar } from "./setting-delta";

/**
 * 场景 id 是否“只有空白”。除了 JS 空白，还剥掉 SQLite trim 覆盖不到的
 * 零宽字符 U+200B/U+200C/U+200D/U+2060/U+FEFF；Schema、仓储与迁移 0012
 * 的 CHECK 使用同一套字符集合。
 */
const BLANK_SCENE_ID_CHARS = /[\s\u200B-\u200D\u2060\uFEFF]/gu;

export function isBlankSceneId(value: string): boolean {
  return value.replace(BLANK_SCENE_ID_CHARS, "").length === 0;
}

/**
 * 世界线阅读游标：最近一次阅读到分歧点或某个场景。
 *
 * 这是可更新的“阅读位置”，不是叙事 Artifact。`null` 表示从未设置
 * （首次进入走默认路径）；`root` 明确停在分歧点；`scene` 指向本世界线
 * 上真实存在的场景。仓储层对非空场景 id 做领域校验。
 */
export const WorldlineHeadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z
    .object({
      kind: z.literal("scene"),
      sceneId: z
        .string()
        .min(1)
        .refine((value) => !isBlankSceneId(value), {
          message: "场景 id 不能只包含空白字符",
        }),
    })
    .strict(),
]);

export type WorldlineHead = z.infer<typeof WorldlineHeadSchema>;


export const WorldlineSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    parentWorldlineId: z.string().min(1).nullable(),
    baseStoryMapArtifactId: z.string().min(1),
    divergence: DivergenceSchema.nullable(),
    mode: z.enum(["strict", "open"]),
    anchors: z.array(AnchorSchema),
    acceptedImpactPlanId: z.string().min(1).nullable(),
    idempotencyKey: z.string().min(1),
    status: z.enum(["canonical", "active", "archived"]),
    /** 旧行迁移后为 null；canonical 世界线没有场景，因此只能为 null。 */
    head: WorldlineHeadSchema.nullable().default(null),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((worldline, context) => {
    if (worldline.status === "canonical") {
      if (
        worldline.parentWorldlineId !== null ||
        worldline.divergence !== null ||
        worldline.mode !== "open" ||
        worldline.anchors.length > 0 ||
        worldline.acceptedImpactPlanId !== null ||
        worldline.head !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "原著世界线不能包含父世界线、分歧、Anchor、已接受影响计划或阅读位置",
        });
      }
      return;
    }

    if (
      worldline.parentWorldlineId === null ||
      worldline.divergence === null ||
      worldline.acceptedImpactPlanId === null
    ) {
      context.addIssue({
        code: "custom",
        message: "子世界线必须引用父世界线、分歧点和已接受影响计划",
      });
    }

    if (worldline.mode === "open" && worldline.anchors.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["anchors"],
        message: "开放模式不能包含结局锚点",
      });
    }
  });

export type Worldline = z.infer<typeof WorldlineSchema>;

export const WORLDLINE_BOOKMARK_NAME_MAX_CHARS = 40;
export const WORLDLINE_BOOKMARK_MAX_PER_WORLDLINE = 50;
export const WORLDLINE_BOOKMARK_FORBIDDEN_CHAR_MESSAGE =
  "书签名称包含不允许的字符";

/** 书签名称统一做 NFC + trim；测量与存储使用同一份文本。 */
export function normalizeWorldlineBookmarkName(value: string): string {
  return value.normalize("NFC").trim();
}

function formatCodePoint(value: string): string {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return "";
  return `（U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}）`;
}

export const WorldlineBookmarkNameSchema = z
  .string()
  .superRefine((value, context) => {
    const forbidden = findForbiddenSettingDeltaChar(value);
    if (forbidden !== null) {
      context.addIssue({
        code: "custom",
        message: `${WORLDLINE_BOOKMARK_FORBIDDEN_CHAR_MESSAGE}${formatCodePoint(forbidden)}`,
      });
    }
  })
  .transform(normalizeWorldlineBookmarkName)
  .pipe(z.string().min(1).max(WORLDLINE_BOOKMARK_NAME_MAX_CHARS));

/**
 * 命名书签也是阅读游标：`sceneNodeId = null` 表示分歧点/根路径，
 * 非空时必须指向本世界线的场景。它不进入 Continuation Artifact。
 */
export const WorldlineBookmarkSchema = z
  .object({
    id: z.string().min(1),
    worldlineId: z.string().min(1),
    sceneNodeId: z.string().min(1).nullable(),
    name: WorldlineBookmarkNameSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export type WorldlineBookmark = z.infer<typeof WorldlineBookmarkSchema>;


/**
 * 读者对某条路径上人物状态的显式覆盖。只追加，不 UPDATE/DELETE。
 * `anchorSceneId = null` 表示从分歧点起生效；否则只在该场景及其后代生效。
 */
export const WorldlineCharacterStatusOverrideSchema = z
  .object({
    id: z.string().min(1),
    worldlineId: z.string().min(1),
    anchorSceneId: z.string().min(1).nullable(),
    characterId: z.string().min(1),
    status: CharacterStatusSchema,
    idempotencyKey: z.string().trim().min(1).max(200),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type WorldlineCharacterStatusOverride = z.infer<
  typeof WorldlineCharacterStatusOverrideSchema
>;
