import {
  CONTINUATION_CANON_HARD_REJECT_ISSUE_CODE,
  type ContinuationCanonGuardPolicy,
} from "@/domain/invariants/validate-continuation";
import { StructuredGenerationError } from "@/server/ai/generate-structured";

export const CONTINUATION_CANON_GUARD_ENV = "CONTINUATION_CANON_GUARD";
export const DEFAULT_CONTINUATION_CANON_GUARD_POLICY: ContinuationCanonGuardPolicy =
  "strict";

/** 稳定 code，允许跨打包边界按 code 识别硬拒绝。 */
export const CONTINUATION_CANON_GUARD_REJECTED_CODE =
  "continuation_canon_guard_rejected" as const;

/** 硬拒绝记录中服务端文案实际需要的字段。 */
export type CanonGuardRejectionInfo = {
  title: string;
  /** 模型输出中命中的那一句短样本；缺失时退回只有标题的旧文案。 */
  sentence?: string | null;
  /** 该句所在段落是否存在未闭合/孤立/风格错配的引号。 */
  unpairedQuote?: boolean;
};

/** 引号未闭合时的追加提示；只在硬拒绝记录带 `unpairedQuote` 时出现。 */
export const UNPAIRED_QUOTE_RETRY_HINT =
  "这句所在段落的引号没有闭合，系统按旁白处理；补全引号后重试即可。";

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
 * 只带 Story Map 事件标题与模型输出中命中的那一句短样本（最多约 60 字），
 * 不回显整段正文；由服务端边界映射为可展示文案。若该句所在段落存在未闭合
 * 引号，再追加一句可执行的修复提示。
 */
export class CanonGuardRejectionError extends Error {
  readonly code = CONTINUATION_CANON_GUARD_REJECTED_CODE;
  readonly eventTitles: string[];
  readonly sentence: string | null;
  readonly unpairedQuote: boolean;

  constructor(rejections: readonly CanonGuardRejectionInfo[]) {
    const uniqueTitles = [...new Set(rejections.map((item) => item.title))];
    const first = rejections[0];
    const sentence = safeRejectionSentence(first?.sentence);
    const unpairedQuote = rejections.some((item) => item.unpairedQuote);
    const base =
      first && sentence
        ? `生成内容明确否定了分歧前已确认的原著事件「${first.title}」：「${sentence}」。已拒绝且未保存；请重试或换一批。`
        : `生成内容明确否定了分歧前已确认的原著事件「${first?.title ?? ""}」，已拒绝且未保存；请重试或换一批。`;
    super(base + (unpairedQuote ? UNPAIRED_QUOTE_RETRY_HINT : ""));
    this.name = "CanonGuardRejectionError";
    this.eventTitles = uniqueTitles;
    this.sentence = sentence;
    this.unpairedQuote = unpairedQuote;
  }
}

/** 只允许一句短样本进入读者文案：trim 后超过 60 字时截断并加省略号。 */
function safeRejectionSentence(
  sentence: string | null | undefined,
): string | null {
  const trimmed = sentence?.trim() ?? "";
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 59)}…`;
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
 * 执行结构化生成；只有最终（repair 后）失败的问题仍包含 Canon 硬拒绝时，
 * 才抛出带事件标题与命中句的专用错误（Generation Run 已被既有路径标为 failed）。
 *
 * 首轮因 Canon 被拒、但 repair 因 JSON 等其它原因失败时，不能把读者文案
 * 说成 Canon 拒绝。
 */
export async function runWithCanonGuard<T>(
  run: () => Promise<T>,
  getHardRejections: () => readonly CanonGuardRejectionInfo[],
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const rejections = getHardRejections();
    const finalCanonReject =
      error instanceof StructuredGenerationError &&
      error.finalIssues.some(
        (issue) => issue.code === CONTINUATION_CANON_HARD_REJECT_ISSUE_CODE,
      );
    if (error instanceof StructuredGenerationError && finalCanonReject && rejections.length > 0) {
      throw new CanonGuardRejectionError(rejections);
    }
    throw error;
  }
}
