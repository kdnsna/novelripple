import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { closeDatabase, getDatabase } from "@/server/db/client";
import {
  generateStructured,
  isTransientNetworkError,
} from "@/server/ai/generate-structured";
import { MockAIProvider } from "@/server/ai/mock-provider";
import type { AIProvider } from "@/server/ai/types";
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

const noSleep = async (): Promise<void> => {};

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

  it("forwards an optional abort signal to every provider request", async () => {
    const project = createProject({ title: "中止信号" });
    const controller = new AbortController();
    const provider = new MockAIProvider(['{"answer":123}', '{"answer":"ok"}']);

    await generateStructured(
      { ...createInput(project.id), signal: controller.signal },
      provider,
    );

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.signal).toBe(controller.signal);
    expect(provider.requests[1]?.signal).toBe(controller.signal);
  });

  it("throws the abort reason instead of sending a repair request", async () => {
    const project = createProject({ title: "修复前中止" });
    const controller = new AbortController();
    const abortReason = new Error("aborted after first pass");
    const provider = new MockAIProvider([
      '{"answer":"trigger abort"}',
      '{"answer":"must not run"}',
    ]);

    await expect(
      generateStructured(
        {
          ...createInput(project.id),
          signal: controller.signal,
          validate: () => {
            controller.abort(abortReason);
            return [{ path: "answer", message: "首轮不合法" }];
          },
        },
        provider,
      ),
    ).rejects.toBe(abortReason);

    expect(provider.requests).toHaveLength(1);
    const run = listProjectGenerationRuns(project.id)[0];
    expect(run).toMatchObject({
      status: "failed",
      error: "aborted after first pass",
    });
    expect(JSON.parse(run?.rawOutput ?? "").attempts).toHaveLength(1);
  });

  it("invokes the attempt hook before every real attempt including repair", async () => {
    const project = createProject({ title: "调用计数" });
    const attempts: number[] = [];
    const provider = new MockAIProvider(['{"answer":123}', '{"answer":"ok"}']);

    await generateStructured(
      { ...createInput(project.id), onAttempt: () => attempts.push(attempts.length + 1) },
      provider,
    );

    expect(attempts).toEqual([1, 2]);
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

  it("fails the run when all three attempts return empty-text responses", async () => {
    const project = createProject({ title: "空响应三次" });
    const provider = new MockAIProvider([
      new Error("OpenAI-compatible response contained no text content"),
      new Error("OpenAI-compatible response contained no text content"),
      new Error("OpenAI-compatible response contained no text content"),
    ]);

    await expect(
      generateStructured(createInput(project.id), provider),
    ).rejects.toThrow("no text content");

    expect(provider.requests).toHaveLength(3);
    expect(listProjectGenerationRuns(project.id)[0]).toMatchObject({
      status: "failed",
    });
  });

  it("retries the initial call once after a transient network error", async () => {
    const project = createProject({ title: "网络瞬时重试" });
    const provider = new MockAIProvider([
      new APIConnectionError({ cause: new Error("terminated") }),
      '{"answer":"ok"}',
    ]);

    const result = await generateStructured(
      { ...createInput(project.id), sleep: noSleep },
      provider,
    );

    expect(provider.requests).toHaveLength(2);
    expect(result.value).toEqual({ answer: "ok" });
    expect(result.generation.attemptCount).toBe(1);
    expect(getGenerationRun(result.generation.runId)).toMatchObject({
      status: "succeeded",
    });
  });

  it("waits a random 500–1500 ms backoff before a transient retry", async () => {
    const project = createProject({ title: "网络退避" });
    const delays: number[] = [];
    const provider = new MockAIProvider([
      new APIConnectionError({ cause: new Error("terminated") }),
      '{"answer":"ok"}',
    ]);

    const result = await generateStructured(
      {
        ...createInput(project.id),
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
      provider,
    );

    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(1500);
    expect(result.value).toEqual({ answer: "ok" });
  });

  it("throws the abort reason when aborted during the backoff wait", async () => {
    const project = createProject({ title: "等待中中止" });
    const controller = new AbortController();
    const abortReason = new Error("aborted during backoff");
    let providerCalls = 0;
    const provider: AIProvider = {
      providerName: "mock",
      async generate() {
        providerCalls += 1;
        throw new APIConnectionError({ cause: new Error("terminated") });
      },
    };

    await expect(
      generateStructured(
        {
          ...createInput(project.id),
          signal: controller.signal,
          sleep: async () => {
            controller.abort(abortReason);
          },
        },
        provider,
      ),
    ).rejects.toBe(abortReason);

    expect(providerCalls).toBe(1);
    expect(listProjectGenerationRuns(project.id)[0]).toMatchObject({
      status: "failed",
      error: "aborted during backoff",
    });
  });

  it("counts the transient retry through the attempt hook", async () => {
    const project = createProject({ title: "网络重试计数" });
    const attempts: number[] = [];
    const provider = new MockAIProvider([
      new Error("fetch failed"),
      '{"answer":"ok"}',
    ]);

    await generateStructured(
      {
        ...createInput(project.id),
        onAttempt: () => attempts.push(attempts.length + 1),
        sleep: noSleep,
      },
      provider,
    );

    expect(provider.requests).toHaveLength(2);
    expect(attempts).toEqual([1, 2]);
  });

  it("fails after two transient network errors without a third call", async () => {
    const project = createProject({ title: "网络两次失败" });
    const provider = new MockAIProvider([
      new Error("fetch failed"),
      new Error("terminated"),
      '{"answer":"must not run"}',
    ]);

    await expect(
      generateStructured(
        { ...createInput(project.id), sleep: noSleep },
        provider,
      ),
    ).rejects.toThrow("terminated");

    expect(provider.requests).toHaveLength(2);
    expect(listProjectGenerationRuns(project.id)[0]).toMatchObject({
      status: "failed",
      error: "terminated",
    });
  });

  it("throws the abort reason instead of retrying a transient network error", async () => {
    const project = createProject({ title: "网络重试前中止" });
    const controller = new AbortController();
    const abortReason = new Error("aborted before network retry");
    let providerCalls = 0;
    const provider: AIProvider = {
      providerName: "mock",
      async generate() {
        providerCalls += 1;
        controller.abort(abortReason);
        throw new APIConnectionError({ cause: new Error("terminated") });
      },
    };

    await expect(
      generateStructured(
        {
          ...createInput(project.id),
          signal: controller.signal,
          sleep: noSleep,
        },
        provider,
      ),
    ).rejects.toBe(abortReason);

    expect(providerCalls).toBe(1);
    expect(listProjectGenerationRuns(project.id)[0]).toMatchObject({
      status: "failed",
      error: "aborted before network retry",
    });
  });

  it("retries the repair call once after a transient network error", async () => {
    const project = createProject({ title: "修复网络重试" });
    const provider = new MockAIProvider([
      '{"answer":123}',
      new APIConnectionTimeoutError(),
      '{"answer":"repaired"}',
    ]);

    const result = await generateStructured(
      { ...createInput(project.id), sleep: noSleep },
      provider,
    );

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[1]?.repair).toMatchObject({
      previousRawOutput: '{"answer":123}',
    });
    expect(provider.requests[2]?.repair).toMatchObject({
      previousRawOutput: '{"answer":123}',
    });
    expect(result.value).toEqual({ answer: "repaired" });
    expect(result.generation.attemptCount).toBe(2);
  });
});

