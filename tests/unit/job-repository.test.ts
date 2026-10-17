import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/server/db/client";
import { jobs } from "@/server/db/schema";
import {
  ensureJobRecovery,
  resetJobRecoveryForTests,
} from "@/server/jobs/job-recovery";
import { startStoryMapGenerationJob } from "@/server/jobs/story-map-generation-job";
import { createProject } from "@/server/repositories/project-repository";
import {
  createJob,
  findActiveJob,
  getJob,
  getLatestJobForSource,
  interruptStaleJobs,
  JOB_HEARTBEAT_STALE_MS,
  listProjectJobs,
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
  QUEUED_JOB_PROGRESS,
  updateJobProgress,
} from "@/server/repositories/job-repository";
import { storyMapGenerationErrorMessage } from "@/server/story-map/story-map-generation-error";

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "novelripple-jobs-"));
  process.env.DB_FILE_NAME = path.join(temporaryDirectory, "test.db");
  closeDatabase();
  migrate(getDatabase(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
});

afterAll(async () => {
  closeDatabase();
  delete process.env.DB_FILE_NAME;
  await rm(temporaryDirectory, { recursive: true });
});

function createTestProject() {
  return createProject({ title: "Job repository" });
}

function setHeartbeat(jobId: string, heartbeatAt: string) {
  getDatabase()
    .update(jobs)
    .set({ heartbeatAt, updatedAt: heartbeatAt })
    .where(eq(jobs.id, jobId))
    .run();
}

describe("job repository", () => {
  it("creates a queued job with ids-only input and no source text", () => {
    const project = createTestProject();
    const job = createJob({
      projectId: project.id,
      kind: "story_map_generation",
      input: { sourceId: "source_test_1" },
    });

    expect(job).toMatchObject({
      projectId: project.id,
      kind: "story_map_generation",
      input: { sourceId: "source_test_1" },
      status: "queued",
      progress: QUEUED_JOB_PROGRESS,
      result: null,
      error: null,
    });
    expect(getJob(job.id)).toEqual(job);
    expect(JSON.stringify(job)).not.toContain("source text");
  });

  it("returns the existing queued/running job for the same project and source", () => {
    resetJobRecoveryForTests();
    const project = createTestProject();
    const first = startStoryMapGenerationJob({
      projectId: project.id,
      sourceId: "source_single_flight",
    });
    const second = startStoryMapGenerationJob({
      projectId: project.id,
      sourceId: "source_single_flight",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(
      findActiveJob({
        projectId: project.id,
        kind: "story_map_generation",
        sourceId: "source_single_flight",
      })?.id,
    ).toBe(first.job.id);
    expect(
      findActiveJob({
        projectId: project.id,
        kind: "story_map_generation",
        sourceId: "source_other",
      }),
    ).toBeNull();
  });

  it("retries by appending a new job and leaves the failed row untouched", () => {
    resetJobRecoveryForTests();
    const project = createTestProject();
    const first = createJob({
      projectId: project.id,
      kind: "story_map_generation",
      input: { sourceId: "source_retry" },
    });
    markJobRunning({ id: first.id });
    const failed = markJobFailed({
      id: first.id,
      error: "Story Map 生成失败，未保存 Artifact。",
    });
    expect(failed?.status).toBe("failed");

    const retried = startStoryMapGenerationJob({
      projectId: project.id,
      sourceId: "source_retry",
    });

    expect(retried.created).toBe(true);
    expect(retried.job.id).not.toBe(first.id);
    expect(getJob(first.id)).toMatchObject({
      status: "failed",
      error: "Story Map 生成失败，未保存 Artifact。",
      result: null,
    });
    expect(listProjectJobs(project.id, "story_map_generation")).toHaveLength(2);
    expect(
      getLatestJobForSource({
        projectId: project.id,
        kind: "story_map_generation",
        sourceId: "source_retry",
      })?.id,
    ).toBe(retried.job.id);
  });

  it("records progress and stores the artifact id only on success", () => {
    const project = createTestProject();
    const job = createJob({
      projectId: project.id,
      kind: "story_map_generation",
      input: { sourceId: "source_progress" },
    });
    markJobRunning({ id: job.id });
    const progressed = updateJobProgress({
      id: job.id,
      progress: { stage: "extract", completed: 3, total: 6 },
    });
    expect(progressed?.progress).toEqual({
      stage: "extract",
      completed: 3,
      total: 6,
    });

    const succeeded = markJobSucceeded({
      id: job.id,
      result: { artifactId: "artifact_story_map_1" },
    });
    expect(succeeded).toMatchObject({
      status: "succeeded",
      result: { artifactId: "artifact_story_map_1" },
      error: null,
    });
  });

  it("interrupts queued/running jobs whose heartbeat is stale", () => {
    const project = createTestProject();
    const job = createJob({
      projectId: project.id,
      kind: "story_map_generation",
      input: { sourceId: "source_stale" },
    });
    markJobRunning({ id: job.id });
    setHeartbeat(job.id, "2000-01-01T00:00:00.000Z");

    const interrupted = interruptStaleJobs({
      staleBefore: new Date(Date.now() - JOB_HEARTBEAT_STALE_MS).toISOString(),
    });

    expect(interrupted.map((row) => row.id)).toContain(job.id);
    expect(getJob(job.id)).toMatchObject({
      status: "interrupted",
      result: null,
    });
    expect(getJob(job.id)?.error).toContain("中断");
  });

  it("marks all queued/running jobs from a previous process on first use", () => {
    const project = createTestProject();
    const job = createJob({
      projectId: project.id,
      kind: "story_map_generation",
      input: { sourceId: "source_previous_process" },
    });
    markJobRunning({ id: job.id });
    setHeartbeat(job.id, "2000-01-01T00:00:00.000Z");

    resetJobRecoveryForTests();
    ensureJobRecovery();

    expect(getJob(job.id)?.status).toBe("interrupted");
  });

  it("persists only the sanitized failure message", () => {
    const rawError = new Error("真实小说原文：潮汐钟停在凌晨四点十二分");
    const sanitized = storyMapGenerationErrorMessage(rawError);
    expect(sanitized).toBe("Story Map 生成失败，未保存 Artifact。");

    const project = createTestProject();
    const job = createJob({
      projectId: project.id,
      kind: "story_map_generation",
      input: { sourceId: "source_sanitized" },
    });
    markJobRunning({ id: job.id });
    const failed = markJobFailed({ id: job.id, error: sanitized });

    expect(failed?.error).toBe(sanitized);
    expect(failed?.error).not.toContain("潮汐钟");
    expect(failed?.error).not.toContain("原文");
  });
});
