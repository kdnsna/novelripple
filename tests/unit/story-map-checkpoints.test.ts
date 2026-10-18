import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveEvidenceUnitChunks } from "@/domain/source/evidence-unit-chunks";
import { deriveEvidenceUnits } from "@/domain/source/evidence-units";
import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "@/server/ai/types";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { storyMapChunkCheckpoints } from "@/server/db/schema";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import {
  listStoryMapChunkCheckpoints,
  storyMapChunkCheckpointKey,
  type StoredStoryMapChunkCheckpoint,
} from "@/server/repositories/story-map-checkpoint-repository";
import { listStoryMapArtifactsForSource } from "@/server/repositories/story-map-artifact-repository";
import { listProjectGenerationRuns } from "@/server/repositories/generation-run-repository";
import { buildFixtureStoryMapResponses } from "@/server/story-map/fixture-story-map-responses";
import {
  STORY_MAP_PROMPT_VERSIONS,
  generateStoryMap,
} from "@/server/story-map/generate-story-map";

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-story-map-checkpoints-"),
  );
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

const modelConfig = {
  model: "mock-story-model",
  structuredOutputMode: "json_schema" as const,
};

type FixtureResponses = {
  extractionByChunk: Map<number, string>;
  gleaning: string;
  names: string;
  endings: string;
  merge: string;
};

function buildFixtureStageResponses(
  responses: string[],
  chunkCount: number,
): FixtureResponses {
  return {
    extractionByChunk: new Map(
      Array.from({ length: chunkCount }, (_, index) => [
        index,
        responses[index]!,
      ]),
    ),
    gleaning: responses[chunkCount]!,
    names: responses[2 * chunkCount]!,
    endings: responses[2 * chunkCount + 1]!,
    merge: responses[2 * chunkCount + 2]!,
  };
}

/**
 * 按 Prompt 内容而不是调用顺序返回夹具响应，因此重试跳过任意分块后仍能对齐；
 * crashAt 用来模拟“第 N 次真实 provider 调用时进程崩溃”。
 */
class FixtureStageProvider implements AIProvider {
  readonly providerName = "mock";
  readonly requests: AIProviderRequest[] = [];
  readonly #responses: FixtureResponses;
  readonly #invalidNames: string;
  readonly #crashAt: number | undefined;
  readonly #invalidNamesFirst: boolean;
  readonly #holdFirstExtract: boolean;
  #pendingOtherExtractions: number;
  #resolveExtractGate: () => void = () => {};
  readonly #extractGate: Promise<void>;
  /** 抽取阶段实际完成顺序，用于证明 run id 不是按完成顺序记录。 */
  readonly completedExtractChunks: number[] = [];
  #calls = 0;