describe("isTransientNetworkError", () => {
  it("recognizes OpenAI SDK connection errors and transient causes", () => {
    expect(
      isTransientNetworkError(
        new APIConnectionError({ cause: new Error("terminated") }),
      ),
    ).toBe(true);
    expect(isTransientNetworkError(new APIConnectionTimeoutError())).toBe(true);

    const socketError = Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    });
    expect(
      isTransientNetworkError(
        new TypeError("fetch failed", { cause: socketError }),
      ),
    ).toBe(true);
  });

  it("matches transient names, codes and messages", () => {
    for (const error of [
      new Error("terminated"),
      new Error("fetch failed"),
      new Error("socket hang up"),
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
      Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
    ]) {
      expect(isTransientNetworkError(error)).toBe(true);
    }
  });

  it("never treats aborts, HTTP 4xx or validation errors as transient", () => {
    expect(
      isTransientNetworkError(new DOMException("Aborted", "AbortError")),
    ).toBe(false);
    expect(isTransientNetworkError(new APIUserAbortError())).toBe(false);
    expect(
      isTransientNetworkError(
        Object.assign(new APIUserAbortError(), {
          cause: new Error("terminated"),
        }),
      ),
    ).toBe(false);
    expect(
      isTransientNetworkError(
        Object.assign(new Error("terminated"), {
          name: "BadRequestError",
          status: 400,
        }),
      ),
    ).toBe(false);
    expect(
      isTransientNetworkError(
        Object.assign(new Error("fetch failed"), { status: 404 }),
      ),
    ).toBe(false);
    expect(isTransientNetworkError(new z.ZodError([]))).toBe(false);
  });

  it("returns false for unrelated errors and non-error values", () => {
    expect(isTransientNetworkError(new Error("upstream unavailable"))).toBe(
      false,
    );
    expect(isTransientNetworkError("terminated")).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
  });
});
