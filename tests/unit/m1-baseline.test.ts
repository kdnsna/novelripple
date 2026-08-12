import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  InstrumentedAIProvider,
  M1BaselineStoryReportSchema,
  assertM1BaselineSuite,
  countBenchmarkCharacters,
  scoreM1StoryMapCandidate,
  summarizeProviderObservations,
  summarizeStoryMapValidation,
  validateM1BenchmarkManifest,
  type ProviderObservation,
} from "@/evals/m1-baseline";
import type { AIProvider } from "@/server/ai/types";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

const manifestSchema = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "benchmarks", "m1", "manifest.schema.json"),
    "utf8",
  ),
) as unknown;

function createManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "m1-test-a",
    title: "仅用于测试的合成标题",
    rights: {
      category: "original",
      basis: "单元测试合成数据",
      redistributionAllowed: false,
    },
    visibility: "private",
    sourcePath: "source.txt",
    language: "zh-CN",
    characterCount: 10_000,
    storyClass: "A",
    unseenByPromptAuthors: false,
    expectedCoreCharacters: [
      { id: "character_a", name: "甲", aliases: [] },
      { id: "character_b", name: "乙", aliases: [] },
      { id: "character_c", name: "丙", aliases: [] },
      { id: "character_d", name: "丁", aliases: [] },
    ],
    expectedSupportingCharacters: [],
    expectedKeyEvents: [
      { id: "key_event_a", label: "测试事件甲" },
      { id: "key_event_b", label: "测试事件乙" },
    ],
    expectedEndingCandidates: [
      { id: "ending_a", label: "测试终局", interpretive: false },
    ],
    testDivergences: [
      {
        id: "divergence_strict",
        eventId: "key_event_a",
        type: "prevent",
        mode: "strict",
        instruction: "测试严格分叉",
        anchorIds: ["ending_a"],
        expectedAnchorStatus: "rerouted",
      },
      {
        id: "divergence_open",
        eventId: "key_event_b",
        type: "choice",
        mode: "open",
        instruction: "测试开放分叉",
        anchorIds: [],
        expectedAnchorStatus: null,
      },
    ],
    ...overrides,
  };
}

function succeededCall(
  schemaName: string,
  attempt: "initial" | "repair",
): ProviderObservation {
  return {
    schemaName,
    attempt,
    status: "succeeded",
    durationMs: 1,
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    failureCode: null,
  };
}

function failedCall(
  schemaName: string,
  attempt: "initial" | "repair",
): ProviderObservation {
  return {
    schemaName,
    attempt,
    status: "failed",
    durationMs: 1,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    failureCode: "provider_error",
  };
}

