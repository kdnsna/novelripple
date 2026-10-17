import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deriveEvidenceUnitChunks } from "@/domain/source/evidence-unit-chunks";
import { deriveEvidenceUnits } from "@/domain/source/evidence-units";
import { STORY_MAP_BUDGET_EXHAUSTED_ERROR } from "@/domain/schemas";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { resetJobRecoveryForTests } from "@/server/jobs/job-recovery";
import {
  runStoryMapGenerationJob,
  startStoryMapGenerationJob,
} from "@/server/jobs/story-map-generation-job";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import {
  createJob,
  getJob,
  listProjectJobs,
  markJobFailed,
  markJobRunning,
  updateJobModelCalls,
} from "@/server/repositories/job-repository";
import { listStoryMapChunkCheckpoints } from "@/server/repositories/story-map-checkpoint-repository";
import {
  getStoryMapArtifact,
  listStoryMapArtifactsForSource,
} from "@/server/repositories/story-map-artifact-repository";

let temporaryDirectory: string;
const previousEnvironment = {
  provider: process.env.AI_PROVIDER_NAME,
  model: process.env.OPENAI_MODEL,
  mode: process.env.OPENAI_STRUCTURED_OUTPUT_MODE,
};

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-job-runner-"),
  );
  process.env.DB_FILE_NAME = path.join(temporaryDirectory, "test.db");
  closeDatabase();
  migrate(getDatabase(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
  process.env.AI_PROVIDER_NAME = "mock";
  process.env.OPENAI_MODEL = "mock-story-model";
  process.env.OPENAI_STRUCTURED_OUTPUT_MODE = "json_schema";
});

afterAll(async () => {
  closeDatabase();
  delete process.env.DB_FILE_NAME;
  restoreEnvironment("AI_PROVIDER_NAME", previousEnvironment.provider);
  restoreEnvironment("OPENAI_MODEL", previousEnvironment.model);
  restoreEnvironment(
    "OPENAI_STRUCTURED_OUTPUT_MODE",
    previousEnvironment.mode,
  );
  await rm(temporaryDirectory, { recursive: true });
});

describe("in-process Story Map job runner", () => {
  it("runs the existing pipeline and stores only the artifact id on success", async () => {
    const fixture = await loadRippleFixture();
    const project = createProject({ title: "Job runner success" });
    const source = importProjectSource({
      projectId: project.id,
      fileName: "ripple-001.md",
      bytes: new TextEncoder().encode(fixture.source.originalText),
    }).source;
    resetJobRecoveryForTests();
    const started = startStoryMapGenerationJob({
      projectId: project.id,
      sourceId: source.id,
    });

    await runStoryMapGenerationJob(started.job.id);

    const job = getJob(started.job.id);
    expect(job).toMatchObject({
      status: "succeeded",
      error: null,
      result: { artifactId: expect.any(String) },
    });
    expect(job?.progress).toEqual({
      stage: "saving",
      completed: 1,
      total: 1,
    });
    expect(
      getStoryMapArtifact(job!.result!.artifactId),
    ).toMatchObject({
      projectId: project.id,
      sourceId: source.id,
      version: 1,
    });
    expect(listProjectJobs(project.id, "story_map_generation")).toHaveLength(1);
    // Runner 把每次调用写入任务行，并把每个完成的 分块阶段 追加为检查点。
    expect(job?.modelCalls).toBeGreaterThan(0);
    expect(job?.input.runGroupId).toBeDefined();
    expect(
      listStoryMapChunkCheckpoints({
        projectId: project.id,
        runGroupId: job!.input.runGroupId!,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("fails a resume at the exhausted budget before any provider call while fresh succeeds", async () => {
    const fixture = await loadRippleFixture();
    const project = createProject({ title: "Job runner fresh budget" });
    const source = importProjectSource({
      projectId: project.id,
      fileName: "ripple-001.md",
      bytes: new TextEncoder().encode(fixture.source.originalText),
    }).source;
    // 一次干净的 fixture 运行恰好消耗 2 × 分块数 + 3 次调用
    // （抽取、补抽、人名、结局、合并）；把上限设在这个值上。
    const baseCalls =
      deriveEvidenceUnitChunks(deriveEvidenceUnits(source)).length * 2 + 3;
    const previousBudget = process.env.STORY_MAP_MAX_MODEL_CALLS;
    process.env.STORY_MAP_MAX_MODEL_CALLS = String(baseCalls);
    const generateSpy = vi.spyOn(MockAIProvider.prototype, "generate");

    try {
      resetJobRecoveryForTests();
      // 模拟一个已把本次 run group 预算用完的失败 attempt。
      const exhaustedGroupId = "run_budget_exhausted";
      const exhausted = createJob({
        projectId: project.id,
        kind: "story_map_generation",
        input: { sourceId: source.id, runGroupId: exhaustedGroupId },
      });
      markJobRunning({ id: exhausted.id });
      updateJobModelCalls({ id: exhausted.id, modelCalls: baseCalls });
      markJobFailed({
        id: exhausted.id,
        error: "Story Map 生成失败，未保存 Artifact。",
      });

      const resumed = startStoryMapGenerationJob({
        projectId: project.id,
        sourceId: source.id,
        mode: "resume",
      });
      expect(resumed.job.input.runGroupId).toBe(exhaustedGroupId);
      await runStoryMapGenerationJob(resumed.job.id);

      expect(getJob(resumed.job.id)).toMatchObject({
        status: "failed",
        error: STORY_MAP_BUDGET_EXHAUSTED_ERROR,
      });
      // 预检在调用 provider 前 fail closed，没有新增任何模型调用。
      expect(generateSpy).not.toHaveBeenCalled();

      const fresh = startStoryMapGenerationJob({
        projectId: project.id,
        sourceId: source.id,
        mode: "fresh",
      });
      expect(fresh.job.input.runGroupId).not.toBe(exhaustedGroupId);
      expect(fresh.job.input.retryOfJobId).toBeUndefined();
      await runStoryMapGenerationJob(fresh.job.id);

      expect(getJob(fresh.job.id)).toMatchObject({
        status: "succeeded",
        error: null,
        result: { artifactId: expect.any(String) },
      });
      expect(generateSpy).toHaveBeenCalledTimes(baseCalls);
    } finally {
      generateSpy.mockRestore();
      restoreEnvironment("STORY_MAP_MAX_MODEL_CALLS", previousBudget);
    }
  });

  it("stores only the sanitized failure message and no artifact", async () => {
    const project = createProject({ title: "Job runner failure" });
    const source = importProjectSource({
      projectId: project.id,
      fileName: "invented.md",
      bytes: new TextEncoder().encode("许澄在渡口等了一夜。"),
    }).source;
    resetJobRecoveryForTests();
    const started = startStoryMapGenerationJob({
      projectId: project.id,
      sourceId: source.id,
    });

    await runStoryMapGenerationJob(started.job.id);

    const job = getJob(started.job.id);
    expect(job).toMatchObject({
      status: "failed",
      result: null,
      error: "Mock AI 只接受公开基准故事 ripple-001",
    });
    expect(job?.error).not.toContain("渡口");
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([]);
  });
});

function restoreEnvironment(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
