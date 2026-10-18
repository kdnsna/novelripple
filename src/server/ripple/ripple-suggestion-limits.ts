import {
  INITIAL_RETRY_POLICY,
  REPAIR_RETRY_POLICY,
  maxProviderCallsForRetryPolicy,
} from "@/server/ai/structured-retry-policy";

/**
 * Ripple Suggestions 每个 confirmed Story Map revision 的批次数与模型调用上限。
 *
 * 批次从 0 开始（最初自动生成的一组）；每次显式「换一批」增加一个批次。
 * 两条上限都在任何 Prompt 读取与模型调用前检查，达到后 fail closed：
 * 1. 成功保存的批次数 ≤ `RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION`；
 * 2. 真实 provider 调用数 ≤ 批次数上限 × `RIPPLE_SUGGESTION_MAX_MODEL_CALLS_PER_BATCH`。
 *
 * 失败调用不会留下批次 Artifact。只数批次会让失败重试无限消耗模型调用；
 * 数 Generation Run 行又会把“一次 run 内的 repair / 网络重试”漏掉。因此
 * 直接按每次真实 provider 调用计数，失败与成功同等计入，不再有独立的
 * “尝试次数”上限。
 */
export const DEFAULT_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION = 5;

/** 环境变量允许的最大批次数；超过它不是“更大预算”，而是配置错误。 */
export const MAX_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION = 20;

/**
 * 一个批次最坏情况下会消耗的真实 provider 调用数。
 *
 * 由 `generate-structured.ts` 实际使用的重试策略直接派生：
 * - initial：1 次首调 + 2 次空响应重试 + 1 次瞬时网络重试 = 4 次；
 * - repair：1 次修复调用 + 0 次空响应重试 + 1 次瞬时网络重试 = 2 次。
 * 两类重试计数器独立，所以单次结构化生成最坏为 4 + 2 = 6 次真实调用。
 *
 * 上限按最坏情况预留，避免一个合法的“首轮 + 修复 + 重试”批次被提前拒绝。
 * 默认批次数上限 5 → 每个 revision 最多 5 × 6 = 30 次真实 provider 调用，
 * 也是该 revision 的最坏情况调用总数（硬上限，失败调用同样占额度）。
 */
export const RIPPLE_SUGGESTION_MAX_MODEL_CALLS_PER_BATCH =
  maxProviderCallsForRetryPolicy(INITIAL_RETRY_POLICY) +
  maxProviderCallsForRetryPolicy(REPAIR_RETRY_POLICY);

export const RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV =
  "RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION";

const PLAIN_POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

export function resolveRippleSuggestionMaxBatches(
  override?: number,
): number {
  if (override !== undefined) {
    return assertBatchCount("maxBatches", override);
  }
  const raw = process.env[RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION;
  }
  const trimmed = raw.trim();
  // 只接受 trim 后的纯十进制正整数：拒绝 "0x2" / "1e0" / "+3" / "2.0" 等
  // Number() 会接受、但语义不明确的写法，避免配置歧义。
  if (!PLAIN_POSITIVE_DECIMAL.test(trimmed)) {
    throw new Error(
      `${RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV} 必须是正整数（只接受纯十进制数字，例如 5）`,
    );
  }
  return assertBatchCount(
    RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV,
    Number(trimmed),
  );
}

/**
 * 每个 revision 允许的真实 provider 调用上限，含失败、repair 与瞬时网络重试。
 * 默认 5 批 → 30 次；显式传入批次数时使用同一推导。
 */
export function rippleSuggestionModelCallLimit(maxBatches: number): number {
  return maxBatches * RIPPLE_SUGGESTION_MAX_MODEL_CALLS_PER_BATCH;
}

/**
 * 环境变量与显式 override 共用同一校验：NaN / 0 / 负数 / 小数 / Infinity /
 * 超过最大值都失败；非法值必须在任何 Prompt 读取与模型调用前抛出。
 */
function assertBatchCount(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  if (value > MAX_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION) {
    throw new Error(
      `${name} 不能超过 ${MAX_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION}`,
    );
  }
  return value;
}
