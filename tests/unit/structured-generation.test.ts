import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { closeDatabase, getDatabase } from "@/server/db/client";
import { generateStructured } from "@/server/ai/generate-structured";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { createProject } from "@/server/repositories/project-repository";
import {
  getGenerationRun,
  listProjectGenerationRuns,
} from "@/server/repositories/generation-run-repository";

const AnswerSchema = z
  .object({
    answer: z.string().min(1),
  })
  .strict();

let temporaryDirectory: string;
let databasePath: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "novelripple-step6-"));
  databasePath = path.join(temporaryDirectory, "test.db");
  process.env.DB_FILE_NAME = databasePath;
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

function createInput(projectId: string) {
  return {
    projectId,
    worldlineId: null,
    kind: "story_map",
    promptVersion: "story-map.v1",
    prompt: "Return one test answer.",
    schemaName: "test_answer",
    schema: AnswerSchema,
    modelConfig: {
      model: "mock-model",
      structuredOutputMode: "json_schema" as const,
    },
  };
}

describe("structured generation", () => {
  it("migrates the nullable generation_runs.worldline_id column", () => {
    const sqlite = new Database(databasePath, { readonly: true });
    const columns = sqlite
      .prepare("PRAGMA table_info(generation_runs)")
      .all() as Array<{ name: string; notnull: 0 | 1 }>;
    sqlite.close();

    expect(columns).toContainEqual(
      expect.objectContaining({ name: "worldline_id", notnull: 0 }),
    );
  });

  it("validates a successful first response and records a succeeded run", async () => {
    const project = createProject({ title: "结构化成功" });
    const provider = new MockAIProvider(['{"answer":"ok"}']);

    const result = await generateStructured(createInput(project.id), provider);
    const run = getGenerationRun(result.generation.runId);

    expect(result.value).toEqual({ answer: "ok" });
    expect(result.generation).toMatchObject({
      provider: "mock",
      model: "mock-model",
      attemptCount: 1,
    });
    expect(provider.requests).toHaveLength(1);
    expect(run).toMatchObject({
      projectId: project.id,
      worldlineId: null,
      status: "succeeded",
      error: null,
    });
    expect(run?.completedAt).not.toBeNull();
    expect(run?.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(run?.rawOutput ?? "")).toEqual({
      attempts: [{ kind: "initial", rawOutput: '{"answer":"ok"}' }],
    });
  });

  it("repairs one invalid schema response exactly once", async () => {
    const project = createProject({ title: "一次修复" });
    const provider = new MockAIProvider([
      '{"answer":123}',
      '{"answer":"repaired"}',
    ]);

    const result = await generateStructured(createInput(project.id), provider);
    const run = getGenerationRun(result.generation.runId);

    expect(result.value).toEqual({ answer: "repaired" });
    expect(result.generation.attemptCount).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.repair).toBeUndefined();
    expect(provider.requests[1]?.repair).toMatchObject({
      previousRawOutput: '{"answer":123}',
    });
    expect(provider.requests[1]?.repair?.validationIssues).not.toHaveLength(0);
    expect(run?.status).toBe("succeeded");
    expect(JSON.parse(run?.rawOutput ?? "").attempts).toHaveLength(2);
  });

  it("uses the same single repair for deterministic validation issues", async () => {
    const project = createProject({ title: "确定性修复" });
    const provider = new MockAIProvider([
      '{"answer":"invalid domain value"}',
      '{"answer":"accepted"}',
    ]);

    const result = await generateStructured(
      {
        ...createInput(project.id),
        validate: (value) =>
          value.answer === "accepted"
            ? []
            : [{ path: "answer", message: "未通过确定性领域校验" }],
      },
      provider,
    );

    expect(result.value).toEqual({ answer: "accepted" });
    expect(result.generation.attemptCount).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.repair?.validationIssues).toContain(
      "answer: 未通过确定性领域校验",
    );
  });

  it("fails after deterministic validation rejects the repair", async () => {
    const project = createProject({ title: "确定性二次失败" });
    const provider = new MockAIProvider([
      '{"answer":"invalid one"}',
      '{"answer":"invalid two"}',
      '{"answer":"must not run"}',
    ]);

    await expect(
      generateStructured(
        {
          ...createInput(project.id),
          validate: () => [
            { path: "answer", message: "始终不符合领域合同" },
          ],
        },
        provider,
      ),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(2);
    expect(listProjectGenerationRuns(project.id)[0]).toMatchObject({
      status: "failed",
      error: "answer: 始终不符合领域合同",
    });
  });

  it("fails closed after a second invalid schema response", async () => {
    const project = createProject({ title: "二次失败" });
    const provider = new MockAIProvider([
      '{"answer":123}',
      '{"answer":false}',
      '{"answer":"must not run"}',
    ]);

    await expect(
      generateStructured(createInput(project.id), provider),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(2);
    const run = listProjectGenerationRuns(project.id)[0];
    expect(run).toMatchObject({ status: "failed" });
    expect(run?.error).toContain("answer");
    expect(JSON.parse(run?.rawOutput ?? "").attempts).toHaveLength(2);
  });

  it("does not guess JSON from Markdown fences", async () => {
    const project = createProject({ title: "禁止猜测" });
    const provider = new MockAIProvider([
      '```json\n{"answer":"hidden"}\n```',
      '```json\n{"answer":"still hidden"}\n```',
    ]);

    await expect(
      generateStructured(createInput(project.id), provider),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.repair?.validationIssues).toContain(
      "Response is not valid JSON",
    );
  });

  it("records provider errors as failed without attempting schema repair", async () => {
    const project = createProject({ title: "供应商失败" });
    const provider = new MockAIProvider([new Error("upstream unavailable")]);

    await expect(
      generateStructured(createInput(project.id), provider),
    ).rejects.toThrow("upstream unavailable");

    expect(provider.requests).toHaveLength(1);
    const run = listProjectGenerationRuns(project.id)[0];
    expect(run).toMatchObject({
      status: "failed",
      rawOutput: null,
      error: "upstream unavailable",
    });
  });

  it("never leaves a run pending when a deterministic validator throws", async () => {
    const project = createProject({ title: "校验器异常" });
    const provider = new MockAIProvider(['{"answer":"valid shape"}']);

    await expect(
      generateStructured(
        {
          ...createInput(project.id),
          validate: () => {
            throw new Error("validator crashed");
          },
        },
        provider,
      ),
    ).rejects.toThrow("validator crashed");

    expect(provider.requests).toHaveLength(1);
    expect(listProjectGenerationRuns(project.id)[0]).toMatchObject({
      status: "failed",
      error: "validator crashed",
    });
  });

  it("retries once when the provider returns an empty-text response", async () => {
    const project = createProject({ title: "空响应重试" });
    const provider = new MockAIProvider([
      new Error("OpenAI-compatible response contained no text content"),
      '{"answer":"ok"}',
    ]);

    const result = await generateStructured(createInput(project.id), provider);

    expect(provider.requests).toHaveLength(2);
    expect(result.value).toEqual({ answer: "ok" });
    expect(getGenerationRun(result.generation.runId)).toMatchObject({
      status: "succeeded",
    });
  });

  it("fails the run when both attempts return empty-text responses", async () => {
    const project = createProject({ title: "空响应两次" });
    const provider = new MockAIProvider([
      new Error("OpenAI-compatible response contained no text content"),
      new Error("OpenAI-compatible response contained no text content"),
    ]);

    await expect(
      generateStructured(createInput(project.id), provider),
    ).rejects.toThrow("no text content");

    expect(provider.requests).toHaveLength(2);
    expect(listProjectGenerationRuns(project.id)[0]).toMatchObject({
      status: "failed",
    });
  });
});