describe("M1 baseline contract", () => {
  it("uses normalized non-whitespace Unicode code points for characterCount", () => {
    expect(countBenchmarkCharacters("甲\r\n 乙\t😀")).toBe(3);
  });

  it("validates the existing manifest schema and M1 cross references", () => {
    const manifest = validateM1BenchmarkManifest({
      value: createManifest(),
      jsonSchema: manifestSchema,
      actualCharacterCount: 10_000,
    });

    expect(manifest.id).toBe("m1-test-a");
    expect(manifest.testDivergences.map((item) => item.mode)).toEqual([
      "strict",
      "open",
    ]);
  });

  it("rejects a dangling divergence before any model call", () => {
    const invalid = createManifest({
      testDivergences: [
        {
          id: "divergence_strict",
          eventId: "missing_event",
          type: "prevent",
          mode: "strict",
          instruction: "测试严格分叉",
          anchorIds: ["ending_a"],
          expectedAnchorStatus: "rerouted",
        },
        {
          id: "divergence_open",
          eventId: "key_event_b",
          type: "choice",
          mode: "open",
          instruction: "测试开放分叉",
          anchorIds: [],
          expectedAnchorStatus: null,
        },
      ],
    });

    expect(() =>
      validateM1BenchmarkManifest({
        value: invalid,
        jsonSchema: manifestSchema,
        actualCharacterCount: 10_000,
      }),
    ).toThrow(/missing_event/);
  });

  it("scores only after generation and exposes ID-only manual queues", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const manifest = validateM1BenchmarkManifest({
      value: createManifest({
        characterCount: 10_000,
        expectedCoreCharacters: storyMap.characters.slice(0, 4).map((item) => ({
          id: `gold_${item.id}`,
          name: item.name,
          aliases: item.aliases,
        })),
        expectedKeyEvents: storyMap.events.slice(0, 2).map((item) => ({
          id: `gold_${item.id}`,
          label: item.title,
        })),
        expectedEndingCandidates: storyMap.endingCandidates.map((item) => ({
          id: `gold_${item.id}`,
          label: item.requirement,
          interpretive: false,
        })),
        testDivergences: [
          {
            id: "divergence_strict",
            eventId: `gold_${storyMap.events[0]!.id}`,
            type: "prevent",
            mode: "strict",
            instruction: "测试严格分叉",
            anchorIds: [`gold_${storyMap.endingCandidates[0]!.id}`],
            expectedAnchorStatus: "rerouted",
          },
          {
            id: "divergence_open",
            eventId: `gold_${storyMap.events[1]!.id}`,
            type: "choice",
            mode: "open",
            instruction: "测试开放分叉",
            anchorIds: [],
            expectedAnchorStatus: null,
          },
        ],
      }),
      jsonSchema: manifestSchema,
      actualCharacterCount: 10_000,
    });

    const score = scoreM1StoryMapCandidate({ manifest, source, storyMap });

    expect(score.coreCharacterRecall.rate).toBe(1);
    expect(score.evidenceValidity.rate).toBe(1);
    expect(score.events).toEqual({
      expectedTotal: 2,
      candidateTotal: storyMap.events.length,
      matched: null,
      recall: null,
      manualReviewQueue: {
        expectedIds: manifest.expectedKeyEvents.map((item) => item.id),
        candidateIds: storyMap.events.map((item) => item.id),
      },
    });
    expect(JSON.stringify(score)).not.toContain(storyMap.events[0]!.summary);
  });

  it("observes usage, duration and repair without retaining prompts or output", async () => {
    const provider: AIProvider = {
      providerName: "test-provider",
      async generate() {
        return {
          rawOutput: '{"safe":true}',
          usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        };
      },
    };
    const observed = new InstrumentedAIProvider(provider);

    await observed.generate({
      prompt: "private source sentinel",
      schemaName: "story_map_extraction",
      jsonSchema: { type: "object" },
      modelConfig: { model: "test-model", structuredOutputMode: "json_schema" },
      repair: {
        previousRawOutput: "private model output sentinel",
        validationIssues: ["invalid"],
      },
    });

    expect(observed.observations).toEqual([
      expect.objectContaining({
        schemaName: "story_map_extraction",
        attempt: "repair",
        status: "succeeded",
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      }),
    ]);
    const serialized = JSON.stringify(observed.observations);
    expect(serialized).not.toContain("private source sentinel");
    expect(serialized).not.toContain("private model output sentinel");
    expect(summarizeProviderObservations(observed.observations)).toEqual({
      callCount: 1,
      repairCount: 1,
      failedCallCount: 0,
      wallClockDurationMs: expect.any(Number),
      usageComplete: true,
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    });
  });

  it("summarizes first-pass and repair validation without raw model data", () => {
    const evidenceValidity = { matched: 9, total: 9, rate: 1 };

    expect(
      summarizeStoryMapValidation({
        calls: [
          succeededCall("story_map_extraction", "initial"),
          succeededCall("story_map_content", "initial"),
          succeededCall("story_map_content", "repair"),
        ],
        runs: [
          { kind: "story_map_extract", status: "succeeded" },
          { kind: "story_map_reconcile", status: "succeeded" },
        ],
        evidenceValidity,
        storyMapArtifactCreated: true,
      }),
    ).toEqual({
      extractor: { firstPassValidation: "passed", repair: "not_needed" },
      reconciler: { firstPassValidation: "failed", repair: "succeeded" },
      evidenceValidity,
      storyMapArtifactCreated: true,
    });

    expect(
      summarizeStoryMapValidation({
        calls: [failedCall("story_map_extraction", "initial")],
        runs: [{ kind: "story_map_extract", status: "failed" }],
        evidenceValidity: null,
        storyMapArtifactCreated: false,
      }),
    ).toMatchObject({
      extractor: {
        firstPassValidation: "not_observed",
        repair: "not_run",
      },
      reconciler: { firstPassValidation: "not_run", repair: "not_run" },
    });

    expect(
      summarizeStoryMapValidation({
        calls: [
          succeededCall("story_map_extraction", "initial"),
          succeededCall("story_map_extraction", "repair"),
        ],
        runs: [{ kind: "story_map_extract", status: "failed" }],
        evidenceValidity: null,
        storyMapArtifactCreated: false,
      }),
    ).toMatchObject({
      extractor: { firstPassValidation: "failed", repair: "failed" },
      reconciler: { firstPassValidation: "not_run", repair: "not_run" },
    });
  });

  it("accepts json_object compatibility reports and serializes no story data", () => {
    const sensitiveValues = [
      "private prompt sentinel",
      "private raw output sentinel",
      "private source sentinel",
      "private title sentinel",
      "private character sentinel",
    ];
    const story = M1BaselineStoryReportSchema.parse({
      storyId: "m1-private-a",
      storyClass: "A",
      visibility: "private",
      unseenByPromptAuthors: true,
      characterCount: 10_000,
      status: "failed",
      provider: "openai-compatible",
      model: "provider-model",
      structuredOutputMode: "json_object",
      promptVersions: [
        { kind: "story_map_extract", version: "story-map.v2" },
      ],
      wallClockDurationMs: 10,
      calls: [failedCall("story_map_extraction", "initial")],
      generation: {
        callCount: 1,
        repairCount: 0,
        failedCallCount: 1,
        wallClockDurationMs: 1,
        usageComplete: false,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
      compatibility: summarizeStoryMapValidation({
        calls: [failedCall("story_map_extraction", "initial")],
        runs: [{ kind: "story_map_extract", status: "failed" }],
        evidenceValidity: null,
        storyMapArtifactCreated: false,
      }),
      reviewTarget: null,
      storyMap: null,
      modelFailures: [{ stage: "story_map", code: "provider_error" }],
    });

    const serialized = JSON.stringify(story);
    for (const value of sensitiveValues) {
      expect(serialized).not.toContain(value);
    }
  });

  it("classifies timeout and context failures without retaining provider messages", async () => {
    const contextError = Object.assign(new Error("private provider message"), {
      code: "context_length_exceeded",
    });
    const timeoutError = Object.assign(new Error("private timeout message"), {
      name: "APIConnectionTimeoutError",
    });
    const failures = [contextError, timeoutError];
    const provider: AIProvider = {
      providerName: "test-provider",
      async generate() {
        throw failures.shift();
      },
    };
    const observed = new InstrumentedAIProvider(provider);
    const request = {
      prompt: "private source sentinel",
      schemaName: "story_map_extraction",
      jsonSchema: { type: "object" },
      modelConfig: { model: "test-model", structuredOutputMode: "json_schema" as const },
    };

    await expect(observed.generate(request)).rejects.toThrow();
    await expect(observed.generate(request)).rejects.toThrow();

    expect(observed.observations.map((item) => item.failureCode)).toEqual([
      "context_window",
      "timeout",
    ]);
    expect(JSON.stringify(observed.observations)).not.toContain("private");
  });

  it("requires one frozen A/B/C manifest and at least one unseen work", () => {
    const storyA = validateM1BenchmarkManifest({
      value: createManifest(),
      jsonSchema: manifestSchema,
      actualCharacterCount: 10_000,
    });

    expect(() => assertM1BaselineSuite([storyA])).toThrow(/三篇/);

    const storyB = {
      ...storyA,
      id: "m1-test-b",
      storyClass: "B" as const,
      characterCount: 25_000,
      expectedCoreCharacters: Array.from({ length: 8 }, (_, index) => ({
        id: `character_b_${index}`,
        name: `人物${index}`,
        aliases: [],
      })),
    };
    const storyC = {
      ...storyA,
      id: "m1-test-c",
      storyClass: "C" as const,
      characterCount: 15_000,
      unseenByPromptAuthors: true,
    };

    expect(() => assertM1BaselineSuite([storyA, storyB, storyC])).not.toThrow();
    expect(() =>
      assertM1BaselineSuite([
        storyA,
        storyB,
        { ...storyC, unseenByPromptAuthors: false },
      ]),
    ).toThrow(/unseen/);
  });

  it("keeps the explicit M1 baseline command out of default CI", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const workflow = readFileSync(
      path.join(process.cwd(), ".github", "workflows", "m0.yml"),
      "utf8",
    );

    expect(packageJson.scripts?.["eval:m1:baseline"]).toBe(
      "node --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx scripts/eval-m1-baseline.ts",
    );
    expect(workflow).not.toContain("eval:m1:baseline");
  });

  it("keeps every required human correction counter and A-K diagnosis explicit", () => {
    const template = readFileSync(
      path.join(process.cwd(), "docs", "evals", "m1-review-template.md"),
      "utf8",
    );
    for (const required of [
      "update_event 次数",
      "Character correction 次数",
      "merge / split 需求次数",
      "删除 Event 数",
      "新增遗漏 Event 数",
      "Edge correction 数",
      "Evidence correction 数",
      "Ending Candidate correction 数",
      "是否必须打开 Source / 数据库 / Prompt",
      "A. extraction coverage",
      "K. provider/schema compatibility",
    ]) {
      expect(template).toContain(required);
    }
  });

  it("fails safely before provider setup when fewer than three manifests are supplied", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/eval-m1-baseline.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("at_least_three_manifests_required");
    expect(result.stderr).not.toContain("ReferenceError");
    expect(result.stderr).not.toContain("private source");
  });
});
