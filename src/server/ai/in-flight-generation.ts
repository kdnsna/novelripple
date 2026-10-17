/**
 * 同一进程内的生成去重锁。
 *
 * key 必须是确定性身份（例如目标 Artifact id 或 Story Map Artifact id）。
 * 并发同 key 请求只有第一个真正调用模型，其余请求 await 同一个 Promise；
 * 锁释放后再次进入由调用方先查已有 Artifact，因此不会重复生成。
 * 它不是跨进程锁，数据库中的确定性主键或“复用已有候选”仍是最终幂等边界。
 */
const inFlightGenerations = new Map<string, Promise<unknown>>();

export function runWithInFlightLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const existing = inFlightGenerations.get(key);
  if (existing) return existing as Promise<T>;

  const promise = task();
  inFlightGenerations.set(key, promise);
  return promise.finally(() => {
    if (inFlightGenerations.get(key) === promise) {
      inFlightGenerations.delete(key);
    }
  });
}
