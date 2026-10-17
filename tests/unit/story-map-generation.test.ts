import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { validateStoryMap } from "@/domain/invariants/validate-story-map";
import { deriveEvidenceUnitChunks } from "@/domain/source/evidence-unit-chunks";
import { deriveEvidenceUnits } from "@/domain/source/evidence-units";
import { CHARACTER_ENDING_PREFIX } from "@/domain/story-map/assemble-story-map-candidate";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { listProjectGenerationRuns } from "@/server/repositories/generation-run-repository";
import {
  createProject,
  getProjectSource,
  importProjectSource,
} from "@/server/repositories/project-repository";
import { listStoryMapArtifactsForSource } from "@/server/repositories/story-map-artifact-repository";
import { buildFixtureStoryMapResponses } from "@/server/story-map/fixture-story-map-responses";
import {
  STORY_MAP_PROMPT_VERSIONS,
  generateStoryMap,
  mapWithConcurrency,
} from "@/server/story-map/generate-story-map";
import {
  DEFAULT_STORY_MAP_MAX_CHUNKS,
  DEFAULT_STORY_MAP_MAX_MODEL_CALLS,
  resolveStoryMapLimits,
} from "@/server/story-map/story-map-limits";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-story-map-generation-"),
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

async function createContext() {
  const fixture = await loadRippleFixture();
  const project = createProject({ title: "Story Map generation" });
  const imported = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: new TextEncoder().encode(fixture.source.originalText),
  });
  const source = imported.source;
  const units = deriveEvidenceUnits(source);
  const chunks = deriveEvidenceUnitChunks(units);
  const responses = buildFixtureStoryMapResponses(source, fixture.storyMap);
  return { fixture, project, source, units, chunks, responses };
}

async function createSyntheticContext(text: string) {
  const project = createProject({ title: "Story Map synthetic" });
  const imported = importProjectSource({
    projectId: project.id,
    fileName: "synthetic.md",
    bytes: new TextEncoder().encode(text),
  });
  const source = imported.source;
  const units = deriveEvidenceUnits(source);
  return { project, source, units, chunks: deriveEvidenceUnitChunks(units) };
}

