/**
 * 结构化生成的 provider 重试预算。
 *
 * 两类错误的重试计数器彼此独立：空响应（provider 返回无文本内容）与瞬时
 * 网络错误（连接中断、超时等）。因此一次 `generateStructured` 最坏会发起
 * `1 + 空响应重试 + 瞬时网络重试` 次真实调用，initial 与 repair 各自一套。
 *
 * Ripple Suggestions 的模型调用硬上限从这里派生，避免把 6 之类的数字写死在
 * 两个地方后随重试策略漂移。
 */
export type RetryPolicy = {
  emptyResponseRetries: number;
  transientNetworkRetries: number;
};

/** 首轮空响应沿用原有两次重试；瞬时网络错误只重试一次。 */
export const INITIAL_RETRY_POLICY: RetryPolicy = {
  emptyResponseRetries: 2,
  transientNetworkRetries: 1,
};

/** repair 只对瞬时网络错误重试一次（网络失败时原响应仍可复用）。 */
export const REPAIR_RETRY_POLICY: RetryPolicy = {
  emptyResponseRetries: 0,
  transientNetworkRetries: 1,
};

/** 一个重试策略下，一次逻辑调用最坏会发出的真实 provider 调用数。 */
export function maxProviderCallsForRetryPolicy(policy: RetryPolicy): number {
  return 1 + policy.emptyResponseRetries + policy.transientNetworkRetries;
}
