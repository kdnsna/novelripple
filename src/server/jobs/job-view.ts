import type { Job } from "@/domain/schemas";

/**
 * 对外暴露的任务视图：只含状态、进度、结果和已脱敏错误。
 * 不返回 input（即使它只含 ID）、heartbeat 或任何模型输出。
 */
export function toJobView(job: Job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
  };
}

export type JobView = ReturnType<typeof toJobView>;