/** 响应在队列中的位置：每块 extract → 每块 glean → names → endings → merge。 */
function stageIndex(chunkCount: number) {
  return {
    extract: (chunk: number) => chunk,
    glean: (chunk: number) => chunkCount + chunk,
    names: 2 * chunkCount,
    endings: 2 * chunkCount + 1,
    merge: 2 * chunkCount + 2,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function edit(responses: string[], index: number, change: (value: any) => void): string[] {
  const copy = [...responses];
  const value = JSON.parse(copy[index]!);
  change(value);
  copy[index] = JSON.stringify(value);
  return copy;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const modelConfig = {
  model: "mock-story-model",
  structuredOutputMode: "json_schema" as const,
};

describe("chunked Story Map recall pipeline", () => {
  it("runs the explicit deterministic Mock configuration without a real model", async () => {
    const { project, source, chunks } = await createContext();
    const previousProvider = process.env.AI_PROVIDER_NAME;
    const previousModel = process.env.OPENAI_MODEL;
    const previousMode = process.env.OPENAI_STRUCTURED_OUTPUT_MODE;
    process.env.AI_PROVIDER_NAME = "mock";
    process.env.OPENAI_MODEL = "mock-story-model";
    process.env.OPENAI_STRUCTURED_OUTPUT_MODE = "json_schema";

    try {
      const result = await generateConfiguredStoryMap({
        projectId: project.id,
        sourceId: source.id,
      });

      expect(result.artifact).toMatchObject({
        projectId: project.id,
        sourceId: source.id,
        schemaVersion: 2,
        review: { evidenceConfirmations: [] },
        storyMap: { status: "draft" },
      });
      expect(chunks.length).toBeGreaterThan(1);
      expect(
        listProjectGenerationRuns(project.id).map((run) => run.provider),
      ).toEqual(Array(2 * chunks.length + 3).fill("mock"));
    } finally {
      restoreEnvironment("AI_PROVIDER_NAME", previousProvider);
      restoreEnvironment("OPENAI_MODEL", previousModel);
      restoreEnvironment("OPENAI_STRUCTURED_OUTPUT_MODE", previousMode);
    }
  });

  it("creates a valid ripple-001 draft Artifact through every stage with traceable runs", async () => {
    const { fixture, project, source, chunks, responses } = await createContext();
    const sourceBefore = structuredClone(source);
    const provider = new MockAIProvider(responses);

    const result = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider,
      modelConfig,
    });

    expect(result.artifact).toMatchObject({
      projectId: project.id,
      sourceId: source.id,
      version: 1,
      kind: "story_map",
      generationRunId: result.generation.reconcilerRunId,
      storyMap: { sourceId: source.id, version: 1, status: "draft" },
    });
    const storyMap = result.artifact.storyMap;
    expect(storyMap.events.map((event) => [event.id, event.sequence])).toEqual(
      fixture.storyMap.events.map((event) => [event.id, event.sequence]),
    );
    expect(storyMap.characters.map((character) => character.id).sort()).toEqual(
      fixture.storyMap.characters.map((character) => character.id).sort(),
    );
    expect(storyMap.edges).toHaveLength(fixture.storyMap.edges.length);
    expect(storyMap.endingCandidates).toHaveLength(4);
    expect(validateStoryMap(storyMap, source)).toEqual([]);
    expect(getProjectSource(project.id, source.id)).toEqual(sourceBefore);

    expect(provider.requests).toHaveLength(2 * chunks.length + 3);
    const [firstChunk, secondChunk] = provider.requests;
    expect(firstChunk?.prompt).toContain("<story_chunk");
    expect(firstChunk?.prompt).toContain(`evidence_unit:${source.id}:`);
    expect(firstChunk?.prompt).toContain("不得返回 `exactQuote`");
    expect(firstChunk?.prompt).toContain("<name_hints>");
    expect(firstChunk?.prompt).not.toContain(chunks[1]!.coreUnitIds.at(-1));
    expect(secondChunk?.prompt).toContain('"ownership":"context"');
    const stage = stageIndex(chunks.length);
    expect(provider.requests[stage.glean(0)]?.prompt).toContain("<previous_extraction>");
    expect(provider.requests[stage.names]?.prompt).toContain("<character_candidates>");
    expect(provider.requests[stage.names]?.prompt).not.toContain("<story_chunk");
    expect(provider.requests[stage.endings]?.prompt).toContain("<story_ending_text");
    expect(provider.requests[stage.merge]?.prompt).toContain("duplicateEventGroups");

    const runs = listProjectGenerationRuns(project.id);
    const describeRun = (run: { kind: string; promptVersion: string; status: string }) =>
      [run.kind, run.promptVersion, run.status].join("|");
    expect(runs.map(describeRun).sort()).toEqual([
      ...chunks.map(() => ["story_map_extract", STORY_MAP_PROMPT_VERSIONS.extract, "succeeded"]),
      ...chunks.map(() => ["story_map_glean", STORY_MAP_PROMPT_VERSIONS.glean, "succeeded"]),
      ["story_map_names", STORY_MAP_PROMPT_VERSIONS.names, "succeeded"],
      ["story_map_endings", STORY_MAP_PROMPT_VERSIONS.endings, "succeeded"],
      ["story_map_reconcile", STORY_MAP_PROMPT_VERSIONS.merge, "succeeded"],
    ].map((parts) => parts.join("|")).sort());
  });

  it("keeps what gleaning, the names pass, the endings pass and the merge add", async () => {
    const { project, source, chunks, responses } = await createContext();
    const stage = stageIndex(chunks.length);
    const lastUnit = chunks.at(-1)!.coreUnitIds.at(-1)!;
    const secondChunkUnit = chunks[1]!.coreUnitIds[3]!;
    let edited = edit(responses, stage.glean(1), (gleaning) => {
      gleaning.characters.push({
        id: "char_harbor_clerk",
        name: "港务书记员",
        aliases: [],
        role: "supporting",
        initialState: "在港务处值班",
      });
      gleaning.events.push(
        {
          id: "event_clerk_note",
          title: "书记员记下时间",
          summary: "书记员记下钟楼停摆的时间",
          sequence: 1,
          participants: ["char_harbor_clerk", "char_shenyan"],
          stateChanges: [],
          evidenceKind: "fact",
          evidenceUnitIds: [secondChunkUnit],
        },
        {
          id: "event_12_again",
          title: "结尾重述",
          summary: "同一结尾在另一片段被再次描述",
          sequence: 1,
          participants: ["char_xucheng"],
          stateChanges: ["重述"],
          evidenceKind: "fact",
          evidenceUnitIds: [lastUnit],
        },
      );
    });
    // 名单：把书记员候选并入一个新的正式 ID，并给沈砚加别名。
    edited = edit(edited, stage.names, (roster) => {
      roster.characters.push({
        id: "char_clerk",
        name: "港务书记员",
        aliases: ["书记员"],
        role: "supporting",
        initialState: "在港务处值班",
        mergedFrom: ["char_harbor_clerk"],
      });
      const shen = roster.characters.find((c: { id: string }) => c.id === "char_shenyan");
      shen.aliases = [...new Set([...shen.aliases, "沈老"])];
    });
    edited = edit(edited, stage.endings, (pass) => {
      pass.characterEndings.push({
        id: "ending_fate_clerk",
        characterId: "char_clerk",
        targetEventId: "event_clerk_note",
        fate: "继续在港务处值班",
        evidenceUnitIds: [secondChunkUnit],
      });
    });
    edited = edit(edited, stage.merge, (merge) => {
      merge.duplicateEventGroups.push({ keepEventId: "event_12", duplicateEventIds: ["event_12_again"] });
    });

    const result = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: new MockAIProvider(edited),
      modelConfig,
    });
    const storyMap = result.artifact.storyMap;

    expect(storyMap.characters.map((c) => c.id)).toContain("char_clerk");
    expect(storyMap.characters.find((c) => c.id === "char_shenyan")?.aliases).toContain("沈老");
    const clerkEvent = storyMap.events.find((event) => event.id === "event_clerk_note");
    expect(clerkEvent?.participants).toEqual(["char_clerk", "char_shenyan"]);
    expect(storyMap.events.map((event) => event.id)).not.toContain("event_12_again");
    const ending = storyMap.events.find((event) => event.id === "event_12")!;
    expect(ending.stateChanges).toContain("重述");
    expect(storyMap.endingCandidates).toContainEqual(
      expect.objectContaining({
        id: "ending_fate_clerk",
        requirement: `${CHARACTER_ENDING_PREFIX}港务书记员：继续在港务处值班`,
      }),
    );
    expect(storyMap.events.map((event) => event.sequence)).toEqual(
      storyMap.events.map((_, index) => index + 1),
    );
    expect(validateStoryMap(storyMap, source)).toEqual([]);
  });

  it("repairs a chunk that cites a paragraph outside the chunk, then fails closed if the repair is still invalid", async () => {
    const { project, source, chunks, responses } = await createContext();
    const outside = chunks[1]!.coreUnitIds.at(-1)!;
    const invalid = edit(responses, 0, (extraction) => {
      extraction.events[0].evidenceUnitIds = [outside];
    })[0]!;
    const provider = new MockAIProvider([invalid, invalid, ...responses.slice(1)]);

    await expect(
      generateStoryMap({ projectId: project.id, sourceId: source.id, provider, modelConfig }),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests[0]?.repair).toBeUndefined();
    const repaired = provider.requests.find((request) => request.repair);
    expect(repaired?.repair?.validationIssues).toEqual(
      expect.arrayContaining([expect.stringContaining("本阶段未提供的 Unit")]),
    );
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([]);
    expect(listProjectGenerationRuns(project.id).map((run) => run.kind)).not.toContain(
      "story_map_reconcile",
    );
  });

  it("repairs a names pass that drops a character candidate", async () => {
    const { project, source, chunks, responses } = await createContext();
    const stage = stageIndex(chunks.length);
    const invalid = edit(responses, stage.names, (roster) => {
      roster.characters[0].mergedFrom = ["char_unknown"];
    })[stage.names]!;
    const queue = [...responses];
    queue.splice(stage.names, 0, invalid);
    const provider = new MockAIProvider(queue);

    const result = await generateStoryMap({ projectId: project.id, sourceId: source.id, provider, modelConfig });

    expect(provider.requests[stage.names + 1]?.repair?.validationIssues).toEqual(
      expect.arrayContaining([expect.stringContaining("没有归入任何人物")]),
    );
    expect(result.artifact.storyMap.characters).toHaveLength(5);
  });

  it("repairs one invalid merge and fails closed after a second invalid merge", async () => {
    const { project, source, chunks, responses } = await createContext();
    const stage = stageIndex(chunks.length);
    const dangling = edit(responses, stage.merge, (merge) => {
      merge.edges[0].to = "event_missing";
    })[stage.merge]!;

    const repairedProvider = new MockAIProvider([...responses.slice(0, stage.merge), dangling, responses[stage.merge]!]);
    const repaired = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: repairedProvider,
      modelConfig,
    });
    expect(repairedProvider.requests.at(-1)?.repair?.validationIssues).toEqual(
      expect.arrayContaining([expect.stringContaining("悬空引用")]),
    );
    expect(repaired.artifact.storyMap.sourceId).toBe(source.id);

    const failingProvider = new MockAIProvider([...responses.slice(0, stage.merge), dangling, dangling]);
    const before = listStoryMapArtifactsForSource(project.id, source.id).length;
    await expect(
      generateStoryMap({ projectId: project.id, sourceId: source.id, provider: failingProvider, modelConfig }),
    ).rejects.toThrow("Structured generation failed schema validation");
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toHaveLength(before);
  });

  it("stops scheduling new chunk tasks and aborts in-flight work after the first failure", async () => {
    const started: number[] = [];
    const signals: AbortSignal[] = [];
    const failure = new Error("chunk failed");

    await expect(
      mapWithConcurrency(Array.from({ length: 10 }, (_, index) => index), 3, async (item, index, signal) => {
        void index;
        started.push(item);
        signals.push(signal);
        if (item === 0) throw failure;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }),
    ).rejects.toBe(failure);

    expect(started).toEqual([0, 1, 2]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);
  });

  it("fails before any model call when the chunk or call budget is exceeded", async () => {
    const { project, source, chunks } = await createContext();
    const chunkProvider = new MockAIProvider([]);

    await expect(
      generateStoryMap({
        projectId: project.id,
        sourceId: source.id,
        provider: chunkProvider,
        modelConfig,
        limits: { maxChunks: chunks.length - 1 },
      }),
    ).rejects.toThrow(/STORY_MAP_MAX_CHUNKS/);
    expect(chunkProvider.requests).toHaveLength(0);

    const callProvider = new MockAIProvider([]);
    await expect(
      generateStoryMap({
        projectId: project.id,
        sourceId: source.id,
        provider: callProvider,
        modelConfig,
        limits: { maxModelCalls: 2 * chunks.length + 2 },
      }),
    ).rejects.toThrow(/STORY_MAP_MAX_MODEL_CALLS/);
    expect(callProvider.requests).toHaveLength(0);
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([]);
  });

  it("counts repairs against the model-call budget and fails before exceeding it", async () => {
    const { project, source, chunks, responses } = await createContext();
    const stage = stageIndex(chunks.length);
    const baseCalls = 2 * chunks.length + 3;
    const invalidNames = edit(responses, stage.names, (roster) => {
      roster.characters[0].mergedFrom = ["char_unknown"];
    })[stage.names]!;
    const queue = [...responses];
    queue.splice(stage.names, 0, invalidNames);
    const provider = new MockAIProvider(queue);

    await expect(
      generateStoryMap({
        projectId: project.id,
        sourceId: source.id,
        provider,
        modelConfig,
        limits: { maxModelCalls: baseCalls },
      }),
    ).rejects.toThrow(/模型调用次数超过上限/);

    expect(provider.requests).toHaveLength(baseCalls);
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([]);
  });

  it("warns once before model calls when the chunk count reaches 20", async () => {
    const paragraph = "林舟走进港城，看见远处的灯塔。".repeat(400);
    const text = Array.from({ length: 20 }, (_, index) => `第${index + 1}段。${paragraph}`).join("\n\n");
    const { project, source, chunks } = await createSyntheticContext(text);
    expect(chunks).toHaveLength(20);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const provider = new MockAIProvider(
        Array.from({ length: 4 }, () => new Error("stop after warning")),
      );
      await expect(
        generateStoryMap({ projectId: project.id, sourceId: source.id, provider, modelConfig }),
      ).rejects.toThrow("stop after warning");

      expect(warning).toHaveBeenCalledTimes(1);
      const line = String(warning.mock.calls[0]![0]);
      expect(line).toContain("分块数 20");
      expect(line).toContain("最坏");
      expect(line).toContain("tokens");
      expect(line).toContain("粗略");
      expect(line).not.toContain("远处的灯塔");
    } finally {
      warning.mockRestore();
    }
  });

  it("reads positive-integer call limits from the environment", () => {
    const previousCalls = process.env.STORY_MAP_MAX_MODEL_CALLS;
    const previousChunks = process.env.STORY_MAP_MAX_CHUNKS;
    try {
      delete process.env.STORY_MAP_MAX_MODEL_CALLS;
      delete process.env.STORY_MAP_MAX_CHUNKS;
      expect(resolveStoryMapLimits()).toEqual({
        maxChunks: DEFAULT_STORY_MAP_MAX_CHUNKS,
        maxModelCalls: DEFAULT_STORY_MAP_MAX_MODEL_CALLS,
      });

      process.env.STORY_MAP_MAX_MODEL_CALLS = "77";
      process.env.STORY_MAP_MAX_CHUNKS = "9";
      expect(resolveStoryMapLimits()).toEqual({ maxChunks: 9, maxModelCalls: 77 });

      process.env.STORY_MAP_MAX_MODEL_CALLS = "0";
      expect(() => resolveStoryMapLimits()).toThrow(
        "STORY_MAP_MAX_MODEL_CALLS 必须是正整数",
      );
    } finally {
      restoreEnvironment("STORY_MAP_MAX_MODEL_CALLS", previousCalls);
      restoreEnvironment("STORY_MAP_MAX_CHUNKS", previousChunks);
    }
  });

  it("creates a new versioned Artifact when the same Source is rerun", async () => {
    const { project, source, responses } = await createContext();
    const provider = new MockAIProvider([...responses, ...responses]);

    const first = await generateStoryMap({ projectId: project.id, sourceId: source.id, provider, modelConfig });
    const second = await generateStoryMap({ projectId: project.id, sourceId: source.id, provider, modelConfig });

    expect(first.artifact.version).toBe(1);
    expect(second.artifact).toMatchObject({
      version: 2,
      kind: "story_map_revision",
      basedOnArtifactId: first.artifact.id,
    });
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toHaveLength(2);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
