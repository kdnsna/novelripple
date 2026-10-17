/**
 * Ripple Suggestions 每个 confirmed Story Map revision 的批次数上限。
 *
 * 批次从 0 开始（最初自动生成的一组）；每次显式「换一批」增加一个批次。
 * 上限在任何模型调用前按已持久化批次检查，达到后 fail closed；
 * 不是“最多调用几次模型”的运行中预算，而是不可变批次的数量上限。
 */
export const DEFAULT_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION = 5;

export const RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV =
  "RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION";

export function resolveRippleSuggestionMaxBatches(
  override?: number,
): number {
  if (override !== undefined) {
    return assertPositiveInteger("maxBatches", override);
  }
  const raw = process.env[RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION;
  }
  return assertPositiveInteger(
    RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV,
    Number(raw),
  );
}

/** 环境变量与显式 override 共用同一校验：NaN/0/负数/小数/Infinity 都失败。 */
function assertPositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}
