import { z } from "zod";

import { AnchorSchema } from "./impact-plan";
import { DivergenceSchema } from "./divergence";

/**
 * 世界线阅读游标：最近一次阅读到的场景节点。
 *
 * 这是可更新的“阅读位置”，不是叙事 Artifact；`null` 表示默认路径/分歧点。
 * 仓储层仍会校验非空 id 必须是本世界线上真实存在的场景。
 */
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
    headNodeId: z.string().min(1).nullable().default(null),
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
        worldline.headNodeId !== null
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

/** 书签名称统一做 NFC + trim；测量与存储使用同一份文本。 */
export function normalizeWorldlineBookmarkName(value: string): string {
  return value.normalize("NFC").trim();
}

export const WorldlineBookmarkNameSchema = z
  .string()
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
