import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import type {
  ContinuationSceneModelOutputV3,
  ImpactPlan,
} from "@/domain/schemas";
import { SETTING_DELTA_MAX_PER_WORLDLINE } from "@/domain/continuation/setting-delta-limits";
import { addSettingDeltaAction } from "@/app/projects/actions";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";
import {
  createContinuationDirectionsArtifactV2,
  createContinuationSceneArtifactV2,
  createSettingDeltaArtifact,
  getContinuationArtifact,
  listSettingDeltasForWorldline,
} from "@/server/repositories/continuation-repository";
import {
  createGenerationRun,
  succeedGenerationRun,
} from "@/server/repositories/generation-run-repository";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import {
  acceptImpactPlan,
} from "@/server/repositories/ripple-repository";
import {
  quickConfirmStoryMapArtifact,
} from "@/server/repositories/story-map-artifact-repository";
import { generateImpactPlan } from "@/server/ripple/generate-impact-plan";

import { testContextManifest } from "../helpers/continuation-scene-fixtures";

let temporaryDirectory: string;
const previousEnvironment = new Map<string, string | undefined>();
const modelConfig = {
  model: "mock-setting-delta-model",
  structuredOutputMode: "json_schema" as const,
};

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-setting-delta-"),
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
  process.env.OPENAI_MODEL = "mock-setting-delta-model";
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

function toImpactModelOutput(plan: ImpactPlan) {
  return {
    impacts: plan.impacts,
    characterChanges: plan.characterChanges,
    threadChanges: plan.threadChanges,
    anchorEvaluations: plan.anchorEvaluations,
    uncertainties: plan.uncertainties,
  };
}

function successfulRun(input: {
  projectId: string;
  worldlineId: string;
  kind: "continuation_directions" | "continuation_scene";
  promptVersion: string;
}) {
  const run = createGenerationRun({
    ...input,
    provider: "mock",
    model: "mock-setting-delta-model",
    inputHash: "b".repeat(64),
  });
  return succeedGenerationRun({ id: run.id, rawOutput: "{}" });
}

async function createBaseContext() {
  const fixture = await loadRippleFixture();
  const project = createProject({ title: "Setting delta repository" });
  const imported = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: new TextEncoder().encode(fixture.source.originalText),
  });
  const generated = await generateConfiguredStoryMap({
    projectId: project.id,
    sourceId: imported.source.id,
  });
  const storyMapArtifact = quickConfirmStoryMapArtifact({
    projectId: project.id,
    artifactId: generated.artifact.id,
  });
  return { fixture, project, source: imported.source, storyMapArtifact };
}

async function createChildWorldline(
  context: Awaited<ReturnType<typeof createBaseContext>>,
) {
  const generatedImpact = await generateImpactPlan({
    projectId: context.project.id,
    storyMapArtifactId: context.storyMapArtifact.id,
    divergence: context.fixture.divergences[0],
    mode: "strict",
    endingCandidateIds: ["ending_truth_public"],
    provider: new MockAIProvider([
      JSON.stringify(toImpactModelOutput(context.fixture.impactPlans[0]!)),
    ]),
    modelConfig,
  });
  return acceptImpactPlan({
    projectId: context.project.id,
    candidateArtifactId: generatedImpact.artifact.id,
  });
}

async function createRootScene(
  context: Awaited<ReturnType<typeof createBaseContext>>,
  worldline: Awaited<ReturnType<typeof createChildWorldline>>["worldline"],
  acceptedArtifact: Awaited<
    ReturnType<typeof createChildWorldline>
  >["acceptedArtifact"],
) {
  const directionsRun = successfulRun({
    projectId: context.project.id,
    worldlineId: worldline.id,
    kind: "continuation_directions",
    promptVersion: "continuation-directions.v4",
  });
  const directions = createContinuationDirectionsArtifactV2({
    projectId: context.project.id,
    sourceId: context.source.id,
    worldline,
    acceptedImpactPlanArtifact: acceptedArtifact,
    parentSceneId: null,
    batchIndex: 0,
    output: context.fixture.continuation.directions,
    generationRunId: directionsRun.id,
  });
  const sceneRun = successfulRun({
    projectId: context.project.id,
    worldlineId: worldline.id,
    kind: "continuation_scene",
    promptVersion: "continuation-scene.v5",
  });
  const fixtureScene: ContinuationSceneModelOutputV3 =
    context.fixture.continuation.scene;
  return createContinuationSceneArtifactV2({
    projectId: context.project.id,
    sourceId: context.source.id,
    worldline,
    acceptedImpactPlanArtifact: acceptedArtifact,
    directionsArtifact: directions,
    selectedDirectionId: directions.continuation.directions[0]!.id,
    parentSceneId: null,
    depth: 1,
    origin: "generated",
    attemptIndex: 0,
    summary: fixtureScene.summary,
    contextManifest: testContextManifest(),
    output: {
      title: fixtureScene.title,
      prose: fixtureScene.prose,
      statePatch: fixtureScene.statePatch,
    },
    generationRunId: sceneRun.id,
  });
}

