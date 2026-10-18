import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RippleSuggestionsModelOutput } from "@/domain/schemas";
import { MockAIProvider } from "@/server/ai/mock-provider";
import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "@/server/ai/types";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { artifacts, generationRuns } from "@/server/db/schema";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import {
  createGenerationRun,
  incrementGenerationRunModelCalls,
  listProjectGenerationRuns,
  sumRippleSuggestionModelCallsForStoryMap,
  succeedGenerationRun,
} from "@/server/repositories/generation-run-repository";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import {
  listProjectWorldlines,
} from "@/server/repositories/ripple-repository";
import {
  listRippleSuggestionsArtifactsForStoryMap,
  listRippleSuggestionsBatchesForStoryMap,
} from "@/server/repositories/ripple-suggestions-repository";
import { generateRippleSuggestions } from "@/server/ripple/generate-ripple-suggestions";
import { rippleSuggestionModelCallLimit } from "@/server/ripple/ripple-suggestion-limits";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";
import { completeReviewAndConfirm } from "../helpers/confirm-ready-story-map";

let temporaryDirectory: string;
const previousEnvironment = new Map<string, string | undefined>();

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-ripple-suggestions-"),
  );
  process.env.DB_FILE_NAME = path.join(temporaryDirectory, "test.db");
  for (const name of [
    "AI_PROVIDER_NAME",
    "OPENAI_MODEL",
    "OPENAI_STRUCTURED_OUTPUT_MODE",
    "RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION",
  ]) {
    previousEnvironment.set(name, process.env[name]);
  }
  process.env.AI_PROVIDER_NAME = "mock";
  process.env.OPENAI_MODEL = "mock-ripple-model";
  process.env.OPENAI_STRUCTURED_OUTPUT_MODE = "json_schema";
  closeDatabase();
  migrate(getDatabase(), { migrationsFolder: path.join(process.cwd(), "drizzle") });
});

afterAll(async () => {
  closeDatabase();
  delete process.env.DB_FILE_NAME;
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(temporaryDirectory, { recursive: true });
});

const modelConfig = {
  model: "mock-ripple-model",
  structuredOutputMode: "json_schema" as const,
};

/** 慢速 provider：让两个并发请求都先进入 in-flight 窗口。 */
class SlowAIProvider implements AIProvider {
  readonly providerName = "slow-mock";
  readonly requests: AIProviderRequest[] = [];
  readonly #output: string;

  constructor(output: string) {
    this.#output = output;
  }

  async generate(request: AIProviderRequest): Promise<AIProviderResponse> {
    this.requests.push(request);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { rawOutput: this.#output };
  }
}

/** 每次调用都失败的 provider：用于验证失败尝试也被计入上限。 */
class FailingAIProvider implements AIProvider {
  readonly providerName = "failing-mock";
  readonly requests: AIProviderRequest[] = [];

  async generate(request: AIProviderRequest): Promise<AIProviderResponse> {
    this.requests.push(request);
    throw new Error("provider unavailable");
  }
}

const validSuggestions: RippleSuggestionsModelOutput = {
  suggestions: [
    {
      eventId: "event_03",
      divergenceType: "prevent",
      instruction: "让关键证据没有被发现",
      whyInteresting: "这会切断两条后续调查路径。",
      affectedCharacterIds: ["char_xucheng", "char_zhoulan"],
      anchorRisk: "high",
    },
    {
      eventId: "event_06",
      divergenceType: "choice",
      instruction: "让证人拒绝交出关键记录",
      whyInteresting: "后续公开和行动都需要改道。",
      affectedCharacterIds: ["char_xucheng", "char_shenyan"],
      anchorRisk: "medium",
    },
    {
      eventId: "event_10",
      divergenceType: "outcome",
      instruction: "让缺失证据仍未被找到",
      whyInteresting: "结局的证明方式会发生变化。",
      affectedCharacterIds: ["char_xucheng"],
      anchorRisk: "medium",
    },
  ],
};

async function createContext(confirmed = true) {
  const fixture = await loadRippleFixture();
  const project = createProject({ title: "Ripple suggestions" });
  const imported = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: new TextEncoder().encode(fixture.source.originalText),
  });
  const generated = await generateConfiguredStoryMap({
    projectId: project.id,
    sourceId: imported.source.id,
  });
  const artifact = confirmed
    ? completeReviewAndConfirm({
        projectId: project.id,
        source: imported.source,
        artifact: generated.artifact,
      })
    : generated.artifact;
  return { fixture, project, source: imported.source, artifact };
}