  constructor(
    responses: FixtureResponses,
    options: {
      crashAt?: number;
      invalidNamesFirst?: boolean;
      /** 让第 0 块等到其余分块抽取完成后再返回，制造与分块顺序相反的完成顺序。 */
      holdFirstExtractUntilOthersComplete?: boolean;
    } = {},
  ) {
    this.#responses = responses;
    this.#invalidNames = makeInvalidNames(responses.names);
    this.#crashAt = options.crashAt;
    this.#invalidNamesFirst = options.invalidNamesFirst ?? false;
    this.#holdFirstExtract = options.holdFirstExtractUntilOthersComplete ?? false;
    this.#pendingOtherExtractions = Math.max(
      0,
      responses.extractionByChunk.size - 1,
    );
    this.#extractGate = new Promise<void>((resolve) => {
      this.#resolveExtractGate = resolve;
    });
    if (this.#pendingOtherExtractions === 0) this.#resolveExtractGate();
  }

  async generate(request: AIProviderRequest): Promise<AIProviderResponse> {
    this.requests.push(request);
    this.#calls += 1;
    if (this.#crashAt === this.#calls) {
      throw new Error("模拟生成崩溃");
    }
    switch (stageOf(request.prompt)) {
      case "extract": {
        const chunkIndex = chunkIndexOf(request.prompt);
        if (this.#holdFirstExtract && chunkIndex === 0) {
          await this.#extractGate;
        }
        const output = this.#responses.extractionByChunk.get(chunkIndex);
        if (output === undefined) throw new Error("夹具缺少该分块");
        if (this.#holdFirstExtract && chunkIndex !== 0) {
          this.#pendingOtherExtractions -= 1;
          if (this.#pendingOtherExtractions === 0) this.#resolveExtractGate();
        }
        this.completedExtractChunks.push(chunkIndex);
        return { rawOutput: output };
      }
      case "glean":
        return { rawOutput: this.#responses.gleaning };
      case "names":
        return {
          rawOutput:
            this.#invalidNamesFirst && request.repair === undefined
              ? this.#invalidNames
              : this.#responses.names,
        };
      case "endings":
        return { rawOutput: this.#responses.endings };
      case "merge":
        return { rawOutput: this.#responses.merge };
    }
  }
}

type FixtureStage = "extract" | "glean" | "names" | "endings" | "merge";

function stageOf(prompt: string): FixtureStage {
  if (prompt.includes("<previous_extraction>")) return "glean";
  if (prompt.includes("<story_chunk")) return "extract";
  if (prompt.includes("<character_candidates>")) return "names";
  if (prompt.includes("<story_ending_text")) return "endings";
  if (prompt.includes("<granularity_hint>")) return "merge";
  throw new Error("无法识别 Fixture 阶段");
}

function chunkIndexOf(prompt: string): number {
  const match = prompt.match(/<story_chunk id="[^"]*:(\d+)"/);
  if (!match) throw new Error("无法识别 Fixture 分块");
  return Number(match[1]) - 1;
}

function makeInvalidNames(names: string): string {
  const parsed = JSON.parse(names) as {
    characters: { mergedFrom: string[] }[];
  };
  parsed.characters[0]!.mergedFrom = ["char_unknown"];
  return JSON.stringify(parsed);
}

async function createContext() {
  const fixture = await loadRippleFixture();
  const project = createProject({ title: "Story Map checkpoints" });
  const source = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: new TextEncoder().encode(fixture.source.originalText),
  }).source;
  const chunks = deriveEvidenceUnitChunks(deriveEvidenceUnits(source));
  const responses = buildFixtureStoryMapResponses(source, fixture.storyMap);
  return {
    project,
    source,
    chunks,
    providerResponses: buildFixtureStageResponses(responses, chunks.length),
  };
}

/**
 * 三个自然段各约 5,250 字，超过两块合并上限，稳定生成三个分块。
 * 全部内容都是自造短句，只用于验证分块来源列表的位置对齐。
 */
async function createThreeChunkContext() {
  const text = [
    "许澄在旧宅发现一封未寄出的信。",
    "沈岚在渡口听见有人提起那封信。",
    "两人在雨夜决定把信交给报馆。",
  ]
    .map((sentence) => sentence.repeat(350))
    .join("\n\n");
  const project = createProject({ title: "Story Map legacy run gap" });
  const source = importProjectSource({
    projectId: project.id,
    fileName: "invented-three-chunks.md",
    bytes: new TextEncoder().encode(text),
  }).source;
  const chunks = deriveEvidenceUnitChunks(deriveEvidenceUnits(source));
  const names = ["许澄", "沈岚", "报馆编辑"] as const;
  const roles = ["protagonist", "supporting", "minor"] as const;
  const summaries = ["许澄发现旧信", "沈岚听说旧信", "两人决定交出旧信"] as const;

  const extractionByChunk = new Map(
    chunks.map((chunk, index) => {
      const characterId = `character_${index + 1}`;
      const eventId = `event_${index + 1}`;
      return [
        index,
        JSON.stringify({
          title: "旧信",
          logline: "一封未寄出的信改变了两个人的选择",
          characters: [
            {
              id: characterId,
              name: names[index]!,
              aliases: [],
              role: roles[index]!,
              initialState: "尚未作出选择",
              kind: "individual",
            },
          ],
          events: [
            {
              id: eventId,
              title: summaries[index]!,
              summary: summaries[index]!,
              sequence: index + 1,
              participants: [characterId],
              stateChanges: [`${names[index]}知道了旧信的存在`],
              evidenceKind: "fact",
              evidenceUnitIds: [chunk.coreUnitIds[0]!],
            },
          ],
          edges: [],
        }),
      ] as const;
    }),
  );

  return {
    project,
    source,
    chunks,
    providerResponses: {
      extractionByChunk,
      gleaning: JSON.stringify({ characters: [], events: [], edges: [] }),
      names: JSON.stringify({
        characters: names.map((name, index) => ({
          id: `character_${index + 1}`,
          name,
          aliases: [],
          role: roles[index]!,
          initialState: "尚未作出选择",
          mergedFrom: [`character_${index + 1}`],
        })),
        rejectedCandidateIds: [],
      }),
      endings: JSON.stringify({
        additionalEvents: [],
        endings: [
          {
            id: "ending_1",
            targetEventId: "event_3",
            requirement: "旧信被交到报馆",
            evidenceUnitIds: [chunks[2]!.coreUnitIds[0]!],
          },
        ],
        characterEndings: [],
      }),
      merge: JSON.stringify({
        title: "旧信",
        logline: "一封未寄出的信改变了两个人的选择",
        duplicateEventGroups: [],
        duplicateEndingGroups: [],
        edges: [],
      }),
    },
  };
}

function storyMapContent(
  storyMap: Awaited<
    ReturnType<typeof generateStoryMap>
  >["artifact"]["storyMap"],
) {
  return {
    title: storyMap.title,
    logline: storyMap.logline,
    characters: storyMap.characters,
    events: storyMap.events,
    edges: storyMap.edges,
    endingCandidates: storyMap.endingCandidates,
  };
}

/** 同一 chunk + stage 只保留最新一行；与生成管线的复用规则一致。 */
function latestCheckpointByChunkStage(
  checkpoints: StoredStoryMapChunkCheckpoint[],
): Map<string, StoredStoryMapChunkCheckpoint> {
  const latest = new Map<string, StoredStoryMapChunkCheckpoint>();
  for (const checkpoint of checkpoints) {
    const key = `${checkpoint.chunkIndex}:${checkpoint.stage}`;
    if (!latest.has(key)) latest.set(key, checkpoint);
  }
  return latest;
}

describe("Story Map chunk checkpoints", () => {
  it("hashes Source identity, chunk plan, prompt versions and model into the key", async () => {
    const { source, chunks } = await createContext();
    const base = {
      sourceId: source.id,
      sourceContentHash: source.contentHash,
      chunk: chunks[0]!,
      promptVersions: STORY_MAP_PROMPT_VERSIONS,
      model: modelConfig.model,
      providerName: "mock",
    };
    const key = storyMapChunkCheckpointKey(base);

    expect(
      storyMapChunkCheckpointKey({
        ...base,
        sourceId: "source_other",
      }),
    ).not.toBe(key);
    expect(
      storyMapChunkCheckpointKey({
        ...base,
        sourceContentHash: "sha256:" + "0".repeat(64),
      }),
    ).not.toBe(key);
    expect(
      storyMapChunkCheckpointKey({
        ...base,
        chunk: {
          ...chunks[0]!,
          coreUnitIds: [...chunks[0]!.coreUnitIds, "evidence_unit:extra"],
        },
      }),
    ).not.toBe(key);
    expect(
      storyMapChunkCheckpointKey({
        ...base,
        promptVersions: {
          ...STORY_MAP_PROMPT_VERSIONS,
          extract: "story-map-chunk.v5",
        },
      }),
    ).not.toBe(key);
    expect(
      storyMapChunkCheckpointKey({
        ...base,
        model: "another-model",
      }),
    ).not.toBe(key);
  });

  it("records the producing generation run and reports run ids in chunk order", async () => {
    const { project, source, chunks, providerResponses } = await createContext();
    const runGroupId = "run_checkpoint_provenance";
    // 第 0 块最后完成，因此任何按完成顺序 push 的列表都会与分块顺序不同。
    const provider = new FixtureStageProvider(providerResponses, {
      holdFirstExtractUntilOthersComplete: true,
    });

    const result = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider,
      modelConfig,
      runGroupId,
    });

    expect(provider.completedExtractChunks).toHaveLength(chunks.length);
    expect(provider.completedExtractChunks.at(-1)).toBe(0);

    const checkpoints = latestCheckpointByChunkStage(
      listStoryMapChunkCheckpoints({ projectId: project.id, runGroupId }),
    );
    const runs = new Map(
      listProjectGenerationRuns(project.id).map((run) => [run.id, run]),
    );
    expect(result.generation.extractorRunIds).toHaveLength(chunks.length);
    expect(result.generation.gleaningRunIds).toHaveLength(chunks.length);

    chunks.forEach((chunk) => {
      const extraction = checkpoints.get(`${chunk.index}:extract`)!;
      const gleaning = checkpoints.get(`${chunk.index}:glean`)!;
      expect(extraction.generationRunId).toEqual(
        result.generation.extractorRunIds[chunk.index],
      );
      expect(gleaning.generationRunId).toEqual(
        result.generation.gleaningRunIds[chunk.index],
      );
      expect(runs.get(extraction.generationRunId!)?.kind).toBe(
        "story_map_extract",
      );
      expect(runs.get(gleaning.generationRunId!)?.kind).toBe("story_map_glean");
    });
  });

  it("resumes after a crash by reusing finished passes and only calling the provider for missing ones", async () => {
    const { project, source, chunks, providerResponses } =
      await createContext();
    const runGroupId = "run_resume_after_crash";
    const crashProvider = new FixtureStageProvider(providerResponses, {
      // 抽取阶段已完成；在第一个补抽调用时崩溃。
      crashAt: chunks.length + 1,
    });

    await expect(
      generateStoryMap({
        projectId: project.id,
        sourceId: source.id,
        provider: crashProvider,
        modelConfig,
        runGroupId,
      }),
    ).rejects.toThrow("模拟生成崩溃");

    const checkpoints = listStoryMapChunkCheckpoints({
      projectId: project.id,
      runGroupId,
    });
    expect(checkpoints.length).toBeGreaterThan(0);
    const savedExtractions = new Set(
      checkpoints
        .filter((checkpoint) => checkpoint.stage === "extract")
        .map((checkpoint) => checkpoint.chunkIndex),
    );
    const savedGleanings = new Set(
      checkpoints
        .filter((checkpoint) => checkpoint.stage === "glean")
        .map((checkpoint) => checkpoint.chunkIndex),
    );
    expect(savedExtractions.size).toBeGreaterThan(0);
    expect(
      savedGleanings.size < chunks.length ||
        savedExtractions.size < chunks.length,
    ).toBe(true);
    const checkpointsBeforeRetry = latestCheckpointByChunkStage(checkpoints);
    const originalExtractionRunIds = new Map(
      [...savedExtractions].map((chunkIndex) => [
        chunkIndex,
        checkpointsBeforeRetry.get(`${chunkIndex}:extract`)!.generationRunId,
      ]),
    );
    const originalGleaningRunIds = new Map(
      [...savedGleanings].map((chunkIndex) => [
        chunkIndex,
        checkpointsBeforeRetry.get(`${chunkIndex}:glean`)!.generationRunId,
      ]),
    );

    const retryProvider = new FixtureStageProvider(providerResponses);
    const resumed = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: retryProvider,
      modelConfig,
      runGroupId,
      previousModelCalls: crashProvider.requests.length,
    });

    const expectedCalls =
      chunks.length -
      savedExtractions.size +
      (chunks.length - savedGleanings.size) +
      3;
    expect(retryProvider.requests).toHaveLength(expectedCalls);
    for (const request of retryProvider.requests) {
      const stage = stageOf(request.prompt);
      if (stage === "extract") {
        expect(savedExtractions.has(chunkIndexOf(request.prompt))).toBe(false);
      }
      if (stage === "glean") {
        expect(savedGleanings.has(chunkIndexOf(request.prompt))).toBe(false);
      }
    }
    expect(resumed.generation.reusedChunks).toBe(
      chunks.filter(
        (chunk) =>
          savedExtractions.has(chunk.index) &&
          savedGleanings.has(chunk.index),
      ).length,
    );

    // 复用分块仍指向产生检查点的原始 Run；新跑分块指向本次 Run。
    const checkpointsAfterRetry = latestCheckpointByChunkStage(
      listStoryMapChunkCheckpoints({ projectId: project.id, runGroupId }),
    );
    expect(resumed.generation.extractorRunIds).toHaveLength(chunks.length);
    expect(resumed.generation.gleaningRunIds).toHaveLength(chunks.length);
    chunks.forEach((chunk) => {
      expect(resumed.generation.extractorRunIds[chunk.index]).toBe(
        checkpointsAfterRetry.get(`${chunk.index}:extract`)!.generationRunId,
      );
      expect(resumed.generation.gleaningRunIds[chunk.index]).toBe(
        checkpointsAfterRetry.get(`${chunk.index}:glean`)!.generationRunId,
      );
    });
    for (const [chunkIndex, runId] of originalExtractionRunIds) {
      expect(resumed.generation.extractorRunIds[chunkIndex]).toBe(runId);
    }
    for (const [chunkIndex, runId] of originalGleaningRunIds) {
      expect(resumed.generation.gleaningRunIds[chunkIndex]).toBe(runId);
    }

    const freshProvider = new FixtureStageProvider(providerResponses);
    const fresh = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: freshProvider,
      modelConfig,
      // fresh 启动总是新 run group：旧 group 的检查点一个都不会被读取。
      runGroupId: "run_fresh_baseline",
    });
    expect(freshProvider.requests).toHaveLength(2 * chunks.length + 3);
    expect(fresh.generation.reusedChunks).toBe(0);
    const freshCheckpoints = latestCheckpointByChunkStage(
      listStoryMapChunkCheckpoints({
        projectId: project.id,
        runGroupId: "run_fresh_baseline",
      }),
    );
    chunks.forEach((chunk) => {
      expect(fresh.generation.extractorRunIds[chunk.index]).toBe(
        freshCheckpoints.get(`${chunk.index}:extract`)!.generationRunId,
      );
      expect(fresh.generation.gleaningRunIds[chunk.index]).toBe(
        freshCheckpoints.get(`${chunk.index}:glean`)!.generationRunId,
      );
    });
    // 全新 run group 的每个分块都有真实来源，没有 null 占位。
    expect(fresh.generation.extractorRunIds).not.toContain(null);
    expect(fresh.generation.gleaningRunIds).not.toContain(null);
    expect(storyMapContent(resumed.artifact.storyMap)).toEqual(
      storyMapContent(fresh.artifact.storyMap),
    );
  });

  it("counts previous attempts against the pre-flight budget and fails closed", async () => {
    const { project, source, chunks, providerResponses } =
      await createContext();
    const runGroupId = "run_budget_preflight";
    const firstProvider = new FixtureStageProvider(providerResponses);
    const first = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: firstProvider,
      modelConfig,
      runGroupId,
    });
    expect(firstProvider.requests).toHaveLength(2 * chunks.length + 3);
    const usedCalls = firstProvider.requests.length;

    const retryProvider = new FixtureStageProvider(providerResponses);
    await expect(
      generateStoryMap({
        projectId: project.id,
        sourceId: source.id,
        provider: retryProvider,
        modelConfig,
        runGroupId,
        previousModelCalls: usedCalls,
        // 所有分块都能复用，剩余基础调用只有 names / endings / merge 3 次。
        limits: { maxModelCalls: usedCalls + 2 },
      }),
    ).rejects.toThrow(/STORY_MAP_MAX_MODEL_CALLS/);
    expect(retryProvider.requests).toHaveLength(0);
    expect(
      listStoryMapArtifactsForSource(project.id, source.id),
    ).toHaveLength(1);
    expect(first.artifact.version).toBe(1);
  });

  it("counts previous attempts in the running counter and stops before exceeding the cap", async () => {
    const { project, source, chunks, providerResponses } =
      await createContext();
    const runGroupId = "run_budget_running";
    const firstProvider = new FixtureStageProvider(providerResponses);
    await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: firstProvider,
      modelConfig,
      runGroupId,
    });
    const usedCalls = firstProvider.requests.length;
    const retryProvider = new FixtureStageProvider(providerResponses, {
      invalidNamesFirst: true,
    });

    await expect(
      generateStoryMap({
        projectId: project.id,
        sourceId: source.id,
        provider: retryProvider,
        modelConfig,
        runGroupId,
        previousModelCalls: usedCalls,
        // 3 次全局调用刚好用完剩余预算；names 的一次 repair 会让第 4 次越界。
        limits: { maxModelCalls: usedCalls + 3 },
      }),
    ).rejects.toThrow(/模型调用次数超过上限/);

    expect(retryProvider.requests).toHaveLength(3);
    expect(retryProvider.requests.map((request) => stageOf(request.prompt))).toEqual([
      "names",
      "names",
      "endings",
    ]);
    // 所有分块都来自检查点，第 2 个 Artifact 没有写成。
    expect(
      listStoryMapArtifactsForSource(project.id, source.id),
    ).toHaveLength(1);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("ignores checkpoints when the model key changes and appends rather than updates rows", async () => {
    const { project, source, chunks, providerResponses } =
      await createContext();
    const runGroupId = "run_key_mismatch";
    await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: new FixtureStageProvider(providerResponses),
      modelConfig,
      runGroupId,
    });

    const rowsBefore = getDatabase()
      .select()
      .from(storyMapChunkCheckpoints)
      .where(eq(storyMapChunkCheckpoints.runGroupId, runGroupId))
      .all();
    expect(rowsBefore).toHaveLength(2 * chunks.length);

    const changedModelProvider = new FixtureStageProvider(providerResponses);
    await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: changedModelProvider,
      modelConfig: { ...modelConfig, model: "mock-story-model-v2" },
      runGroupId,
    });
    // 模型身份变化 → 所有 key 不匹配 → 全部重跑，而不是复用旧检查点。
    expect(changedModelProvider.requests).toHaveLength(2 * chunks.length + 3);

    const rowsAfter = getDatabase()
      .select()
      .from(storyMapChunkCheckpoints)
      .where(eq(storyMapChunkCheckpoints.runGroupId, runGroupId))
      .all();
    expect(rowsAfter).toHaveLength(4 * chunks.length);
    for (const before of rowsBefore) {
      expect(rowsAfter).toContainEqual(before);
    }
  });

  it("keeps one run-id slot per chunk and uses null for a legacy middle chunk", async () => {
    const { project, source, chunks, providerResponses } =
      await createThreeChunkContext();
    expect(chunks).toHaveLength(3);
    const runGroupId = "run_three_chunk_legacy_gap";
    const first = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: new FixtureStageProvider(providerResponses),
      modelConfig,
      runGroupId,
    });
    expect(first.generation.extractorRunIds).toHaveLength(chunks.length);
    expect(first.generation.gleaningRunIds).toHaveLength(chunks.length);
    expect(first.generation.extractorRunIds).not.toContain(null);
    expect(first.generation.gleaningRunIds).not.toContain(null);
    const originalExtractorRunIds = [...first.generation.extractorRunIds];
    const originalGleaningRunIds = [...first.generation.gleaningRunIds];

    // 只把中间分块的来源清空，模拟迁移前写入、没有 generation_run_id 的行。
    const legacyIndex = 1;
    getDatabase()
      .update(storyMapChunkCheckpoints)
      .set({ generationRunId: null })
      .where(
        and(
          eq(storyMapChunkCheckpoints.runGroupId, runGroupId),
          eq(storyMapChunkCheckpoints.chunkIndex, legacyIndex),
        ),
      )
      .run();

    const resumed = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: new FixtureStageProvider(providerResponses),
      modelConfig,
      runGroupId,
    });

    expect(resumed.generation.reusedChunks).toBe(chunks.length);
    expect(resumed.generation.extractorRunIds).toEqual([
      originalExtractorRunIds[0],
      null,
      originalExtractorRunIds[2],
    ]);
    expect(resumed.generation.gleaningRunIds).toEqual([
      originalGleaningRunIds[0],
      null,
      originalGleaningRunIds[2],
    ]);
    expect(resumed.generation.extractorRunIds).toHaveLength(chunks.length);
    expect(resumed.generation.gleaningRunIds).toHaveLength(chunks.length);
  });

  it("reuses pre-provenance checkpoints without inventing run ids", async () => {
    const { project, source, chunks, providerResponses } =
      await createContext();
    const runGroupId = "run_legacy_checkpoints";
    await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: new FixtureStageProvider(providerResponses),
      modelConfig,
      runGroupId,
    });

    // 模拟 0009 迁移前写入的行：内容与 key 都可复用，但不知道原始 Run。
    getDatabase()
      .update(storyMapChunkCheckpoints)
      .set({ generationRunId: null })
      .where(eq(storyMapChunkCheckpoints.runGroupId, runGroupId))
      .run();

    const resumed = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: new FixtureStageProvider(providerResponses),
      modelConfig,
      runGroupId,
    });
    expect(resumed.generation.reusedChunks).toBe(chunks.length);
    // 旧检查点来源未知，但列表仍按分块顺序保留 null 占位。
    expect(resumed.generation.extractorRunIds).toEqual(
      chunks.map(() => null),
    );
    expect(resumed.generation.gleaningRunIds).toEqual(
      chunks.map(() => null),
    );
  });
});
