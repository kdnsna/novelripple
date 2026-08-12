import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RippleSuggestionsModelOutput } from "@/domain/schemas";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { listProjectGenerationRuns } from "@/server/repositories/generation-run-repository";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import {
  listProjectWorldlines,
} from "@/server/repositories/ripple-repository";
import {
  listRippleSuggestionsArtifactsForStoryMap,
} from "@/server/repositories/ripple-suggestions-repository";
import { generateRippleSuggestions } from "@/server/ripple/generate-ripple-suggestions";
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
    ).toMatchObject({ status: "succeeded", promptVersion: "ripple-suggestions.v3" });
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
});
