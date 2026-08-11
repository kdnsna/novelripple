import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateStoryMap } from "@/domain/invariants/validate-story-map";
import type {
  Source,
  SourceReference,
  StoryMap,
  StoryMapContentCandidate,
  StoryMapExtractionCandidate,
} from "@/domain/schemas";
import {
  StoryMapContentCandidateSchema,
  StoryMapExtractionCandidateSchema,
} from "@/domain/schemas";
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
import { generateStoryMap } from "@/server/story-map/generate-story-map";
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

function toClaim(reference: SourceReference, source: Source) {
  return {
    sectionId: reference.sectionId,
    exactQuote: source.normalizedText.slice(reference.start, reference.end),
  };
}

function createCandidates(
  storyMap: StoryMap,
  source: Source,
): {
  extraction: StoryMapExtractionCandidate;
  reconciled: StoryMapContentCandidate;
} {
  const events = storyMap.events.map((event) => ({
    ...event,
    evidence: event.evidence.map((reference) => toClaim(reference, source)),
  }));
  const edges = storyMap.edges.map((edge) => ({
    ...edge,
    evidence: edge.evidence.map((reference) => toClaim(reference, source)),
  }));
  const base = {
    title: storyMap.title,
    logline: storyMap.logline,
    characters: storyMap.characters,
    events,
    edges,
  };
  const duplicateEvent = {
    ...events[5],
    id: "event_06_duplicate",
    participants: events[5].participants.map((participant) =>
      participant === "char_shenyan" ? "char_shenyan_alias" : participant,
    ),
  };

  return {
    extraction: StoryMapExtractionCandidateSchema.parse({
      ...base,
      characters: [
        ...base.characters,
        {
          id: "char_shenyan_alias",
          name: "沈叔",
          aliases: [],
          role: "supporting",
          initialState: "持有半把钥匙的退休守灯人",
        },
      ],
      events: [...events, duplicateEvent],
    }),
    reconciled: StoryMapContentCandidateSchema.parse({
      ...base,
      endingCandidates: storyMap.endingCandidates.map((ending) => ({
        ...ending,
        evidence: ending.evidence.map((reference) =>
          toClaim(reference, source),
        ),
      })),
    }),
  };
}

async function createContext() {
  const fixture = await loadRippleFixture();
  const project = createProject({ title: "Story Map generation" });
  const imported = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: new TextEncoder().encode(fixture.source.originalText),
  });
  const candidates = createCandidates(fixture.storyMap, fixture.source);

  return { fixture, project, source: imported.source, ...candidates };
}

const modelConfig = {
  model: "mock-story-model",
  structuredOutputMode: "json_schema" as const,
};

describe("traceable Story Map generation pipeline", () => {
  it("runs the explicit deterministic Mock configuration without a real model", async () => {
    const { project, source } = await createContext();
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
      expect(
        listProjectGenerationRuns(project.id).map((run) => run.provider),
      ).toEqual(["mock", "mock"]);
    } finally {
      restoreEnvironment("AI_PROVIDER_NAME", previousProvider);
      restoreEnvironment("OPENAI_MODEL", previousModel);
      restoreEnvironment("OPENAI_STRUCTURED_OUTPUT_MODE", previousMode);
    }
  });

  it("creates a valid ripple-001 draft Artifact with traceable runs", async () => {
    const { project, source, extraction, reconciled } = await createContext();
    const sourceBefore = structuredClone(source);
    const provider = new MockAIProvider([
      JSON.stringify(extraction),
      JSON.stringify(reconciled),
    ]);

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
      storyMap: {
        sourceId: source.id,
        version: 1,
        status: "draft",
      },
    });
    expect(result.artifact.storyMap.events).toHaveLength(12);
    expect(result.artifact.storyMap.characters).toHaveLength(5);
    expect(result.artifact.storyMap.characters).not.toContainEqual(
      expect.objectContaining({ id: "char_shenyan_alias" }),
    );
    expect(validateStoryMap(result.artifact.storyMap, source)).toEqual([]);
    expect(getProjectSource(project.id, source.id)).toEqual(sourceBefore);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.prompt).toContain(source.normalizedText);
    expect(provider.requests[1]?.prompt).toContain("endingCandidates");

    const runs = listProjectGenerationRuns(project.id);
    const extractorRun = runs.find(
      (run) => run.id === result.generation.extractorRunId,
    );
    const reconcilerRun = runs.find(
      (run) => run.id === result.generation.reconcilerRunId,
    );
    expect(extractorRun).toMatchObject({
      kind: "story_map_extract",
      promptVersion: "story-map.v1",
      status: "succeeded",
    });
    expect(reconcilerRun).toMatchObject({
      kind: "story_map_reconcile",
      promptVersion: "story-map-reconcile.v1",
      status: "succeeded",
    });
  });

  it("repairs one deterministic Reconciler failure and then persists", async () => {
    const { project, source, extraction, reconciled } = await createContext();
    const invalid = structuredClone(reconciled);
    invalid.edges[0].to = "event_missing";
    const provider = new MockAIProvider([
      JSON.stringify(extraction),
      JSON.stringify(invalid),
      JSON.stringify(reconciled),
    ]);

    const result = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider,
      modelConfig,
    });

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.repair?.validationIssues).toEqual(
      expect.arrayContaining([expect.stringContaining("悬空引用")]),
    );
    expect(
      listProjectGenerationRuns(project.id).find(
        (run) => run.id === result.generation.reconcilerRunId,
      ),
    ).toMatchObject({ status: "succeeded" });
    expect(result.artifact.storyMap.sourceId).toBe(source.id);
  });

  it("fails closed after one invalid repair and creates no Artifact", async () => {
    const { project, source, extraction, reconciled } = await createContext();
    const firstInvalid = structuredClone(reconciled);
    firstInvalid.events[0].participants.push("char_missing");
    const secondInvalid = structuredClone(reconciled);
    secondInvalid.endingCandidates[0].targetEventId = "event_missing";
    const provider = new MockAIProvider([
      JSON.stringify(extraction),
      JSON.stringify(firstInvalid),
      JSON.stringify(secondInvalid),
      JSON.stringify(reconciled),
    ]);

    await expect(
      generateStoryMap({
        projectId: project.id,
        sourceId: source.id,
        provider,
        modelConfig,
      }),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(3);
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([]);
    expect(
      listProjectGenerationRuns(project.id).map((run) => ({
        kind: run.kind,
        status: run.status,
      })),
    ).toEqual(
      expect.arrayContaining([
        { kind: "story_map_extract", status: "succeeded" },
        { kind: "story_map_reconcile", status: "failed" },
      ]),
    );
  });

  it("creates a new versioned Artifact when the same Source is rerun", async () => {
    const { project, source, extraction, reconciled } = await createContext();
    const provider = new MockAIProvider([
      JSON.stringify(extraction),
      JSON.stringify(reconciled),
      JSON.stringify(extraction),
      JSON.stringify(reconciled),
    ]);

    const first = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider,
      modelConfig,
    });
    const second = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider,
      modelConfig,
    });

    expect(first.artifact.version).toBe(1);
    expect(second.artifact).toMatchObject({
      version: 2,
      kind: "story_map_revision",
      basedOnArtifactId: first.artifact.id,
    });
    expect(second.artifact.id).not.toBe(first.artifact.id);
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toHaveLength(
      2,
    );
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
