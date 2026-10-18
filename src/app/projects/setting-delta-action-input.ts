import { z } from "zod";

import {
  ProjectIdSchema,
  SettingDeltaStatementInputSchema,
  SettingDeltaSubjectSchema,
  isSettingDeltaForbiddenCharMessage,
} from "@/domain/schemas";

export const SETTING_DELTA_INPUT_GENERIC_ERROR =
  "设定增量参数无效：请检查主体、说明与锚点。";
export const SETTING_DELTA_LIFECYCLE_INPUT_GENERIC_ERROR =
  "设定增量操作参数无效：请刷新后重试。";

/**
 * Server Action 的纯输入 Schema。
 *
 * 单独放在非 `"use server"` 模块里，便于直接测试“不可见字符 → 具体码位文案”
 * 的映射；Action 只负责解析、调用仓储和失败映射。
 */
export const AddSettingDeltaInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    worldlineId: z.string().min(1),
    anchorSceneId: z.string().min(1).nullable(),
    subject: SettingDeltaSubjectSchema,
    // 只提前拒绝不可见/畸形字符；长度与 NFC 仍由仓储层按规范化后的文本校验。
    statement: SettingDeltaStatementInputSchema,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const SettingDeltaLifecycleInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    worldlineId: z.string().min(1),
    targetDeltaId: z.string().min(1),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * 输入解析失败时优先返回共享 helper 产出的具体码位文案，其余字段仍用
 * 各 Action 的通用提示，避免把 Zod 内部结构或原始输入回显给读者。
 */
export function settingDeltaInputErrorMessage(
  error: z.ZodError,
  fallback: string = SETTING_DELTA_INPUT_GENERIC_ERROR,
): string {
  const forbidden = error.issues.find((issue) =>
    isSettingDeltaForbiddenCharMessage(issue.message),
  );
  return forbidden?.message ?? fallback;
}
