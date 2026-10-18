export const JOB_POLL_BASE_DELAY_MS = 1_000;
export const JOB_POLL_MAX_DELAY_MS = 30_000;

/**
 * 任务轮询退避：连续失败 1、2、3… 次后分别等待 1、2、4… 秒，
 * 上限 30 秒；成功后调用方把失败次数重置为 0。
 */
export function jobPollBackoffMs(consecutiveFailures: number): number {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) {
    throw new Error(`轮询失败次数必须是非负整数：${consecutiveFailures}`);
  }
  if (consecutiveFailures === 0) return JOB_POLL_BASE_DELAY_MS;
  return Math.min(
    JOB_POLL_BASE_DELAY_MS * 2 ** (consecutiveFailures - 1),
    JOB_POLL_MAX_DELAY_MS,
  );
}
