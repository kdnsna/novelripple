import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import { quickConfirmStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";
import { generateConfiguredImpactPlan } from "@/server/ripple/generate-configured-impact-plan";
import { generateConfiguredRippleSuggestions } from "@/server/ripple/generate-configured-ripple-suggestions";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";

let temporaryDirectory: string;
const previousEnvironment = new Map<string, string | undefined>();

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-reader-first-"),
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
  migrate(getDatabase(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
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

describe("reader-first quick-confirmed Story Map", () => {
  it("is accepted by the existing Ripple Suggestions and Impact Plan generators", async () => {
    const fixture = await loadRippleFixture();
    const project = createProject({ title: "Reader first" });
    const imported = importProjectSource({
      projectId: project.id,
      fileName: "ripple-001.md",
      bytes: new TextEncoder().encode(fixture.source.originalText),
    });
    const generated = await generateConfiguredStoryMap({
      projectId: project.id,
      sourceId: imported.source.id,
    });
    expect(generated.artifact.storyMap.status).toBe("draft");

    const quickConfirmed = quickConfirmStoryMapArtifact({
      projectId: project.id,
      artifactId: generated.artifact.id,
    });
    expect(quickConfirmed.storyMap.status).toBe("confirmed");
    expect(quickConfirmed.review.operation?.type).toBe(
      "quick_confirm_story_map",
    );

    const suggestions = await generateConfiguredRippleSuggestions({
      projectId: project.id,
      storyMapArtifactId: quickConfirmed.id,
    });
    expect(suggestions.artifact.storyMapArtifactId).toBe(quickConfirmed.id);
    expect(suggestions.artifact.suggestions).toHaveLength(3);

    const goldenPlan = fixture.impactPlans[0]!;
    const endingCandidateIds =
      goldenPlan.mode === "open"
        ? []
        : quickConfirmed.storyMap.endingCandidates
            .filter((ending) =>
              goldenPlan.anchors.some(
                (anchor) =>
                  anchor.targetEventId === ending.targetEventId &&
                  anchor.requirement === ending.requirement,
              ),
            )
            .map((ending) => ending.id);
    const impactPlan = await generateConfiguredImpactPlan({
      projectId: project.id,
      storyMapArtifactId: quickConfirmed.id,
      divergence: fixture.divergences[0]!,
      mode: goldenPlan.mode,
      endingCandidateIds,
    });

    expect(impactPlan.artifact.storyMapArtifactId).toBe(quickConfirmed.id);
    expect(impactPlan.artifact.impactPlan.status).toBe("candidate");
  });
});
