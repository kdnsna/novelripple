import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JobProgressSchema, type JobProgress } from "@/domain/schemas";
import { deriveEvidenceUnitChunks } from "@/domain/source/evidence-unit-chunks";
import { deriveEvidenceUnits } from "@/domain/source/evidence-units";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import { buildFixtureStoryMapResponses } from "@/server/story-map/fixture-story-map-responses";
import { generateStoryMap } from "@/server/story-map/generate-story-map";

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-story-map-progress-"),
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

async function createFixtureContext() {
  const fixture = await loadRippleFixture();
  const project = createProject({ title: "Story Map progress" });
  const source = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: new TextEncoder().encode(fixture.source.originalText),
  }).source;
  const chunkCount = deriveEvidenceUnitChunks(deriveEvidenceUnits(source)).length;
  return { fixture, project, source, chunkCount };
}

describe("Story Map progress callbacks", () => {
  it("reports stage transitions and chunk counts without changing outputs or call counts", async () => {
    const { fixture, project, source, chunkCount } =
      await createFixtureContext();
    const events: JobProgress[] = [];

    const withProgressProvider = new MockAIProvider(
      buildFixtureStoryMapResponses(source, fixture.storyMap),
    );
    const withProgress = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: withProgressProvider,
      modelConfig,
      onProgress: (progress) => events.push(progress),
    });

    const withoutProgressProvider = new MockAIProvider(
      buildFixtureStoryMapResponses(source, fixture.storyMap),
    );
    const withoutProgress = await generateStoryMap({
      projectId: project.id,
      sourceId: source.id,
      provider: withoutProgressProvider,
      modelConfig,
    });

    expect(withProgressProvider.requests).toHaveLength(
      withoutProgressProvider.requests.length,
    );
    expect(withProgressProvider.requests).toHaveLength(2 * chunkCount + 3);
    expect(withProgress.generation.chunkCount).toBe(chunkCount);

    expect(withoutProgress.artifact.storyMap).toMatchObject({
      title: withProgress.artifact.storyMap.title,
      logline: withProgress.artifact.storyMap.logline,
      characters: withProgress.artifact.storyMap.characters,
      events: withProgress.artifact.storyMap.events,
      edges: withProgress.artifact.storyMap.edges,
      endingCandidates: withProgress.artifact.storyMap.endingCandidates,
    });

    for (const event of events) JobProgressSchema.parse(event);
    expect(events).toEqual([
      { stage: "chunking", completed: chunkCount, total: chunkCount },
      { stage: "extract", completed: 0, total: chunkCount },
      ...Array.from({ length: chunkCount }, (_, index) => ({
        stage: "extract" as const,
        completed: index + 1,
        total: chunkCount,
      })),
      { stage: "glean", completed: 0, total: chunkCount },
      ...Array.from({ length: chunkCount }, (_, index) => ({
        stage: "glean" as const,
        completed: index + 1,
        total: chunkCount,
      })),
      { stage: "names", completed: 0, total: 1 },
      { stage: "names", completed: 1, total: 1 },
      { stage: "endings", completed: 0, total: 1 },
      { stage: "endings", completed: 1, total: 1 },
      { stage: "merge", completed: 0, total: 1 },
      { stage: "merge", completed: 1, total: 1 },
      { stage: "saving", completed: 0, total: 1 },
      { stage: "saving", completed: 1, total: 1 },
    ]);
  });
});