describe("Ripple Suggestions generation", () => {
  it("persists three validated candidates without Source text or Worldline writes", async () => {
    const { project, source, artifact } = await createContext();
    const provider = new MockAIProvider([JSON.stringify(validSuggestions)]);

    const result = await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      provider,
      modelConfig,
    });

    expect(result.artifact).toMatchObject({
      kind: "ripple_suggestions",
      storyMapArtifactId: artifact.id,
      basedOnArtifactId: artifact.id,
      suggestions: validSuggestions.suggestions,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.prompt).not.toContain(source.normalizedText);
    expect(provider.requests[0]?.prompt).not.toContain("evidence");
    expect(provider.requests[0]?.prompt).toContain(
      "至少一条从该 Event 出发的 `causes` 或 `enables` Edge",
    );
    expect(provider.requests[0]?.prompt).toContain(
      '"eligibleEventIds":["event_01","event_02","event_03"',
    );
    expect(listProjectWorldlines(project.id)).toEqual([]);
    expect(
      listRippleSuggestionsArtifactsForStoryMap(project.id, artifact.id),
    ).toHaveLength(1);
    expect(
      listProjectGenerationRuns(project.id).find(
        (run) => run.kind === "ripple_suggestions",
      ),
    ).toMatchObject({ status: "succeeded", promptVersion: "ripple-suggestions.v4" });
  });

  it("requires a confirmed Story Map", async () => {
    const { project, artifact } = await createContext(false);
    await expect(
      generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        provider: new MockAIProvider([JSON.stringify(validSuggestions)]),
        modelConfig,
      }),
    ).rejects.toThrow("只有 confirmed Story Map");
  });

  it.each([
    ["unknown Event", { ...validSuggestions.suggestions[0], eventId: "event_missing" }],
    ["last Event", { ...validSuggestions.suggestions[0], eventId: "event_12" }],
    ["unknown Character", { ...validSuggestions.suggestions[0], affectedCharacterIds: ["char_missing"] }],
    ["duplicate Character", { ...validSuggestions.suggestions[0], affectedCharacterIds: ["char_xucheng", "char_xucheng"] }],
  ])("fails closed for %s after one repair", async (_label, invalidSuggestion) => {
    const { project, artifact } = await createContext();
    const invalid = { suggestions: [invalidSuggestion] };
    const provider = new MockAIProvider([
      JSON.stringify(invalid),
      JSON.stringify(invalid),
      JSON.stringify(validSuggestions),
    ]);

    await expect(
      generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        provider,
        modelConfig,
      }),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(2);
    expect(
      listRippleSuggestionsArtifactsForStoryMap(project.id, artifact.id),
    ).toEqual([]);
    expect(listProjectWorldlines(project.id)).toEqual([]);
  });

  it("rejects duplicate suggested Events as one invalid candidate set", async () => {
    const { project, artifact } = await createContext();
    const duplicated = {
      suggestions: [
        validSuggestions.suggestions[0],
        { ...validSuggestions.suggestions[1], eventId: "event_03" },
      ],
    };
    const provider = new MockAIProvider([
      JSON.stringify(duplicated),
      JSON.stringify(duplicated),
    ]);

    await expect(
      generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        provider,
        modelConfig,
      }),
    ).rejects.toThrow("Structured generation failed schema validation");
    expect(provider.requests).toHaveLength(2);
  });

  it("reuses the latest suggestions artifact without another provider call", async () => {
    const { project, artifact } = await createContext();
    const first = await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      provider: new MockAIProvider([JSON.stringify(validSuggestions)]),
      modelConfig,
    });
    const secondProvider = new MockAIProvider([]);

    const second = await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      provider: secondProvider,
      modelConfig,
    });

    expect(second.artifact).toEqual(first.artifact);
    expect(second.generation).toBeNull();
    expect(secondProvider.requests).toHaveLength(0);
    expect(
      listRippleSuggestionsArtifactsForStoryMap(project.id, artifact.id),
    ).toHaveLength(1);
  });

  it("coalesces concurrent suggestions requests into one provider call", async () => {
    const { project, artifact } = await createContext();
    const provider = new SlowAIProvider(JSON.stringify(validSuggestions));

    const [first, second] = await Promise.all([
      generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        provider,
        modelConfig,
      }),
      generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        provider,
        modelConfig,
      }),
    ]);

    expect(provider.requests).toHaveLength(1);
    expect(first.artifact.id).toBe(second.artifact.id);
    expect(
      listRippleSuggestionsArtifactsForStoryMap(project.id, artifact.id),
    ).toHaveLength(1);
  });

  it("appends a refresh batch and leaves the previous batch untouched", async () => {
    const { project, artifact } = await createContext();
    const first = await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      provider: new MockAIProvider([JSON.stringify(validSuggestions)]),
      modelConfig,
    });
    const firstSnapshot = JSON.stringify(first.artifact);

    const refreshProvider = new MockAIProvider([
      JSON.stringify(validSuggestions),
    ]);
    const second = await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      idempotencyKey: "refresh-key-1",
      provider: refreshProvider,
      modelConfig,
    });

    expect(second.artifact).toMatchObject({
      batchIndex: 1,
      refreshOf: first.artifact.id,
      idempotencyKey: "refresh-key-1",
    });
    expect(second.artifact.id).not.toBe(first.artifact.id);
    expect(refreshProvider.requests).toHaveLength(1);
    expect(refreshProvider.requests[0]?.prompt).toContain(
      '"previousBatches":[{"batchIndex":0',
    );
    expect(refreshProvider.requests[0]?.prompt).toContain(
      '"title":"红色账簿现身"',
    );

    const batches = listRippleSuggestionsBatchesForStoryMap(
      project.id,
      artifact.id,
    );
    expect(batches.map((batch) => batch.batchIndex)).toEqual([0, 1]);
    expect(JSON.stringify(batches[0])).toBe(firstSnapshot);
    expect(batches[0]?.suggestions).toEqual(first.artifact.suggestions);
  });

  it("returns the same refresh artifact for the same key without another call", async () => {
    const { project, artifact } = await createContext();
    const first = await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      provider: new MockAIProvider([JSON.stringify(validSuggestions)]),
      modelConfig,
    });
    const second = await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      idempotencyKey: "same-key",
      provider: new MockAIProvider([JSON.stringify(validSuggestions)]),
      modelConfig,
    });
    const repeatedProvider = new MockAIProvider([]);

    const repeated = await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      idempotencyKey: "same-key",
      provider: repeatedProvider,
      modelConfig,
    });

    expect(repeated.artifact).toEqual(second.artifact);
    expect(repeated.generation).toBeNull();
    expect(repeatedProvider.requests).toHaveLength(0);
    expect(
      listRippleSuggestionsBatchesForStoryMap(project.id, artifact.id),
    ).toHaveLength(2);
    expect(first.artifact.batchIndex).toBe(0);
  });

  it("coalesces concurrent refresh requests with the same key into one call", async () => {
    const { project, artifact } = await createContext();
    await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      provider: new MockAIProvider([JSON.stringify(validSuggestions)]),
      modelConfig,
    });
    const provider = new SlowAIProvider(JSON.stringify(validSuggestions));

    const [first, second] = await Promise.all([
      generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        idempotencyKey: "concurrent-refresh",
        provider,
        modelConfig,
      }),
      generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        idempotencyKey: "concurrent-refresh",
        provider,
        modelConfig,
      }),
    ]);

    expect(provider.requests).toHaveLength(1);
    expect(first.artifact.id).toBe(second.artifact.id);
    expect(first.artifact.batchIndex).toBe(1);
    expect(
      listRippleSuggestionsBatchesForStoryMap(project.id, artifact.id),
    ).toHaveLength(2);
  });

  it("enforces the batch cap before any model call", async () => {
    const { project, artifact } = await createContext();
    await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      maxBatches: 2,
      provider: new MockAIProvider([JSON.stringify(validSuggestions)]),
      modelConfig,
    });
    await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      idempotencyKey: "cap-batch-1",
      maxBatches: 2,
      provider: new MockAIProvider([JSON.stringify(validSuggestions)]),
      modelConfig,
    });
    const blockedProvider = new MockAIProvider([]);
    const runsBefore = listProjectGenerationRuns(project.id).filter(
      (run) => run.kind === "ripple_suggestions",
    ).length;

    await expect(
      generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        idempotencyKey: "cap-batch-2",
        maxBatches: 2,
        provider: blockedProvider,
        modelConfig,
      }),
    ).rejects.toThrow("换一批上限");

    expect(blockedProvider.requests).toHaveLength(0);
    expect(
      listRippleSuggestionsBatchesForStoryMap(project.id, artifact.id),
    ).toHaveLength(2);
    expect(
      listProjectGenerationRuns(project.id).filter(
        (run) => run.kind === "ripple_suggestions",
      ),
    ).toHaveLength(runsBefore);
    expect(
      sumRippleSuggestionModelCallsForStoryMap(project.id, artifact.id),
    ).toBe(2);
  });

  it("persists the initial and repair calls on the generation run", async () => {
    const { project, artifact } = await createContext();
    const invalid = {
      suggestions: [
        { ...validSuggestions.suggestions[0], eventId: "event_missing" },
      ],
    };
    const provider = new MockAIProvider([
      JSON.stringify(invalid),
      JSON.stringify(validSuggestions),
    ]);

    const result = await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      maxBatches: 1,
      provider,
      modelConfig,
    });

    expect(provider.requests).toHaveLength(2);
    const run = listProjectGenerationRuns(project.id).find(
      (candidate) => candidate.id === result.generation?.runId,
    );
    expect(run).toMatchObject({ status: "succeeded", modelCalls: 2 });
    expect(
      sumRippleSuggestionModelCallsForStoryMap(project.id, artifact.id),
    ).toBe(2);
  });

  it("does not let failures block normal refresh before the model-call ceiling", async () => {
    const { project, artifact } = await createContext();
    const maxBatches = 2;
    const modelCallLimit = rippleSuggestionModelCallLimit(maxBatches);
    await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      maxBatches,
      provider: new MockAIProvider([JSON.stringify(validSuggestions)]),
      modelConfig,
    });

    // 旧实现会按 `批次上限 × 2` 统计 run，3 次失败后就会挡住正常换批。
    // 现在只数真实调用：9 次失败 + 首批 1 次 = 10 次，仍低于 12 次硬上限。
    for (let failed = 1; failed <= 9; failed += 1) {
      const provider = new FailingAIProvider();
      await expect(
        generateRippleSuggestions({
          projectId: project.id,
          storyMapArtifactId: artifact.id,
          idempotencyKey: `failed-refresh-${failed}`,
          maxBatches,
          provider,
          modelConfig,
        }),
      ).rejects.toThrow("provider unavailable");
      expect(provider.requests).toHaveLength(1);
    }
    expect(
      sumRippleSuggestionModelCallsForStoryMap(project.id, artifact.id),
    ).toBe(10);

    const refreshProvider = new MockAIProvider([
      JSON.stringify(validSuggestions),
    ]);
    const refreshed = await generateRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      idempotencyKey: "refresh-after-failures",
      maxBatches,
      provider: refreshProvider,
      modelConfig,
    });

    expect(refreshProvider.requests).toHaveLength(1);
    expect(refreshed.artifact.batchIndex).toBe(1);
    expect(
      sumRippleSuggestionModelCallsForStoryMap(project.id, artifact.id),
    ).toBe(11);
    expect(modelCallLimit).toBe(12);
    expect(
      listRippleSuggestionsBatchesForStoryMap(project.id, artifact.id),
    ).toHaveLength(2);
  });

  it("fails closed before any provider call once the model-call ceiling is reached", async () => {
    const { project, artifact } = await createContext();
    const maxBatches = 1;
    const modelCallLimit = rippleSuggestionModelCallLimit(maxBatches);
    const exhausted = createGenerationRun({
      projectId: project.id,
      worldlineId: null,
      storyMapArtifactId: artifact.id,
      kind: "ripple_suggestions",
      provider: "seed",
      model: "seed-model",
      promptVersion: "seed",
      inputHash: "0".repeat(64),
    });
    for (let call = 0; call < modelCallLimit; call += 1) {
      incrementGenerationRunModelCalls(exhausted.id);
    }
    expect(
      sumRippleSuggestionModelCallsForStoryMap(project.id, artifact.id),
    ).toBe(modelCallLimit);

    const provider = new MockAIProvider([JSON.stringify(validSuggestions)]);
    const runsBefore = listProjectGenerationRuns(project.id).filter(
      (run) => run.kind === "ripple_suggestions",
    ).length;

    await expect(
      generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        maxBatches,
        provider,
        modelConfig,
      }),
    ).rejects.toThrow("模型调用上限");

    expect(provider.requests).toHaveLength(0);
    expect(
      listProjectGenerationRuns(project.id).filter(
        (run) => run.kind === "ripple_suggestions",
      ),
    ).toHaveLength(runsBefore);
    expect(
      listRippleSuggestionsBatchesForStoryMap(project.id, artifact.id),
    ).toHaveLength(0);
  });

  it("stops a repair call when the next provider call would exceed the ceiling", async () => {
    const { project, artifact } = await createContext();
    const maxBatches = 1;
    const modelCallLimit = rippleSuggestionModelCallLimit(maxBatches);
    const seeded = createGenerationRun({
      projectId: project.id,
      worldlineId: null,
      storyMapArtifactId: artifact.id,
      kind: "ripple_suggestions",
      provider: "seed",
      model: "seed-model",
      promptVersion: "seed",
      inputHash: "0".repeat(64),
    });
    for (let call = 0; call < modelCallLimit - 1; call += 1) {
      incrementGenerationRunModelCalls(seeded.id);
    }

    // 首轮返回可解析但未通过领域校验的输出，本应触发 repair；但再调用一次
    // 就会超过硬上限，因此必须在 repair 前停止。
    const invalid = {
      suggestions: [
        { ...validSuggestions.suggestions[0], eventId: "event_missing" },
      ],
    };
    const provider = new MockAIProvider([
      JSON.stringify(invalid),
      JSON.stringify(validSuggestions),
    ]);

    await expect(
      generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        maxBatches,
        provider,
        modelConfig,
      }),
    ).rejects.toThrow("模型调用上限");

    expect(provider.requests).toHaveLength(1);
    expect(
      sumRippleSuggestionModelCallsForStoryMap(project.id, artifact.id),
    ).toBe(modelCallLimit);
    const run = listProjectGenerationRuns(project.id).find(
      (candidate) =>
        candidate.kind === "ripple_suggestions" &&
        candidate.id !== seeded.id,
    );
    expect(run).toMatchObject({ status: "failed", modelCalls: 1 });
    expect(
      listRippleSuggestionsBatchesForStoryMap(project.id, artifact.id),
    ).toHaveLength(0);
  });

  it("counts legacy generation runs without model_calls as one call each", async () => {
    const { project, artifact } = await createContext();
    const legacy = createGenerationRun({
      projectId: project.id,
      worldlineId: null,
      storyMapArtifactId: artifact.id,
      kind: "ripple_suggestions",
      provider: "legacy",
      model: "legacy-model",
      promptVersion: "seed",
      inputHash: "0".repeat(64),
    });
    getDatabase()
      .update(generationRuns)
      .set({ modelCalls: null })
      .where(eq(generationRuns.id, legacy.id))
      .run();

    expect(
      sumRippleSuggestionModelCallsForStoryMap(project.id, artifact.id),
    ).toBe(1);
    expect(
      listProjectGenerationRuns(project.id).find(
        (candidate) => candidate.id === legacy.id,
      )?.modelCalls,
    ).toBeNull();

    const current = createGenerationRun({
      projectId: project.id,
      worldlineId: null,
      storyMapArtifactId: artifact.id,
      kind: "ripple_suggestions",
      provider: "current",
      model: "current-model",
      promptVersion: "seed",
      inputHash: "0".repeat(64),
    });
    incrementGenerationRunModelCalls(current.id);
    incrementGenerationRunModelCalls(current.id);

    expect(
      sumRippleSuggestionModelCallsForStoryMap(project.id, artifact.id),
    ).toBe(3);
  });

  it("refuses to count a call after the generation run is no longer pending", async () => {
    const { project, artifact } = await createContext();
    const run = createGenerationRun({
      projectId: project.id,
      worldlineId: null,
      storyMapArtifactId: artifact.id,
      kind: "ripple_suggestions",
      provider: "mock",
      model: "mock-model",
      promptVersion: "seed",
      inputHash: "0".repeat(64),
    });
    succeedGenerationRun({ id: run.id, rawOutput: "{}" });

    expect(() => incrementGenerationRunModelCalls(run.id)).toThrow(
      "not pending",
    );
  });

  it("fails closed on an invalid batch cap env before any model call", async () => {
    const { project, artifact } = await createContext();
    process.env.RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION = "0";
    const provider = new MockAIProvider([JSON.stringify(validSuggestions)]);
    try {
      await expect(
        generateRippleSuggestions({
          projectId: project.id,
          storyMapArtifactId: artifact.id,
          provider,
          modelConfig,
        }),
      ).rejects.toThrow("必须是正整数");
      expect(provider.requests).toHaveLength(0);
    } finally {
      delete process.env.RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION;
    }
  });

  it("parses legacy suggestion rows as batch 0", async () => {
    const { project, artifact } = await createContext();
    const run = createGenerationRun({
      projectId: project.id,
      worldlineId: null,
      kind: "ripple_suggestions",
      provider: "legacy",
      model: "legacy-model",
      promptVersion: "ripple-suggestions.v3",
      inputHash: "0".repeat(64),
    });
    succeedGenerationRun({ id: run.id, rawOutput: "{}" });
    const legacyId = `artifact_ripple_suggestions_legacy_${Date.now()}`;
    getDatabase()
      .insert(artifacts)
      .values({
        id: legacyId,
        projectId: project.id,
        sourceId: artifact.sourceId,
        worldlineId: null,
        kind: "ripple_suggestions",
        schemaVersion: 1,
        version: null,
        dataJson: JSON.stringify({
          storyMapArtifactId: artifact.id,
          suggestions: validSuggestions.suggestions,
        }),
        basedOnArtifactId: artifact.id,
        generationRunId: run.id,
        createdAt: new Date().toISOString(),
      })
      .run();

    const legacy = listRippleSuggestionsArtifactsForStoryMap(
      project.id,
      artifact.id,
    ).find((batch) => batch.id === legacyId);
    expect(legacy).toMatchObject({
      id: legacyId,
      batchIndex: 0,
      refreshOf: null,
      idempotencyKey: null,
    });
  });
});
