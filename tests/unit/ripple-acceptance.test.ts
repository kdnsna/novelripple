import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ImpactPlan } from "@/domain/schemas";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { generateImpactPlan } from "@/server/ripple/generate-impact-plan";
import {
  acceptImpactPlan,
  getImpactPlanArtifact,
  listImpactPlanArtifactsForStoryMap,
  listProjectWorldlines,
} from "@/server/repositories/ripple-repository";
import {
  createProject,
  getProjectSource,
  importProjectSource,
} from "@/server/repositories/project-repository";
import {
  getStoryMapArtifact,
} from "@/server/repositories/story-map-artifact-repository";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";
import { completeReviewAndConfirm } from "../helpers/confirm-ready-story-map";

let temporaryDirectory: string;
const previousEnvironment = new Map<string, string | undefined>();

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-ripple-acceptance-"),
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

const modelConfig = {
  model: "mock-ripple-model",
  structuredOutputMode: "json_schema" as const,
};

function toModelOutput(plan: ImpactPlan) {
  return {
    impacts: plan.impacts,
    characterChanges: plan.characterChanges,
    threadChanges: plan.threadChanges,
    anchorEvaluations: plan.anchorEvaluations,
    uncertainties: plan.uncertainties,
  };
}

async function createCandidate(planIndex: 0 | 1 | 2) {
  const fixture = await loadRippleFixture();
  const project = createProject({ title: `Ripple accept ${planIndex}` });
  const imported = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: new TextEncoder().encode(fixture.source.originalText),
  });
  const generated = await generateConfiguredStoryMap({
    projectId: project.id,
    sourceId: imported.source.id,
  });
  const storyMapArtifact = completeReviewAndConfirm({
    projectId: project.id,
    source: imported.source,
    artifact: generated.artifact,
  });
  const plan = fixture.impactPlans[planIndex];
  const endingCandidateIds =
    plan.mode === "open"
      ? []
      : storyMapArtifact.storyMap.endingCandidates
          .filter((ending) =>
            plan.anchors.some(
              (anchor) =>
                anchor.targetEventId === ending.targetEventId &&
                anchor.requirement === ending.requirement,
            ),
          )
          .map((ending) => ending.id);
  const generatedImpact = await generateImpactPlan({
    projectId: project.id,
    storyMapArtifactId: storyMapArtifact.id,
    divergence: fixture.divergences[planIndex],
    mode: plan.mode,
    endingCandidateIds,
    provider: new MockAIProvider([JSON.stringify(toModelOutput(plan))]),
    modelConfig,
  });

  return {
    project,
    source: imported.source,
    storyMapArtifact,
    candidate: generatedImpact.artifact,
  };
}

describe("ImpactPlan acceptance transaction", () => {
  it("atomically creates an accepted revision, idempotent Canonical, and one child Worldline", async () => {
    const context = await createCandidate(0);
    const sourceBefore = structuredClone(context.source);
    const storyMapBefore = structuredClone(context.storyMapArtifact);

    expect(listProjectWorldlines(context.project.id)).toEqual([]);
    const first = acceptImpactPlan({
      projectId: context.project.id,
      candidateArtifactId: context.candidate.id,
    });

    expect(first.acceptedArtifact).toMatchObject({
      storyMapArtifactId: context.storyMapArtifact.id,
      basedOnArtifactId: context.candidate.id,
      generationRunId: null,
      impactPlan: { status: "accepted", mode: "strict" },
    });
    expect(first.canonicalWorldline).toMatchObject({
      status: "canonical",
      parentWorldlineId: null,
      baseStoryMapArtifactId: context.storyMapArtifact.id,
    });
    expect(first.worldline).toMatchObject({
      status: "active",
      parentWorldlineId: first.canonicalWorldline.id,
      baseStoryMapArtifactId: context.storyMapArtifact.id,
      acceptedImpactPlanId: first.acceptedArtifact.id,
      divergence: context.candidate.impactPlan.divergence,
    });
    expect(listProjectWorldlines(context.project.id)).toHaveLength(2);
    expect(getImpactPlanArtifact(context.candidate.id)?.impactPlan.status).toBe(
      "candidate",
    );

    const repeated = acceptImpactPlan({
      projectId: context.project.id,
      candidateArtifactId: context.candidate.id,
    });
    expect(repeated.acceptedArtifact.id).toBe(first.acceptedArtifact.id);
    expect(repeated.canonicalWorldline.id).toBe(first.canonicalWorldline.id);
    expect(repeated.worldline.id).toBe(first.worldline.id);
    expect(listProjectWorldlines(context.project.id)).toHaveLength(2);
    expect(
      listImpactPlanArtifactsForStoryMap(
        context.project.id,
        context.storyMapArtifact.id,
      ),
    ).toHaveLength(2);
    expect(getProjectSource(context.project.id, context.source.id)).toEqual(
      sourceBefore,
    );
    expect(getStoryMapArtifact(context.storyMapArtifact.id)).toEqual(
      storyMapBefore,
    );
  });

  it("fails closed for an incompatible hard Anchor without partial writes", async () => {
    const context = await createCandidate(1);

    expect(() =>
      acceptImpactPlan({
        projectId: context.project.id,
        candidateArtifactId: context.candidate.id,
      }),
    ).toThrow("严格模式锚点不兼容");

    expect(listProjectWorldlines(context.project.id)).toEqual([]);
    expect(
      listImpactPlanArtifactsForStoryMap(
        context.project.id,
        context.storyMapArtifact.id,
      ).map((artifact) => artifact.impactPlan.status),
    ).toEqual(["candidate"]);
  });

  it("accepts an open-mode plan with no Anchor while preserving the confirmed base", async () => {
    const context = await createCandidate(2);
    const storyMapBefore = structuredClone(context.storyMapArtifact);

    const accepted = acceptImpactPlan({
      projectId: context.project.id,
      candidateArtifactId: context.candidate.id,
    });

    expect(accepted.worldline.mode).toBe("open");
    expect(accepted.worldline.anchors).toEqual([]);
    expect(getStoryMapArtifact(context.storyMapArtifact.id)).toEqual(
      storyMapBefore,
    );
  });
});
