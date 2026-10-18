/**
 * Ripple Suggestions 每个 confirmed Story Map revision 的批次数与尝试次数上限。
 *
 * 批次从 0 开始（最初自动生成的一组）；每次显式「换一批」增加一个批次。
 * 批次数上限在任何 Prompt 读取与模型调用前按已持久化批次检查，达到后
 * fail closed；不可变批次的数量与“最多尝试几次模型”是两条独立上限。
 */
export const DEFAULT_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION = 5;

/** 环境变量允许的最大批次数；超过它不是“更大预算”，而是配置错误。 */
export const MAX_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION = 20;

/**
 * 每个 revision 允许的 Ripple Suggestions Generation Run 次数相对批次上限的倍数。
 *
 * 失败的调用不会留下批次 Artifact，只数批次会让失败重试无限消耗模型调用；
 * 因此按 Generation Run（pending / succeeded / failed 都算）计数，允许
 * `批次数上限 × 2` 次尝试。成功批次仍受批次数上限约束，失败与成功共享
 * 这 2 倍预算。
 */
export const RIPPLE_SUGGESTION_MAX_ATTEMPTS_PER_BATCH = 2;

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

/** 每个 revision 的最大生成尝试数（含失败重试）。 */
export function rippleSuggestionAttemptLimit(maxBatches: number): number {
  return maxBatches * RIPPLE_SUGGESTION_MAX_ATTEMPTS_PER_BATCH;
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
