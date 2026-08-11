import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { closeDatabase, getDatabase } from "@/server/db/client";
import { generateStructured } from "@/server/ai/generate-structured";
import { MockAIProvider } from "@/server/ai/mock-provider";
import {
  listProjectGenerationRuns,
} from "@/server/repositories/generation-run-repository";
import { createProject } from "@/server/repositories/project-repository";

const ContractOutputSchema = z
  .object({ result: z.string().min(1) })
  .strict();

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-contract-"),
  );
  process.env.DB_FILE_NAME = path.join(temporaryDirectory, "contract.db");
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

function contractInput(projectId: string) {
  return {
    projectId,
    worldlineId: null,
    kind: "story_map_reconcile",
    promptVersion: "story-map-reconcile.v1",
    prompt: "Return the fixed contract response.",
    schemaName: "m0_contract_output",
    schema: ContractOutputSchema,
    modelConfig: {
      model: "mock-contract-model",
      structuredOutputMode: "json_schema" as const,
    },
  };
}

describe("M0 structured generation contract", () => {
  it("accepts a validated object and persists its explicit prompt version", async () => {
    const project = createProject({ title: "Contract success" });
    const provider = new MockAIProvider(['{"result":"valid"}']);

    const result = await generateStructured(contractInput(project.id), provider);
    const run = listProjectGenerationRuns(project.id)[0];

    expect(result.value).toEqual({ result: "valid" });
    expect(result.generation.attemptCount).toBe(1);
    expect(run).toMatchObject({
      status: "succeeded",
      promptVersion: "story-map-reconcile.v1",
      provider: "mock",
      model: "mock-contract-model",
    });
  });

  it("uses exactly one full-response repair after a schema failure", async () => {
    const project = createProject({ title: "Contract repair" });
    const provider = new MockAIProvider([
      '{"result":42}',
      '{"result":"repaired"}',
    ]);

    const result = await generateStructured(contractInput(project.id), provider);

    expect(result.value).toEqual({ result: "repaired" });
    expect(result.generation.attemptCount).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.repair).toMatchObject({
      previousRawOutput: '{"result":42}',
    });
  });

  it("shares the same one-repair budget with deterministic validation", async () => {
    const project = createProject({ title: "Contract invariant repair" });
    const provider = new MockAIProvider([
      '{"result":"unsupported"}',
      '{"result":"accepted"}',
    ]);

    const result = await generateStructured(
      {
        ...contractInput(project.id),
        validate: (value) =>
          value.result === "accepted"
            ? []
            : [{ path: "result", message: "领域不变量失败" }],
      },
      provider,
    );

    expect(result.value).toEqual({ result: "accepted" });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.repair?.validationIssues).toContain(
      "result: 领域不变量失败",
    );
  });

  it("fails closed after the repair and never sends a third request", async () => {
    const project = createProject({ title: "Contract fail closed" });
    const provider = new MockAIProvider([
      "not-json",
      '{"result":false}',
      '{"result":"must not run"}',
    ]);

    await expect(
      generateStructured(contractInput(project.id), provider),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(2);
    const run = listProjectGenerationRuns(project.id)[0];
    expect(run?.status).toBe("failed");
    expect(JSON.parse(run?.rawOutput ?? "").attempts).toHaveLength(2);
  });
});
