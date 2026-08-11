import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ContinuationDirectionsModelOutput,
  ContinuationSceneModelOutput,
  ImpactPlan,
} from "@/domain/schemas";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import {
  generateContinuationDirections,
  generateContinuationScene,
} from "@/server/continuation/generate-continuation";
import {
  createContinuationSceneArtifact,
  getContinuationArtifact,
  listContinuationArtifactsForWorldline,
} from "@/server/repositories/continuation-repository";
import { listProjectGenerationRuns } from "@/server/repositories/generation-run-repository";
import {
  createProject,
  getProjectSource,
  importProjectSource,
} from "@/server/repositories/project-repository";
import {
  acceptImpactPlan,
  listProjectWorldlines,
} from "@/server/repositories/ripple-repository";
import {
  confirmStoryMapArtifact,
  getStoryMapArtifact,
} from "@/server/repositories/story-map-artifact-repository";
import { generateImpactPlan } from "@/server/ripple/generate-impact-plan";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";

let temporaryDirectory: string;
const previousEnvironment = new Map<string, string | undefined>();

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-continuation-"),
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
  process.env.OPENAI_MODEL = "mock-continuation-model";
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
  model: "mock-continuation-model",
  structuredOutputMode: "json_schema" as const,
};

const directionOutput: ContinuationDirectionsModelOutput = {
  directions: [
    {
      title: "把证据藏进潮标站",
      premise: "许澄与沈砚先保护红账原件，再寻找不依赖报社车辆的公开路径。",
      affectedCharacterIds: ["char_xucheng", "char_shenyan"],
      expectedConsequence: "原件保管风险暂时下降，但顾闻舟会更快把注意力转向灯塔。",
    },
    {
      title: "让周岚只做见证",
      premise: "周岚不接触原件，只远程记录许澄展示红账与钟锤四页的过程。",
      affectedCharacterIds: ["char_xucheng", "char_zhoulan"],
      expectedConsequence: "独立见证链得到补强，但没有形成原件的第三方保管。",
    },
    {
      title: "反向追踪顾闻舟",
      premise: "许澄故意留下错误去向，以确认顾闻舟掌握红账存在的渠道。",
      affectedCharacterIds: ["char_xucheng", "char_guwenzhou"],
      expectedConsequence: "新的追踪证据可能出现，同时许澄暴露位置的风险上升。",
    },
  ],
};

const sceneOutput: ContinuationSceneModelOutput = {
  title: "潮标站的第二把锁",
  prose:
    "许澄没有把红账带去报社。雨水沿着旧潮标站的百叶窗往下淌，她把包在防潮布里的账簿放进铁柜，又让沈砚当面记下封条编号。沈砚关掉顶灯，只留下值班台的一圈冷光。他们没有宣称证据已经安全，也没有假装周岚持有原件；电话另一端，周岚只记录时间、地点和两人的口述。铁柜上锁后，许澄把钥匙留在自己手里，决定等风暴过去便亲自把原件、钟锤四页和录音一并提交。远处一束车灯扫过堤岸，两人同时停住了动作。",
  statePatch: {
    factsAdded: [
      {
        key: "generated:scene_tide_station_lock",
        statement: "许澄把红账原件封存在旧潮标站铁柜，并由沈砚和周岚远程见证。",
      },
    ],
    factsRemoved: [],
    characterChanges: [
      {
        characterId: "char_xucheng",
        summary: "许澄决定继续持有钥匙并在风暴后亲自提交全部证据。",
      },
    ],
    threadsOpened: ["堤岸上的车辆是否属于顾闻舟"],
    threadsClosed: ["顾闻舟如何定位仍持原件的许澄"],
  },
};

function toImpactModelOutput(plan: ImpactPlan) {
  return {
    impacts: plan.impacts,
    characterChanges: plan.characterChanges,
    threadChanges: plan.threadChanges,
    anchorEvaluations: plan.anchorEvaluations,
    uncertainties: plan.uncertainties,
  };
}

async function createAcceptedWorldline() {
  const fixture = await loadRippleFixture();
  const project = createProject({ title: "Continuation pipeline" });
  const imported = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: new TextEncoder().encode(fixture.source.originalText),
  });
  const generated = await generateConfiguredStoryMap({
    projectId: project.id,
    sourceId: imported.source.id,
  });
  const storyMapArtifact = confirmStoryMapArtifact({
    projectId: project.id,
    artifactId: generated.artifact.id,
  });
  const plan = fixture.impactPlans[0];
  const generatedImpact = await generateImpactPlan({
    projectId: project.id,
    storyMapArtifactId: storyMapArtifact.id,
    divergence: fixture.divergences[0],
    mode: "strict",
    endingCandidateIds: ["ending_truth_public"],
    provider: new MockAIProvider([JSON.stringify(toImpactModelOutput(plan))]),
    modelConfig,
  });
  const accepted = acceptImpactPlan({
    projectId: project.id,
    candidateArtifactId: generatedImpact.artifact.id,
  });

  return {
    fixture,
    project,
    source: imported.source,
    storyMapArtifact,
    ...accepted,
  };
}

