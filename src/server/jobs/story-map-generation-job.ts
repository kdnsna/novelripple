import { randomUUID } from "node:crypto";

import {
  StoryMapGenerationStartModeSchema,
  type Job,
  type StoryMapGenerationStartMode,
} from "@/domain/schemas";
import { ensureJobRecovery } from "@/server/jobs/job-recovery";
import {
  createJob,
  findActiveJob,
  getJob,
  getLatestJobForSource,
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
  sumRunGroupModelCalls,
  touchJobHeartbeat,
  updateJobModelCalls,
  updateJobProgress,
} from "@/server/repositories/job-repository";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";
import { storyMapGenerationErrorMessage } from "@/server/story-map/story-map-generation-error";

const STORY_MAP_JOB_KIND = "story_map_generation" as const;
const HEARTBEAT_INTERVAL_MS = 15_000;

export type StartStoryMapGenerationJobResult = {
  job: Job;
  created: boolean;
};

/**
 * 单飞启动：同一 project + source 已有 queued/running 任务时直接返回它。
 * 返回值只负责建行；真正的后台执行由 server action 用 after() 调度，
 * 这样同步调用路径（包括仓库测试）不会意外启动模型。
 */
export function startStoryMapGenerationJob(input: {
  projectId: string;
  sourceId: string;
  /** 缺省 resume：失败/中断后沿用旧 run group；fresh 总是开启新 group。 */
  mode?: StoryMapGenerationStartMode;
}): StartStoryMapGenerationJobResult {
  const mode = StoryMapGenerationStartModeSchema.parse(input.mode ?? "resume");
  ensureJobRecovery();
  const existing = findActiveJob({
    projectId: input.projectId,
    kind: STORY_MAP_JOB_KIND,
    sourceId: input.sourceId,
  });
  if (existing) return { job: existing, created: false };

  // resume 只在最新任务 failed / interrupted 时沿用其 run group 并显式链接；
  // fresh 永远跳过旧任务，因此不读旧检查点、预算从 0 开始。首次生成没有
  // 可重试任务，resume 也自然得到新 group。
  const previous =
    mode === "resume"
      ? getLatestJobForSource({
          projectId: input.projectId,
          kind: STORY_MAP_JOB_KIND,
          sourceId: input.sourceId,
        })
      : null;
  const retryable =
    previous !== null &&
    (previous.status === "failed" || previous.status === "interrupted");
  const runGroupId = retryable
    ? (previous.input.runGroupId ?? previous.id)
    : `run_${randomUUID()}`;

  return {
    job: createJob({
      projectId: input.projectId,
      kind: STORY_MAP_JOB_KIND,
      input: {
        sourceId: input.sourceId,
        runGroupId,
        ...(retryable ? { retryOfJobId: previous.id } : {}),
      },
    }),
    created: true,
  };
}

/**
 * 进程内 Runner：认领任务、持续刷新心跳、把管线进度写入 job 行。
 * 任何失败都经过 storyMapGenerationErrorMessage 脱敏后写入 error；
 * 任务行本身只前进一次状态，重试必须创建新行。
 */
export async function runStoryMapGenerationJob(jobId: string): Promise<void> {
  const queued = getJob(jobId);
  if (!queued || queued.status !== "queued") return;

  const running = markJobRunning({ id: jobId });
  if (!running) return;

  const heartbeat = setInterval(() => {
    try {
      touchJobHeartbeat({ id: jobId });
    } catch {
      console.warn("[story-map-job] 心跳写入失败");
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    updateJobProgress({
      id: jobId,
      progress: { stage: "chunking", completed: 0, total: 0 },
    });

    const runGroupId = running.input.runGroupId ?? running.id;
    const previousModelCalls = sumRunGroupModelCalls({
      projectId: running.projectId,
      runGroupId,
      excludeJobId: jobId,
    });

    const result = await generateConfiguredStoryMap({
      projectId: running.projectId,
      sourceId: running.input.sourceId,
      runGroupId,
      previousModelCalls,
      onModelCall: (modelCallsThisAttempt) => {
        // 预算必须在 provider 调用前持久化。任务已不是 running（例如被 stale
        // recovery 标为 interrupted）或写入抛错时，不能继续发出未计费的调用：
        // 直接抛出，让管线在真正调用 provider 之前中止。
        const billed = updateJobModelCalls({
          id: jobId,
          modelCalls: modelCallsThisAttempt,
        });
        if (!billed) {
          throw new Error("任务已不再运行，模型调用预算无法写入");
        }
      },
      onProgress: (progress) => {
        try {
          updateJobProgress({ id: jobId, progress });
        } catch {
          // 进度是辅助信息；写入失败不能让已经开始的生成半途失败。
          console.warn("[story-map-job] 进度写入失败");
        }
      },
    });

    markJobSucceeded({
      id: jobId,
      result: { artifactId: result.artifact.id },
    });
  } catch (error) {
    markJobFailed({
      id: jobId,
      error: storyMapGenerationErrorMessage(error),
    });
  } finally {
    clearInterval(heartbeat);
  }
}
