import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  getJob,
  listProjectJobs,
} from "@/server/repositories/job-repository";
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
