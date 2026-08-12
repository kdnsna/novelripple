import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ImpactPlan } from "@/domain/schemas";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import {
  generateImpactPlan,
  regenerateImpactPlanFromFeedback,
} from "@/server/ripple/generate-impact-plan";
import {
  createImpactPlanArtifact,
  getImpactPlanArtifact,
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

  it("regenerates a complete candidate while preserving its parent and frozen contract", async () => {
    const { fixture, project, artifact } = await createConfirmedContext();
    const plan = fixture.impactPlans[0];
    const first = await generateImpactPlan({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      divergence: fixture.divergences[0],
      mode: "strict",
      endingCandidateIds: ["ending_truth_public"],
      provider: new MockAIProvider([JSON.stringify(toModelOutput(plan))]),
      modelConfig,
    });
    const parentBefore = structuredClone(first.artifact);
    const revisedOutput = structuredClone(toModelOutput(plan));
    revisedOutput.impacts[0].explanation =
      "人物已经看过照片，因此仍会继续调查，只改变证据保管路径。";
    const provider = new MockAIProvider([JSON.stringify(revisedOutput)]);

    const regenerated = await regenerateImpactPlanFromFeedback({
      projectId: project.id,
      priorCandidateArtifactId: first.artifact.id,
      feedback: "人物看过照片，因此不应退出调查。",
      provider,
      modelConfig,
    });

    expect(regenerated.artifact.id).not.toBe(first.artifact.id);
    expect(regenerated.artifact.impactPlan.impacts[0]?.explanation).toContain(
      "仍会继续调查",
    );
    expect(regenerated.artifact).toMatchObject({
      schemaVersion: 2,
      storyMapArtifactId: artifact.id,
      basedOnArtifactId: first.artifact.id,
      generationRunId: regenerated.generation.runId,
      lineage: {
        priorCandidateArtifactId: first.artifact.id,
        feedback: "人物看过照片，因此不应退出调查。",
        newGenerationRunId: regenerated.generation.runId,
        sameStoryMapArtifactId: artifact.id,
        sameDivergence: first.artifact.impactPlan.divergence,
        sameMode: first.artifact.impactPlan.mode,
        sameAnchors: first.artifact.impactPlan.anchors,
      },
    });
    expect(regenerated.artifact.impactPlan.divergence).toEqual(
      first.artifact.impactPlan.divergence,
    );
    expect(regenerated.artifact.impactPlan.anchors).toEqual(
      first.artifact.impactPlan.anchors,
    );
    expect(provider.requests[0]?.prompt).toContain(
      "人物看过照片，因此不应退出调查。",
    );
    expect(provider.requests[0]?.prompt).toContain('"priorCandidate"');
    expect(getImpactPlanArtifact(first.artifact.id)).toEqual(parentBefore);
    expect(
      listImpactPlanArtifactsForStoryMap(project.id, artifact.id),
    ).toHaveLength(2);
  });

  it("supports consecutive feedback as immutable candidate revisions", async () => {
    const { fixture, project, artifact } = await createConfirmedContext();
    const output = toModelOutput(fixture.impactPlans[2]);
    const first = await generateImpactPlan({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      divergence: fixture.divergences[2],
      mode: "open",
      endingCandidateIds: [],
      provider: new MockAIProvider([JSON.stringify(output)]),
      modelConfig,
    });
    const second = await regenerateImpactPlanFromFeedback({
      projectId: project.id,
      priorCandidateArtifactId: first.artifact.id,
      feedback: "第一次明确反馈",
      provider: new MockAIProvider([JSON.stringify(output)]),
      modelConfig,
    });
    const third = await regenerateImpactPlanFromFeedback({
      projectId: project.id,
      priorCandidateArtifactId: second.artifact.id,
      feedback: "第二次明确反馈",
      provider: new MockAIProvider([JSON.stringify(output)]),
      modelConfig,
    });

    expect(third.artifact.basedOnArtifactId).toBe(second.artifact.id);
    expect(second.artifact.basedOnArtifactId).toBe(first.artifact.id);
    expect(first.artifact.lineage).toBeNull();
  });

  it("fails invalid feedback regeneration after one repair without a child Artifact", async () => {
    const { fixture, project, artifact } = await createConfirmedContext();
    const plan = fixture.impactPlans[0];
    const first = await generateImpactPlan({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      divergence: fixture.divergences[0],
      mode: "strict",
      endingCandidateIds: ["ending_truth_public"],
      provider: new MockAIProvider([JSON.stringify(toModelOutput(plan))]),
      modelConfig,
    });
    const invalid = structuredClone(toModelOutput(plan));
    invalid.impacts[0].reasonPath = ["event_missing"];
    const provider = new MockAIProvider([
      JSON.stringify(invalid),
      JSON.stringify(invalid),
      JSON.stringify(toModelOutput(plan)),
    ]);

    await expect(
      regenerateImpactPlanFromFeedback({
        projectId: project.id,
        priorCandidateArtifactId: first.artifact.id,
        feedback: "修正错误判断",
        provider,
        modelConfig,
      }),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(2);
    expect(
      listImpactPlanArtifactsForStoryMap(project.id, artifact.id),
    ).toHaveLength(1);
    expect(listProjectWorldlines(project.id)).toEqual([]);
    expect(
      listProjectGenerationRuns(project.id).find(
        (run) => run.promptVersion === "impact-plan-feedback.v1",
      ),
    ).toMatchObject({ status: "failed" });
  });

  it("rejects a feedback Artifact that silently changes the frozen divergence", async () => {
    const { fixture, project, artifact } = await createConfirmedContext();
    const plan = fixture.impactPlans[0];
    const first = await generateImpactPlan({
      projectId: project.id,
      storyMapArtifactId: artifact.id,
      divergence: fixture.divergences[0],
      mode: "strict",
      endingCandidateIds: ["ending_truth_public"],
      provider: new MockAIProvider([JSON.stringify(toModelOutput(plan))]),
      modelConfig,
    });
    const run = first.generation;

    expect(() =>
      createImpactPlanArtifact({
        projectId: project.id,
        storyMapArtifact: artifact,
        impactPlan: {
          ...first.artifact.impactPlan,
          id: "artifact_impact_plan_tampered",
          divergence: {
            ...first.artifact.impactPlan.divergence,
            instruction: "静默换成另一条分歧",
          },
        },
        generationRunId: run.runId,
        priorCandidate: first.artifact,
        feedback: "只修正一个判断",
      }),
    ).toThrow("反馈重生成不得改变 Story Map、Divergence、模式或 Anchor");
  });
});
