import type { ContinuationCanonGuardPolicy } from "@/domain/invariants/validate-continuation";
import { StructuredGenerationError } from "@/server/ai/generate-structured";

export const CONTINUATION_CANON_GUARD_ENV = "CONTINUATION_CANON_GUARD";
export const DEFAULT_CONTINUATION_CANON_GUARD_POLICY: ContinuationCanonGuardPolicy =
  "strict";

/** 稳定 code，允许跨打包边界按 code 识别硬拒绝。 */
export const CONTINUATION_CANON_GUARD_REJECTED_CODE =
  "continuation_canon_guard_rejected" as const;

/**
 * 读取 Canon 护栏策略。
 *
 * 缺省与空字符串使用默认 `strict`；`strict` / `warn` / `off` 之外的写法在
 * 任何模型调用前 fail closed，避免拼错变量后悄悄失去护栏。
 */
export function readContinuationCanonGuardPolicy(
  env: Record<string, string | undefined> = process.env,
): ContinuationCanonGuardPolicy {
  const raw = env[CONTINUATION_CANON_GUARD_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_CONTINUATION_CANON_GUARD_POLICY;
  }
  const value = raw.trim();
  if (value === "strict" || value === "warn" || value === "off") {
    return value;
  }
  throw new Error(
    `环境变量 ${CONTINUATION_CANON_GUARD_ENV} 只能是 strict、warn 或 off`,
  );
}

/**
 * 硬拒绝时抛出的人类可读错误。
 *
 * 只带 Story Map 事件标题，不包含模型正文；由服务端边界映射为可展示文案。
 */
export class CanonGuardRejectionError extends Error {
  readonly code = CONTINUATION_CANON_GUARD_REJECTED_CODE;
  readonly eventTitles: string[];

  constructor(eventTitles: readonly string[]) {
    const unique = [...new Set(eventTitles)];
    super(
      `生成内容明确否定了分歧前已确认的原著事件「${unique[0] ?? ""}」，已拒绝且未保存；请重试或换一批。`,
    );
    this.name = "CanonGuardRejectionError";
    this.eventTitles = unique;
  }
}

export function isCanonGuardRejectionError(
  value: unknown,
): value is { code: typeof CONTINUATION_CANON_GUARD_REJECTED_CODE } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code ===
      CONTINUATION_CANON_GUARD_REJECTED_CODE
  );
}

/**
 * 执行结构化生成；若最终失败且本次校验记录了高置信 Canon 否定，则抛出
 * 带事件标题的专用错误（Generation Run 已被既有路径标为 failed）。
 */
export async function runWithCanonGuard<T>(
  run: () => Promise<T>,
  getHardRejectionTitles: () => readonly string[],
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const titles = getHardRejectionTitles();
    if (error instanceof StructuredGenerationError && titles.length > 0) {
      throw new CanonGuardRejectionError(titles);
    }
    throw error;
  }
}
