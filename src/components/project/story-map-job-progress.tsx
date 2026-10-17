"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import {
  startStoryMapGenerationAction,
  type ProjectActionState,
} from "@/app/projects/actions";
import type {
  JobProgress,
  JobStatus,
  StoryMapJobStage,
} from "@/domain/schemas";
import type { JobView } from "@/server/jobs/job-view";

import { jobPollBackoffMs } from "./job-poll-backoff";

const STAGE_LABELS: Record<StoryMapJobStage, string> = {
  queued: "排队",
  chunking: "分段",
  extract: "分段抽取",
  glean: "补抽",
  names: "人名归并",
  endings: "结局",
  merge: "对账",
  saving: "保存候选",
};

/** 与 progress 的 stage 顺序一致；queued 不是管线阶段，不进入时间线。 */
const STAGE_SEQUENCE: StoryMapJobStage[] = [
  "chunking",
  "extract",
  "glean",
  "names",
  "endings",
  "merge",
  "saving",
];

const initialState: ProjectActionState = { error: null };

export function StoryMapJobProgress({
  initialJob,
  projectId,
  sourceId,
}: {
  initialJob: JobView;
  projectId: string;
  sourceId: string;
}) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [pollError, setPollError] = useState<string | null>(null);
  const [jobMissing, setJobMissing] = useState(false);
  const [retryState, retryAction, retryPending] = useActionState(
    startStoryMapGenerationAction.bind(null, projectId, sourceId),
    initialState,
  );

  const status: JobStatus = job.status;
  const artifactId = job.result?.artifactId ?? null;

  useEffect(() => {
    if (jobMissing || (status !== "queued" && status !== "running")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;

    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void poll();
      }, delayMs);
    };

    const retryLater = (message: string) => {
      consecutiveFailures += 1;
      const delayMs = jobPollBackoffMs(consecutiveFailures);
      if (!cancelled) {
        setPollError(`${message}，${delayMs / 1_000} 秒后重试…`);
      }
      scheduleNext(delayMs);
    };

    const poll = async () => {
      try {
        const query = new URLSearchParams({ projectId });
        const response = await fetch(
          `/api/jobs/${encodeURIComponent(job.id)}?${query}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        // 不存在与不属于本项目使用同一个 404；停止轮询并让用户重新开始。
        if (response.status === 404) {
          setJobMissing(true);
          setPollError(null);
          return;
        }
        if (!response.ok) {
          retryLater("暂时无法获取进度");
          return;
        }
        const next = (await response.json()) as JobView;
        if (cancelled) return;
        consecutiveFailures = 0;
        setPollError(null);
        setJob(next);
        if (next.status === "queued" || next.status === "running") {
          scheduleNext(1_000);
        }
      } catch {
        if (!cancelled) retryLater("网络暂时不可用");
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [job.id, jobMissing, projectId, status]);

  useEffect(() => {
    if (status !== "succeeded" || !artifactId) return;
    // 至少显示一个轮询周期的完成态，随后导航到新 Artifact（与旧流程相同的结果页）。
    const timer = setTimeout(() => {
      const query = new URLSearchParams({
        source: sourceId,
        artifact: artifactId,
        generated: "created",
      });
      router.replace(`/projects/${projectId}?${query}`);
    }, 1_000);
    return () => clearTimeout(timer);
  }, [artifactId, projectId, router, sourceId, status]);

  const stageIndex = STAGE_SEQUENCE.indexOf(job.progress.stage);
  const percent =
    status === "succeeded"
      ? 100
      : stageIndex < 0
        ? 0
        : Math.min(
            99,
            Math.round(
              ((stageIndex +
                (job.progress.total > 0
                  ? job.progress.completed / job.progress.total
                  : 0)) /
                STAGE_SEQUENCE.length) *
                100,
            ),
          );
  const retryable = status === "failed" || status === "interrupted";

  return (
    <section
      aria-label="Story Map 生成任务"
      className="foundation-card story-map-job-card"
      data-job-status={status}
      data-testid="story-map-job-progress"
      role="region"
    >
      <div className="story-map-job-heading">
        <div>
          <span className="eyebrow">后台生成任务</span>
          <h2>{headingFor(status)}</h2>
        </div>
        <span className={`job-status-pill job-status-${status}`}>
          {statusLabel(status)}
        </span>
      </div>

      <p aria-live="polite" className="story-map-job-current">
        {progressText(job.progress)}
      </p>

      <ol aria-label="生成阶段" className="story-map-job-stages">
        {STAGE_SEQUENCE.map((stage, index) => {
          const state =
            status === "succeeded" || (stageIndex >= 0 && index < stageIndex)
              ? "done"
              : index === stageIndex
                ? "active"
                : "pending";
          return (
            <li
              aria-current={state === "active" ? "step" : undefined}
              className={`story-map-job-stage is-${state}`}
              key={stage}
            >
              {STAGE_LABELS[stage]}
            </li>
          );
        })}
      </ol>

      <div
        aria-label="生成进度"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="story-map-job-meter"
        role="progressbar"
      >
        <span style={{ width: `${percent}%` }} />
      </div>

      <p className="form-help">
        {status === "queued" || status === "running"
          ? jobMissing
            ? "轮询已经停止；可以重新开始一个生成任务。"
            : "生成在服务器后台运行；刷新页面不会中断，进度每秒更新。"
          : status === "succeeded"
            ? "正在打开新的候选 Story Map…"
            : "任务历史会保留；重试总是创建一条新任务，不复用失败记录。"}
      </p>

      {pollError && !jobMissing && (status === "queued" || status === "running") ? (
        <p className="form-error" role="alert">
          {pollError}
        </p>
      ) : null}

      {jobMissing ? (
        <div className="story-map-job-retry">
          <p className="form-error" role="alert">
            任务不存在或不属于本项目，已停止轮询。
          </p>
          {retryState.error ? (
            <p className="form-error" role="alert">
              {retryState.error}
            </p>
          ) : null}
          <form action={retryAction}>
            <button
              className="primary-button full-width-button"
              disabled={retryPending}
              type="submit"
            >
              {retryPending ? "正在重新启动…" : "重新开始"}
            </button>
          </form>
        </div>
      ) : null}

      {retryable && !jobMissing ? (
        <form action={retryAction} className="story-map-job-retry">
          {job.error ? (
            <p className="form-error" role="alert">
              {job.error}
            </p>
          ) : null}
          {retryState.error ? (
            <p className="form-error" role="alert">
              {retryState.error}
            </p>
          ) : null}
          <button
            className="primary-button full-width-button"
            disabled={retryPending}
            type="submit"
          >
            {retryPending ? "正在重新启动…" : "重试"}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function headingFor(status: JobStatus): string {
  switch (status) {
    case "queued":
    case "running":
      return "正在生成故事地图";
    case "succeeded":
      return "故事地图生成完成";
    case "failed":
      return "故事地图生成失败";
    case "interrupted":
      return "故事地图生成被中断";
  }
}

function statusLabel(status: JobStatus): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "进行中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "interrupted":
      return "已中断";
  }
}

function progressText(progress: JobProgress): string {
  const label = STAGE_LABELS[progress.stage];
  if (progress.total > 0) {
    return `${label} ${progress.completed}/${progress.total}`;
  }
  if (progress.stage === "queued") return "任务已排队，等待开始…";
  return label;
}
