import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import {
  JobSchema,
  JobProgressSchema,
  type Job,
  type JobInput,
  type JobKind,
  type JobProgress,
  type JobResult,
  type JobStatus,
} from "@/domain/schemas";
import { getDatabase } from "@/server/db/client";
import { jobs } from "@/server/db/schema";

/** 任务失去心跳超过该时长即视为中断，必须重试（重试创建新行）。 */
export const JOB_HEARTBEAT_STALE_MS = 2 * 60 * 1000;

export const INTERRUPTED_JOB_ERROR = "故事地图生成被中断，请重试。";

export const QUEUED_JOB_PROGRESS: JobProgress = {
  stage: "queued",
  completed: 0,
  total: 0,
};

type CreateJobInput = {
  projectId: string;
  kind: JobKind;
  input: JobInput;
  progress?: JobProgress;
  now?: string;
};

/** 新建任务行；重试永远创建新行，不复用 failed / interrupted 行。 */
export function createJob(input: CreateJobInput): Job {
  const timestamp = input.now ?? new Date().toISOString();
  const job = JobSchema.parse({
    id: `job_${randomUUID()}`,
    projectId: input.projectId,
    kind: input.kind,
    input: input.input,
    status: "queued",
    progress: input.progress ?? QUEUED_JOB_PROGRESS,
    result: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    heartbeatAt: timestamp,
  });

  getDatabase()
    .insert(jobs)
    .values({
      id: job.id,
      projectId: job.projectId,
      kind: job.kind,
      inputJson: JSON.stringify(job.input),
      status: job.status,
      progressJson: JSON.stringify(job.progress),
      resultJson: null,
      error: null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      heartbeatAt: job.heartbeatAt,
    })
    .run();

  return job;
}

export function getJob(id: string): Job | null {
  const row = getDatabase().select().from(jobs).where(eq(jobs.id, id)).get();
  return row ? parseJobRow(row) : null;
}

export function listProjectJobs(projectId: string, kind?: JobKind): Job[] {
  const rows = kind
    ? getDatabase()
        .select()
        .from(jobs)
        .where(and(eq(jobs.projectId, projectId), eq(jobs.kind, kind)))
        .orderBy(desc(sql`rowid`))
        .all()
    : getDatabase()
        .select()
        .from(jobs)
        .where(eq(jobs.projectId, projectId))
        .orderBy(desc(sql`rowid`))
        .all();
  return rows.map(parseJobRow);
}

/** 同一 project + kind + source 只允许一个 queued/running 任务。 */
export function findActiveJob(input: {
  projectId: string;
  kind: JobKind;
  sourceId: string;
}): Job | null {
  return (
    listProjectJobs(input.projectId, input.kind).find(
      (job) =>
        (job.status === "queued" || job.status === "running") &&
        job.input.sourceId === input.sourceId,
    ) ?? null
  );
}

/** 项目页刷新时恢复最近一次任务；只按 source 过滤，不读取正文。 */
export function getLatestJobForSource(input: {
  projectId: string;
  kind: JobKind;
  sourceId: string;
}): Job | null {
  return (
    listProjectJobs(input.projectId, input.kind).find(
      (job) => job.input.sourceId === input.sourceId,
    ) ?? null
  );
}

export function markJobRunning(input: { id: string; now?: string }): Job | null {
  return updateJob(input.id, "queued", (timestamp) => ({
    status: "running" satisfies JobStatus,
    updatedAt: timestamp,
    heartbeatAt: timestamp,
  }), input.now);
}

export function updateJobProgress(input: {
  id: string;
  progress: JobProgress;
  now?: string;
}): Job | null {
  const progress = JobProgressSchema.parse(input.progress);
  return updateJob(input.id, "running", (timestamp) => ({
    progressJson: JSON.stringify(progress),
    updatedAt: timestamp,
    heartbeatAt: timestamp,
  }), input.now);
}

/** 长阶段只刷新心跳，不伪造进度；运行中的任务不会被同一进程误判为 stale。 */
export function touchJobHeartbeat(input: {
  id: string;
  now?: string;
}): Job | null {
  return updateJob(input.id, "running", (timestamp) => ({
    heartbeatAt: timestamp,
  }), input.now);
}

export function markJobSucceeded(input: {
  id: string;
  result: JobResult;
  now?: string;
}): Job | null {
  return updateJob(input.id, "running", (timestamp) => ({
    status: "succeeded" satisfies JobStatus,
    resultJson: JSON.stringify(input.result),
    error: null,
    updatedAt: timestamp,
    heartbeatAt: timestamp,
  }), input.now);
}

export function markJobFailed(input: {
  id: string;
  error: string;
  now?: string;
}): Job | null {
  return updateJob(input.id, "running", (timestamp) => ({
    status: "failed" satisfies JobStatus,
    resultJson: null,
    error: input.error,
    updatedAt: timestamp,
    heartbeatAt: timestamp,
  }), input.now);
}

/**
 * 把心跳早于 staleBefore 的 queued/running 任务标为 interrupted。
 * 新进程首次使用时传入进程启动时间，从而把上个进程遗留的任务全部收口。
 */
export function interruptStaleJobs(input: {
  staleBefore: string;
  now?: string;
}): Job[] {
  const timestamp = input.now ?? new Date().toISOString();
  const rows = getDatabase()
    .update(jobs)
    .set({
      status: "interrupted",
      resultJson: null,
      error: INTERRUPTED_JOB_ERROR,
      updatedAt: timestamp,
    })
    .where(
      and(
        inArray(jobs.status, ["queued", "running"]),
        lt(jobs.heartbeatAt, input.staleBefore),
      ),
    )
    .returning()
    .all();
  return rows.map(parseJobRow);
}

function updateJob(
  id: string,
  expectedStatus: JobStatus,
  values: (timestamp: string) => Partial<typeof jobs.$inferInsert>,
  now?: string,
): Job | null {
  const timestamp = now ?? new Date().toISOString();
  const row = getDatabase()
    .update(jobs)
    .set(values(timestamp))
    .where(and(eq(jobs.id, id), eq(jobs.status, expectedStatus)))
    .returning()
    .get();
  return row ? parseJobRow(row) : null;
}

function parseJobRow(row: typeof jobs.$inferSelect): Job {
  return JobSchema.parse({
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    input: JSON.parse(row.inputJson),
    status: row.status,
    progress: JSON.parse(row.progressJson),
    result: row.resultJson === null ? null : JSON.parse(row.resultJson),
    error: row.error,
    createdAt: normalizeSqliteDate(row.createdAt),
    updatedAt: normalizeSqliteDate(row.updatedAt),
    heartbeatAt: normalizeSqliteDate(row.heartbeatAt),
  });
}

function normalizeSqliteDate(value: string): string {
  if (value.includes("T")) return value;
  return `${value.replace(" ", "T")}Z`;
}
