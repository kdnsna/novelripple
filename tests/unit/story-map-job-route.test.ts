import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET } from "@/app/api/jobs/[jobId]/route";
import { closeDatabase, getDatabase } from "@/server/db/client";
import {
  ensureJobRecovery,
  resetJobRecoveryForTests,
} from "@/server/jobs/job-recovery";
import { createProject } from "@/server/repositories/project-repository";
import { createJob } from "@/server/repositories/job-repository";

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-job-route-"),
  );
  process.env.DB_FILE_NAME = path.join(temporaryDirectory, "test.db");
  closeDatabase();
  migrate(getDatabase(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
  // 固定“本进程已启动”，避免测试里刚创建的 queued 任务被当成上个进程遗留。
  resetJobRecoveryForTests();
  ensureJobRecovery();
});

afterAll(async () => {
  closeDatabase();
  delete process.env.DB_FILE_NAME;
  await rm(temporaryDirectory, { recursive: true });
});

function get(jobId: string, projectId: string | null) {
  const query =
    projectId === null
      ? ""
      : `?projectId=${encodeURIComponent(projectId)}`;
  return GET(new Request(`http://localhost/api/jobs/${jobId}${query}`), {
    params: Promise.resolve({ jobId }),
  });
}

describe("GET /api/jobs/[jobId]", () => {
  it("returns only the sanitized job view", async () => {
    const project = createProject({ title: "Job route" });
    const job = createJob({
      projectId: project.id,
      kind: "story_map_generation",
      input: { sourceId: "source_route_1" },
    });

    const response = await get(job.id, project.id);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      id: job.id,
      status: "queued",
      progress: job.progress,
      result: null,
      error: null,
    });
    expect(body).not.toHaveProperty("input");
    expect(body).not.toHaveProperty("inputJson");
    expect(body).not.toHaveProperty("heartbeatAt");
    expect(JSON.stringify(body)).not.toContain("source_route_1");
  });

  it("requires a valid project id", async () => {
    const project = createProject({ title: "Job route project id" });
    const job = createJob({
      projectId: project.id,
      kind: "story_map_generation",
      input: { sourceId: "source_route_2" },
    });

    expect((await get(job.id, null)).status).toBe(400);
    expect((await get(job.id, "")).status).toBe(400);
  });

  it("rejects invalid job ids", async () => {
    const project = createProject({ title: "Job route invalid id" });
    expect((await get("not-a-job", project.id)).status).toBe(400);
  });

  it("returns the same 404 for a missing job and another project's job", async () => {
    const owner = createProject({ title: "Job route owner" });
    const other = createProject({ title: "Job route other" });
    const job = createJob({
      projectId: owner.id,
      kind: "story_map_generation",
      input: { sourceId: "source_route_3" },
    });

    const missing = await get(
      "job_00000000-0000-4000-8000-000000000000",
      owner.id,
    );
    const foreign = await get(job.id, other.id);

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });
});
