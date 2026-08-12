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
  listImpactPlanArtifactsForStoryMap,
  listProjectWorldlines,
} from "@/server/repositories/ripple-repository";
import { listProjectGenerationRuns } from "@/server/repositories/generation-run-repository";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";
import { completeReviewAndConfirm } from "../helpers/confirm-ready-story-map";

let temporaryDirectory: string;
const previousEnvironment = new Map<string, string | undefined>();

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-ripple-generation-"),
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

async function createConfirmedContext() {
  const fixture = await loadRippleFixture();
  const project = createProject({ title: "Ripple generation" });
  const imported = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: new TextEncoder().encode(fixture.source.originalText),
  });
  const generated = await generateConfiguredStoryMap({
    projectId: project.id,
    sourceId: imported.source.id,
  });
  const artifact = completeReviewAndConfirm({
    projectId: project.id,
    source: imported.source,
    artifact: generated.artifact,
  });

  return { fixture, project, source: imported.source, artifact };
}

function toModelOutput(plan: ImpactPlan) {
  return {
    impacts: plan.impacts,
    characterChanges: plan.characterChanges,
    threadChanges: plan.threadChanges,
    anchorEvaluations: plan.anchorEvaluations,
    uncertainties: plan.uncertainties,
  };
}

describe("Ripple Simulator generation", () => {
  it("generates all three fixture plans from a confirmed Story Map without writing Worldlines", async () => {
    const { fixture, project, source, artifact } = await createConfirmedContext();
    const sourceBefore = structuredClone(source);

    for (const [index, goldenPlan] of fixture.impactPlans.entries()) {
      const provider = new MockAIProvider([
        JSON.stringify(toModelOutput(goldenPlan)),
      ]);
      const endingCandidateIds =
        goldenPlan.mode === "open"
          ? []
          : artifact.storyMap.endingCandidates
              .filter((ending) =>
                goldenPlan.anchors.some(
                  (anchor) =>
                    anchor.targetEventId === ending.targetEventId &&
                    anchor.requirement === ending.requirement,
                ),
              )
              .map((ending) => ending.id);

      const result = await generateImpactPlan({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        divergence: fixture.divergences[index],
        mode: goldenPlan.mode,
        endingCandidateIds,
        provider,
        modelConfig,
      });

      expect(result.artifact.impactPlan).toMatchObject({
        storyMapId: artifact.storyMap.id,
        mode: goldenPlan.mode,
        divergence: fixture.divergences[index],
        status: "candidate",
      });
      expect(result.artifact.generationRunId).toBe(result.generation.runId);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.prompt).toContain(artifact.storyMap.id);
      expect(provider.requests[0]?.prompt).toContain('"currentWorldline"');
      expect(provider.requests[0]?.prompt).toContain(
        "每项 Impact 的 reasonPath 必须包含 Divergence Event",
      );
      expect(provider.requests[0]?.prompt).toContain(
        "affectedEventId 非空时，reasonPath 必须以该 Event 结束",
      );
      expect(provider.requests[0]?.prompt).toContain(
        "Anchor Evaluation 的 reasonPath 必须从 Divergence Event 开始",
      );
      expect(provider.requests[0]?.prompt).toContain(
        "reasonPath 不得重复 Event",
      );
      expect(provider.requests[0]?.prompt).not.toContain(source.normalizedText);
    }

    expect(listProjectWorldlines(project.id)).toEqual([]);
    expect(
      listImpactPlanArtifactsForStoryMap(project.id, artifact.id),
    ).toHaveLength(3);
    expect(importProjectSource({
      projectId: project.id,
      fileName: "ripple-001.md",
      bytes: new TextEncoder().encode(fixture.source.originalText),
    }).source).toEqual(sourceBefore);

    const impactRuns = listProjectGenerationRuns(project.id).filter(
      (run) => run.kind === "impact_plan",
    );
    expect(impactRuns).toHaveLength(3);
    expect(impactRuns.every((run) => run.worldlineId === null)).toBe(true);
    expect(impactRuns.every((run) => run.promptVersion === "impact-plan.v2")).toBe(
      true,
    );
  });

  it("uses one repair for a deterministic ImpactPlan failure", async () => {
    const { fixture, project, artifact } = await createConfirmedContext();
    const invalid = structuredClone(toModelOutput(fixture.impactPlans[0]));
    invalid.impacts[0].affectedEventId = "event_missing";
    const provider = new MockAIProvider([
      JSON.stringify(invalid),
      JSON.stringify(toModelOutput(fixture.impactPlans[0])),
    ]);

    const result = await generateImpactPlan({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      divergence: fixture.divergences[0],
      mode: "strict",
      endingCandidateIds: ["ending_truth_public"],
      provider,
      modelConfig,
    });

    expect(result.generation.attemptCount).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.repair?.validationIssues).toEqual(
      expect.arrayContaining([expect.stringContaining("affectedEventId")]),
    );
    expect(
      listImpactPlanArtifactsForStoryMap(project.id, artifact.id),
    ).toHaveLength(1);
  });

  it("repairs an open-mode output that illegally evaluates an Anchor", async () => {
    const { fixture, project, artifact } = await createConfirmedContext();
    const valid = toModelOutput(fixture.impactPlans[2]);
    const invalid = structuredClone(valid);
    invalid.anchorEvaluations = [
      {
        anchorId: "anchor_forbidden",
        status: "preserved",
        explanation: "开放模式不应返回 Anchor 评估",
        reasonPath: ["event_09"],
      },
    ];
    const provider = new MockAIProvider([
      JSON.stringify(invalid),
      JSON.stringify(valid),
    ]);

    const result = await generateImpactPlan({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      divergence: fixture.divergences[2],
      mode: "open",
      endingCandidateIds: [],
      provider,
      modelConfig,
    });

    expect(result.generation.attemptCount).toBe(2);
    expect(provider.requests[1]?.repair?.validationIssues).toEqual(
      expect.arrayContaining([expect.stringContaining("anchorEvaluations")]),
    );
    expect(
      listProjectGenerationRuns(project.id).find(
        (run) => run.kind === "impact_plan",
      ),
    ).toMatchObject({ status: "succeeded" });
  });

  it("fails an open-mode run after a second illegal Anchor evaluation", async () => {
    const { fixture, project, artifact } = await createConfirmedContext();
    const invalid = structuredClone(toModelOutput(fixture.impactPlans[2]));
    invalid.anchorEvaluations = [
      {
        anchorId: "anchor_forbidden",
        status: "preserved",
        explanation: "开放模式不应返回 Anchor 评估",
        reasonPath: ["event_09"],
      },
    ];
    const provider = new MockAIProvider([
      JSON.stringify(invalid),
      JSON.stringify(invalid),
    ]);

    await expect(
      generateImpactPlan({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        divergence: fixture.divergences[2],
        mode: "open",
        endingCandidateIds: [],
        provider,
        modelConfig,
      }),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(2);
    expect(
      listProjectGenerationRuns(project.id).find(
        (run) => run.kind === "impact_plan",
      ),
    ).toMatchObject({ status: "failed" });
    expect(listProjectWorldlines(project.id)).toEqual([]);
  });

  it("fails closed after the repair and leaves no ImpactPlan Artifact or Worldline", async () => {
    const { fixture, project, artifact } = await createConfirmedContext();
    const invalid = structuredClone(toModelOutput(fixture.impactPlans[0]));
    invalid.impacts[0].affectedEventId = "event_missing";
    const provider = new MockAIProvider([
      JSON.stringify(invalid),
      JSON.stringify(invalid),
      JSON.stringify(toModelOutput(fixture.impactPlans[0])),
    ]);

    await expect(
      generateImpactPlan({
        projectId: project.id,
        storyMapArtifactId: artifact.id,
        divergence: fixture.divergences[0],
        mode: "strict",
        endingCandidateIds: ["ending_truth_public"],
        provider,
        modelConfig,
      }),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(2);
    expect(
      listImpactPlanArtifactsForStoryMap(project.id, artifact.id),
    ).toEqual([]);
    expect(listProjectWorldlines(project.id)).toEqual([]);
    expect(
      listProjectGenerationRuns(project.id).find(
        (run) => run.kind === "impact_plan",
      ),
    ).toMatchObject({ status: "failed" });
  });
});
