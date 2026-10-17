import {
  interruptStaleJobs,
  JOB_HEARTBEAT_STALE_MS,
} from "@/server/repositories/job-repository";

type JobRecoveryState = {
  /** 本进程启动时间；首次恢复时以此收口上个进程遗留的 queued/running 任务。 */
  processStartedAt: string;
  didSweep: boolean;
};

const globalForJobs = globalThis as typeof globalThis & {
  __novelrippleJobRecovery?: JobRecoveryState;
};

/**
 * 第一个请求/任务动作触发一次恢复：
 * - 首次调用把本进程启动前遗留的任务全部标为 interrupted（服务器重启场景）；
 * - 之后的调用只收口心跳超过 2 分钟的任务。
 * 使用 globalThis 保存状态，避免 Next dev 热更新重复执行首次恢复。
 */
export function ensureJobRecovery(now = Date.now()): number {
  const state = getRecoveryState();
  const staleBefore = state.didSweep
    ? new Date(now - JOB_HEARTBEAT_STALE_MS).toISOString()
    : state.processStartedAt;
  state.didSweep = true;

  return interruptStaleJobs({
    staleBefore,
    now: new Date(now).toISOString(),
  }).length;
}

/** 测试隔离：模拟新进程启动。 */
export function resetJobRecoveryForTests(): void {
  delete globalForJobs.__novelrippleJobRecovery;
}

function getRecoveryState(): JobRecoveryState {
  globalForJobs.__novelrippleJobRecovery ??= {
    processStartedAt: new Date().toISOString(),
    didSweep: false,
  };
  return globalForJobs.__novelrippleJobRecovery;
}