describe("Continuation generation and persistence", () => {
  it("generates exactly three directions and one idempotent scene without mutating Canon", async () => {
    const context = await createAcceptedWorldline();
    const sourceBefore = structuredClone(context.source);
    const storyMapBefore = structuredClone(context.storyMapArtifact);
    const worldlinesBefore = structuredClone(
      listProjectWorldlines(context.project.id),
    );
    const directionProvider = new MockAIProvider([
      JSON.stringify(directionOutput),
    ]);

    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: directionProvider,
      modelConfig,
    });

    expect(directions.artifact.continuation.directions).toHaveLength(3);
    expect(
      listProjectGenerationRuns(context.project.id).find(
        (run) => run.id === directions.generation?.runId,
      )?.promptVersion,
    ).toBe("continuation.v1");
    expect(directionProvider.requests).toHaveLength(1);
    expect(directionProvider.requests[0]?.prompt).toContain(
      "relevantEvidence",
    );
    expect(directionProvider.requests[0]?.prompt).toContain("currentState");
    expect(directionProvider.requests[0]?.prompt).not.toContain(
      context.source.normalizedText,
    );

    const repeatedDirections = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([]),
      modelConfig,
    });
    expect(repeatedDirections.artifact.id).toBe(directions.artifact.id);
    expect(repeatedDirections.generation).toBeNull();

    const selectedDirection = directions.artifact.continuation.directions[0];
    const sceneProvider = new MockAIProvider([JSON.stringify(sceneOutput)]);
    const scene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: selectedDirection.id,
      provider: sceneProvider,
      modelConfig,
    });

    expect(scene.artifact.continuation).toMatchObject({
      worldlineId: context.worldline.id,
      acceptedImpactPlanId: context.acceptedArtifact.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: selectedDirection.id,
      sequence: 1,
      title: sceneOutput.title,
      statePatch: sceneOutput.statePatch,
    });
    expect(sceneProvider.requests[0]?.prompt).toContain(selectedDirection.title);
    expect(sceneProvider.requests[0]?.prompt).toContain("acceptedImpactPlan");

    const repeatedScene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: selectedDirection.id,
      provider: new MockAIProvider([]),
      modelConfig,
    });
    expect(repeatedScene.artifact.id).toBe(scene.artifact.id);
    expect(repeatedScene.generation).toBeNull();
    expect(() =>
      createContinuationSceneArtifact({
        projectId: context.project.id,
        sourceId: context.source.id,
        worldline: context.worldline,
        acceptedImpactPlanArtifact: context.acceptedArtifact,
        directionsArtifact: directions.artifact,
        selectedDirectionId:
          directions.artifact.continuation.directions[1]!.id,
        output: sceneOutput,
        generationRunId: scene.artifact.generationRunId,
      }),
    ).toThrow("M0 只允许一个后续场景");
    await expect(
      generateContinuationScene({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        directionsArtifactId: directions.artifact.id,
        selectedDirectionId:
          directions.artifact.continuation.directions[1]!.id,
        provider: new MockAIProvider([JSON.stringify(sceneOutput)]),
        modelConfig,
      }),
    ).rejects.toThrow("M0 只允许一个后续场景");

    expect(listContinuationArtifactsForWorldline(context.worldline.id)).toHaveLength(2);
    expect(getContinuationArtifact(directions.artifact.id)).toEqual(
      directions.artifact,
    );
    expect(getContinuationArtifact(scene.artifact.id)).toEqual(scene.artifact);
    expect(getProjectSource(context.project.id, context.source.id)).toEqual(
      sourceBefore,
    );
    expect(getStoryMapArtifact(context.storyMapArtifact.id)).toEqual(
      storyMapBefore,
    );
    expect(listProjectWorldlines(context.project.id)).toEqual(worldlinesBefore);
    expect(context.canonicalWorldline).toEqual(
      worldlinesBefore.find(
        (worldline) => worldline.id === context.canonicalWorldline.id,
      ),
    );

    const continuationRuns = listProjectGenerationRuns(context.project.id).filter(
      (run) => run.kind.startsWith("continuation_"),
    );
    expect(continuationRuns.map((run) => run.kind).toSorted()).toEqual([
      "continuation_directions",
      "continuation_scene",
    ]);
    expect(continuationRuns.every((run) => run.worldlineId === context.worldline.id)).toBe(true);
  });

  it("repairs once, then fails closed when a scene restores a deleted fact", async () => {
    const context = await createAcceptedWorldline();
    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    const invalidScene = {
      ...sceneOutput,
      statePatch: {
        ...sceneOutput.statePatch,
        factsAdded: [
          {
            key: "event:event_07",
            statement: "许澄恢复了已经被阻止的红账移交。",
          },
        ],
      },
    };
    const provider = new MockAIProvider([
      JSON.stringify(invalidScene),
      JSON.stringify(invalidScene),
    ]);

    await expect(
      generateContinuationScene({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        directionsArtifactId: directions.artifact.id,
        selectedDirectionId:
          directions.artifact.continuation.directions[0]!.id,
        provider,
        modelConfig,
      }),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.repair?.validationIssues.join(" ")).toContain(
      "不得恢复已删除事实",
    );
    expect(listContinuationArtifactsForWorldline(context.worldline.id)).toHaveLength(1);
    const failedRun = listProjectGenerationRuns(context.project.id).find(
      (run) => run.kind === "continuation_scene",
    );
    expect(failedRun).toMatchObject({
      worldlineId: context.worldline.id,
      status: "failed",
    });
  });
});