describe("setting delta repository and action", () => {
  let context: Awaited<ReturnType<typeof createBaseContext>>;

  beforeAll(async () => {
    context = await createBaseContext();
  });

  it("creates setting deltas idempotently and lists them by creation time", async () => {
    const accepted = await createChildWorldline(context);
    const { worldline } = accepted;
    const input = {
      projectId: context.project.id,
      worldlineId: worldline.id,
      anchorSceneId: null,
      subject: { kind: "term" as const, name: "旧灯塔" },
      statement: "旧灯塔已被封锁，任何人不得进入。",
      idempotencyKey: "setting-delta-root-1",
    };
    const first = createSettingDeltaArtifact(input);
    const second = createSettingDeltaArtifact(input);
    expect(second.id).toBe(first.id);
    expect(second.settingDelta).toEqual(first.settingDelta);
    expect(listSettingDeltasForWorldline(worldline.id)).toHaveLength(1);

    const rewritten = createSettingDeltaArtifact({
      ...input,
      idempotencyKey: "setting-delta-root-2",
      statement: "旧灯塔已被封锁，只能从海侧靠近。",
    });
    expect(rewritten.id).not.toBe(first.id);
    expect(
      listSettingDeltasForWorldline(worldline.id).map(
        (delta) => delta.statement,
      ),
    ).toEqual(
      expect.arrayContaining([
        "旧灯塔已被封锁，任何人不得进入。",
        "旧灯塔已被封锁，只能从海侧靠近。",
      ]),
    );
  });

  it("rejects an anchor scene that belongs to another worldline", async () => {
    const first = await createChildWorldline(context);
    const second = await createChildWorldline(context);
    const scene = await createRootScene(
      context,
      first.worldline,
      first.acceptedArtifact,
    );

    expect(() =>
      createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: second.worldline.id,
        anchorSceneId: scene.id,
        subject: { kind: "term", name: "旧灯塔" },
        statement: "旧灯塔已被封锁。",
        idempotencyKey: "cross-worldline-anchor",
      }),
    ).toThrow("锚点场景不属于当前 Worldline");
  });

  it("rejects a character that is not in the bound Story Map", async () => {
    const accepted = await createChildWorldline(context);
    expect(() =>
      createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        anchorSceneId: null,
        subject: { kind: "character", characterId: "char_unknown" },
        statement: "这个人物不存在。",
        idempotencyKey: "unknown-character",
      }),
    ).toThrow("设定增量的人物不在当前 Worldline 的 Story Map 中");
  });

  it("caps stored setting deltas per worldline", async () => {
    const accepted = await createChildWorldline(context);
    for (let index = 0; index < SETTING_DELTA_MAX_PER_WORLDLINE; index += 1) {
      createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        anchorSceneId: null,
        subject: { kind: "term", name: `规则 ${index}` },
        statement: `这是第 ${index} 条测试规则。`,
        idempotencyKey: `cap-${index}`,
      });
    }
    expect(
      listSettingDeltasForWorldline(accepted.worldline.id),
    ).toHaveLength(SETTING_DELTA_MAX_PER_WORLDLINE);
    expect(() =>
      createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        anchorSceneId: null,
        subject: { kind: "term", name: "超出上限" },
        statement: "这条规则不应被写入。",
        idempotencyKey: "cap-overflow",
      }),
    ).toThrow("设定增量已达到每条世界线的上限");
  });

  it("adds setting deltas through the server action and rejects invalid input", async () => {
    const accepted = await createChildWorldline(context);
    const valid = await addSettingDeltaAction({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "渡船" },
      statement: "夜班渡船已经停航。",
      idempotencyKey: "action-term-1",
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.artifact.settingDelta.statement).toBe("夜班渡船已经停航。");
    expect(getContinuationArtifact(valid.artifact.id)).toEqual(valid.artifact);

    const invalid = await addSettingDeltaAction({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "" },
      statement: "",
      idempotencyKey: "action-invalid",
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error).toContain("设定增量参数无效");
  });
});
