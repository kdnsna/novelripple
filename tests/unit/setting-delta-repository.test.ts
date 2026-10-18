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
import {
  buildSettingDeltaContextItems,
  deriveActiveSettingDeltas,
  derivePathSettingDeltas,
  renderSettingDeltaContextText,
} from "@/domain/continuation/setting-deltas";
import { buildSceneTree, getScenePath } from "@/domain/continuation/scene-tree";
import {
  SETTING_DELTA_CONTEXT_MAX_CHARS,
  SETTING_DELTA_MAX_ACTIVE,
  SETTING_DELTA_MAX_ROWS_PER_WORLDLINE,
} from "@/domain/continuation/setting-delta-limits";
import {
  addSettingDeltaAction,
  deactivateSettingDeltaAction,
  deleteSettingDeltaAction,
  reactivateSettingDeltaAction,
} from "@/app/projects/actions";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";
import {
  createContinuationDirectionsArtifactV2,
  createContinuationSceneArtifactV2,
  createSettingDeltaArtifact,
  createSettingDeltaLifecycleArtifact,
  getContinuationArtifact,
  listSettingDeltaLifecyclesForWorldline,
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

async function createSceneUnder(
  context: Awaited<ReturnType<typeof createBaseContext>>,
  worldline: Awaited<ReturnType<typeof createChildWorldline>>["worldline"],
  acceptedArtifact: Awaited<
    ReturnType<typeof createChildWorldline>
  >["acceptedArtifact"],
  parent: Awaited<ReturnType<typeof createRootScene>>,
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
    parentSceneId: parent.id,
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
    parentSceneId: parent.id,
    depth:
      (parent.continuation.schemaVersion === 2
        ? parent.continuation.depth
        : 1) + 1,
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
      statement: "旧灯塔已被封锁,任何人不得进入。",
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
      statement: "旧灯塔已被封锁,只能从海侧靠近。",
    });
    expect(rewritten.id).not.toBe(first.id);
    expect(
      listSettingDeltasForWorldline(worldline.id).map(
        (delta) => delta.statement,
      ),
    ).toEqual(
      expect.arrayContaining([
        "旧灯塔已被封锁,任何人不得进入。",
        "旧灯塔已被封锁,只能从海侧靠近。",
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

  it("rejects control characters in statement and term name", async () => {
    const accepted = await createChildWorldline(context);
    const base = {
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      anchorSceneId: null,
      idempotencyKey: "control-char",
    };
    // 20 条用 U+0001 填满的规则都必须停在输入校验，不留下任何行。
    for (let index = 0; index < SETTING_DELTA_MAX_ACTIVE; index += 1) {
      expect(() =>
        createSettingDeltaArtifact({
          ...base,
          idempotencyKey: `control-char-${index}`,
          subject: { kind: "term", name: `旧灯塔 ${index}` },
          statement: `旧灯塔${"\u0001".repeat(200)}已被封锁。`,
        }),
      ).toThrow("不能包含控制字符或换行");
    }
    expect(listSettingDeltasForWorldline(accepted.worldline.id)).toHaveLength(0);
    expect(() =>
      createSettingDeltaArtifact({
        ...base,
        subject: { kind: "term", name: `旧灯${"\u0001"}塔` },
        statement: "旧灯塔已被封锁。",
      }),
    ).toThrow("不能包含控制字符或换行");
    expect(() =>
      createSettingDeltaArtifact({
        ...base,
        subject: { kind: "term", name: "旧灯塔" },
        statement: "旧灯塔已被封锁。\n",
      }),
    ).toThrow("不能包含控制字符或换行");
  });

  it("stores NFKC-normalized text and validates length after normalization", async () => {
    const accepted = await createChildWorldline(context);
    // 每个谚文音节由 3 个 jamo 组合而成：原始 42 字符，NFKC 后 14 字符。
    const jamoName = "\u1100\u1161\u11a8".repeat(14);
    const jamoStatement = "\u1100\u1161\u11a8".repeat(150);
    const artifact = createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: jamoName },
      statement: jamoStatement,
      idempotencyKey: "nfkc-normalized",
    });
    expect(artifact.settingDelta.subject).toEqual({
      kind: "term",
      name: "\uAC01".repeat(14),
    });
    expect(artifact.settingDelta.statement).toBe("\uAC01".repeat(150));
    expect(artifact.settingDelta.statement.length).toBe(150);
  });

  it("rejects a new subject past the active cap but allows replacing an active subject", async () => {
    const accepted = await createChildWorldline(context);
    const createRule = (index: number, idempotencyKey = `active-${index}`) =>
      createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        anchorSceneId: null,
        subject: { kind: "term", name: `规则 ${index}` },
        statement: `这是第 ${index} 条测试规则。`,
        idempotencyKey,
      });
    for (let index = 0; index < SETTING_DELTA_MAX_ACTIVE; index += 1) {
      createRule(index);
    }
    expect(() => createRule(SETTING_DELTA_MAX_ACTIVE)).toThrow(
      "所在路径的生效设定增量超过",
    );

    // 同一主体改写说明属于替换，不增加生效主体数，即使已经到 20 也允许。
    const replacement = createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "规则 0" },
      statement: "规则 0 已改写,仍然只占一个主体。",
      idempotencyKey: "active-replacement",
    });
    expect(replacement.id).not.toBe(
      listSettingDeltasForWorldline(accepted.worldline.id)[0]!.id,
    );
    const deltas = listSettingDeltasForWorldline(accepted.worldline.id);
    const active = deriveActiveSettingDeltas({
      tree: buildSceneTree([]),
      deltas,
      path: [],
    });
    expect(active).toHaveLength(SETTING_DELTA_MAX_ACTIVE);
    const ruleZero = active.find((item) => item.subjectKey === "term:规则 0");
    expect(ruleZero?.active.statement).toBe(
      "规则 0 已改写,仍然只占一个主体。",
    );
  });

  it("frees an active slot on deactivate and enforces the cap again on reactivate", async () => {
    const accepted = await createChildWorldline(context);
    const created = Array.from(
      { length: SETTING_DELTA_MAX_ACTIVE },
      (_, index) =>
        createSettingDeltaArtifact({
          projectId: context.project.id,
          worldlineId: accepted.worldline.id,
          anchorSceneId: null,
          subject: { kind: "term", name: `停用规则 ${index}` },
          statement: `停用测试规则 ${index}。`,
          idempotencyKey: `deactivate-${index}`,
        }),
    );
    const deactivated = createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: created[0]!.id,
      status: "deactivated",
      idempotencyKey: "deactivate-0",
    });
    expect(deactivated.lifecycle.status).toBe("deactivated");

    // 停用释放一个名额，可以添加新的生效主体。
    createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "新规则" },
      statement: "停用后新写入的规则。",
      idempotencyKey: "after-deactivate",
    });
    expect(() =>
      createSettingDeltaLifecycleArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        targetDeltaId: created[0]!.id,
        status: "reactivated",
        idempotencyKey: "reactivate-over-cap",
      }),
    ).toThrow("所在路径的生效设定增量超过");

    // 再停用一条后重新启用会回到 20，允许写入。
    createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: created[1]!.id,
      status: "deactivated",
      idempotencyKey: "deactivate-1",
    });
    const reactivated = createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: created[0]!.id,
      status: "reactivated",
      idempotencyKey: "reactivate-ok",
    });
    expect(reactivated.lifecycle.status).toBe("reactivated");
  });

  it("frees an active slot on soft-delete and hides deleted rules from the path", async () => {
    const accepted = await createChildWorldline(context);
    const created = Array.from(
      { length: SETTING_DELTA_MAX_ACTIVE },
      (_, index) =>
        createSettingDeltaArtifact({
          projectId: context.project.id,
          worldlineId: accepted.worldline.id,
          anchorSceneId: null,
          subject: { kind: "term", name: `删除规则 ${index}` },
          statement: `删除测试规则 ${index}。`,
          idempotencyKey: `delete-${index}`,
        }),
    );
    createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: created[0]!.id,
      status: "deleted",
      idempotencyKey: "delete-0",
    });
    createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "删除后新规则" },
      statement: "软删除后新写入的规则。",
      idempotencyKey: "after-delete",
    });

    const deltas = listSettingDeltasForWorldline(accepted.worldline.id);
    const lifecycles = listSettingDeltaLifecyclesForWorldline(
      accepted.worldline.id,
    );
    const active = deriveActiveSettingDeltas({
      tree: buildSceneTree([]),
      deltas,
      lifecycles,
      path: [],
    });
    expect(active).toHaveLength(SETTING_DELTA_MAX_ACTIVE);
    expect(active.some((item) => item.active.id === created[0]!.id)).toBe(
      false,
    );
    // 旧行仍在存储中，只是不再可见/生效。
    expect(deltas.some((delta) => delta.id === created[0]!.id)).toBe(true);
  });

  it("checks every descendant path when a root write would exceed the active cap", async () => {
    const accepted = await createChildWorldline(context);
    const root = await createRootScene(
      context,
      accepted.worldline,
      accepted.acceptedArtifact,
    );
    const depth2 = await createSceneUnder(
      context,
      accepted.worldline,
      accepted.acceptedArtifact,
      root,
    );
    const deep = await createSceneUnder(
      context,
      accepted.worldline,
      accepted.acceptedArtifact,
      depth2,
    );
    const createAt = (anchorSceneId: string | null, index: number) =>
      createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        anchorSceneId,
        subject: { kind: "term", name: `深层规则 ${index}` },
        statement: `深层规则 ${index} 已生效。`,
        idempotencyKey: `descendant-active-${anchorSceneId ?? "root"}-${index}`,
      });

    // 深层路径已经有 19 个生效主体；根规则的祖先作用域会让它变成 20。
    for (let index = 0; index < SETTING_DELTA_MAX_ACTIVE - 1; index += 1) {
      createAt(deep.id, index);
    }
    createAt(null, 100);
    expect(() => createAt(null, 101)).toThrow(
      "所在路径的生效设定增量超过",
    );
  });

  it("checks descendant path rendered length for the 2k cap", async () => {
    const accepted = await createChildWorldline(context);
    const root = await createRootScene(
      context,
      accepted.worldline,
      accepted.acceptedArtifact,
    );
    const depth2 = await createSceneUnder(
      context,
      accepted.worldline,
      accepted.acceptedArtifact,
      root,
    );
    const deep = await createSceneUnder(
      context,
      accepted.worldline,
      accepted.acceptedArtifact,
      depth2,
    );
    const createAt = (anchorSceneId: string | null, index: number) =>
      createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        anchorSceneId,
        subject: { kind: "term", name: `超长深层规则 ${index}` },
        statement: "灯".repeat(200),
        idempotencyKey: `descendant-chars-${anchorSceneId ?? "root"}-${index}`,
      });

    for (let index = 0; index < 9; index += 1) {
      createAt(deep.id, index);
    }
    const tree = buildSceneTree([
      root.continuation,
      depth2.continuation,
      deep.continuation,
    ]);
    const deltas = listSettingDeltasForWorldline(accepted.worldline.id);
    const active = deriveActiveSettingDeltas({
      tree,
      deltas,
      path: getScenePath(tree, deep.id),
    });
    const rendered = renderSettingDeltaContextText(
      buildSettingDeltaContextItems({
        active,
        characters: context.storyMapArtifact.storyMap.characters,
      }),
    );
    expect(rendered.length).toBeGreaterThan(1800);
    expect(rendered.length).toBeLessThanOrEqual(
      SETTING_DELTA_CONTEXT_MAX_CHARS,
    );

    // 根规则会同时进入深层路径，超过 2k 时拒绝并指出是哪条路径。
    expect(() => createAt(null, 100)).toThrow(
      "所在路径的设定增量超过",
    );
    expect(() => createAt(null, 101)).toThrow("第 3 幕");
  });

  it("rejects reactivating an ancestor that would push a descendant over the active cap", async () => {
    const accepted = await createChildWorldline(context);
    const root = await createRootScene(
      context,
      accepted.worldline,
      accepted.acceptedArtifact,
    );
    const depth2 = await createSceneUnder(
      context,
      accepted.worldline,
      accepted.acceptedArtifact,
      root,
    );
    const deep = await createSceneUnder(
      context,
      accepted.worldline,
      accepted.acceptedArtifact,
      depth2,
    );
    const createAt = (
      anchorSceneId: string | null,
      index: number,
      statement = `规则 ${index}。`,
    ) =>
      createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        anchorSceneId,
        subject: { kind: "term", name: `复活测试 ${index}` },
        statement,
        idempotencyKey: `descendant-reactivate-${anchorSceneId ?? "root"}-${index}`,
      });

    for (let index = 0; index < SETTING_DELTA_MAX_ACTIVE - 1; index += 1) {
      createAt(deep.id, index);
    }
    const rootRule = createAt(null, 100);
    createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: rootRule.id,
      status: "deactivated",
      idempotencyKey: "descendant-reactivate-deactivate",
    });
    // 祖先停用后深层补到 20；重新启用祖先会让深层变成 21。
    createAt(deep.id, 101);
    expect(() =>
      createSettingDeltaLifecycleArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        targetDeltaId: rootRule.id,
        status: "reactivated",
        idempotencyKey: "descendant-reactivate-over-cap",
      }),
    ).toThrow("所在路径的生效设定增量超过");
  });

  it("rejects a post-write active set whose serialized rules exceed the 2k cap", async () => {
    const accepted = await createChildWorldline(context);
    const created: string[] = [];
    let rejectedMessage: string | null = null;
    for (let index = 0; index < SETTING_DELTA_MAX_ACTIVE; index += 1) {
      try {
        const artifact = createSettingDeltaArtifact({
          projectId: context.project.id,
          worldlineId: accepted.worldline.id,
          anchorSceneId: null,
          subject: { kind: "term", name: `超长规则 ${index}` },
          statement: "灯".repeat(200),
          idempotencyKey: `long-${index}`,
        });
        created.push(artifact.id);
      } catch (error) {
        rejectedMessage =
          error instanceof Error ? error.message : String(error);
        break;
      }
    }
    expect(created.length).toBeGreaterThan(0);
    expect(rejectedMessage).toContain("所在路径的设定增量超过");
    expect(rejectedMessage).toContain(
      String(SETTING_DELTA_CONTEXT_MAX_CHARS),
    );
    expect(
      listSettingDeltasForWorldline(accepted.worldline.id),
    ).toHaveLength(created.length);
  });

  it("caps all setting delta rows per worldline including soft-deleted ones", async () => {
    const accepted = await createChildWorldline(context);
    const created = [];
    for (
      let index = 0;
      index < SETTING_DELTA_MAX_ROWS_PER_WORLDLINE;
      index += 1
    ) {
      if (index >= SETTING_DELTA_MAX_ACTIVE) {
        createSettingDeltaLifecycleArtifact({
          projectId: context.project.id,
          worldlineId: accepted.worldline.id,
          targetDeltaId: created[index - SETTING_DELTA_MAX_ACTIVE]!.id,
          status: "deleted",
          idempotencyKey: `rows-delete-${index}`,
        });
      }
      created.push(
        createSettingDeltaArtifact({
          projectId: context.project.id,
          worldlineId: accepted.worldline.id,
          anchorSceneId: null,
          subject: { kind: "term", name: `规则 ${index}` },
          statement: `这是第 ${index} 条测试规则。`,
          idempotencyKey: `rows-${index}`,
        }),
      );
    }
    expect(listSettingDeltasForWorldline(accepted.worldline.id)).toHaveLength(
      SETTING_DELTA_MAX_ROWS_PER_WORLDLINE,
    );
    expect(() =>
      createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        anchorSceneId: null,
        subject: { kind: "term", name: "超出上限" },
        statement: "这条规则不应被写入。",
        idempotencyKey: "rows-overflow",
      }),
    ).toThrow("含已删除规则");

    // 软删除不会释放总行数名额，只会释放 active 名额。
    createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: created.at(-1)!.id,
      status: "deleted",
      idempotencyKey: "rows-delete-last",
    });
    expect(() =>
      createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        anchorSceneId: null,
        subject: { kind: "term", name: "删除后的新规则" },
        statement: "软删除不释放世界线总行数。",
        idempotencyKey: "rows-after-delete",
      }),
    ).toThrow("含已删除规则");
  });

  it("rejects reactivating or deactivating a soft-deleted rule", async () => {
    const accepted = await createChildWorldline(context);
    const delta = createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "已删除规则" },
      statement: "这条规则会被删除。",
      idempotencyKey: "deleted-terminal",
    });
    createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: delta.id,
      status: "deleted",
      idempotencyKey: "deleted-terminal-delete",
    });

    expect(() =>
      createSettingDeltaLifecycleArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        targetDeltaId: delta.id,
        status: "reactivated",
        idempotencyKey: "deleted-terminal-reactivate",
      }),
    ).toThrow("已删除的设定增量不能恢复");
    expect(() =>
      createSettingDeltaLifecycleArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        targetDeltaId: delta.id,
        status: "deactivated",
        idempotencyKey: "deleted-terminal-deactivate",
      }),
    ).toThrow("已删除的设定增量不能恢复");
  });

  it("keeps add/delete cycles bounded after five rounds", async () => {
    const accepted = await createChildWorldline(context);
    let deletedId: string | null = null;
    for (let round = 0; round < 5; round += 1) {
      const created = createSettingDeltaArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        anchorSceneId: null,
        subject: { kind: "term", name: `循环规则 ${round}` },
        statement: `第 ${round} 轮循环规则。`,
        idempotencyKey: `cycle-${round}`,
      });
      if (deletedId !== null) {
        createSettingDeltaLifecycleArtifact({
          projectId: context.project.id,
          worldlineId: accepted.worldline.id,
          targetDeltaId: deletedId,
          status: "deleted",
          idempotencyKey: `cycle-delete-${round}`,
        });
      }
      deletedId = created.id;
    }
    createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: deletedId!,
      status: "deleted",
      idempotencyKey: "cycle-delete-last",
    });
    const deltas = listSettingDeltasForWorldline(accepted.worldline.id);
    const lifecycles = listSettingDeltaLifecyclesForWorldline(
      accepted.worldline.id,
    );
    // 五轮“新增 → 删除”只产生 5 条规则 + 5 条生命周期事件，且删除是终态。
    expect(deltas).toHaveLength(5);
    expect(lifecycles).toHaveLength(5);
    expect(() =>
      createSettingDeltaLifecycleArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        targetDeltaId: deltas[0]!.id,
        status: "reactivated",
        idempotencyKey: "cycle-reactivate-deleted",
      }),
    ).toThrow("已删除的设定增量不能恢复");
  });

  it("appends idempotent lifecycle events and applies the latest status", async () => {
    const accepted = await createChildWorldline(context);
    const delta = createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "生命周期" },
      statement: "生命周期测试规则。",
      idempotencyKey: "lifecycle-delta",
    });
    const first = createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: delta.id,
      status: "deactivated",
      idempotencyKey: "lifecycle-1",
    });
    const again = createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: delta.id,
      status: "deactivated",
      idempotencyKey: "lifecycle-1",
    });
    expect(again.id).toBe(first.id);
    expect(() =>
      createSettingDeltaLifecycleArtifact({
        projectId: context.project.id,
        worldlineId: accepted.worldline.id,
        targetDeltaId: delta.id,
        status: "deleted",
        idempotencyKey: "lifecycle-1",
      }),
    ).toThrow("设定增量生命周期幂等键已被其他内容占用");
    expect(
      listSettingDeltaLifecyclesForWorldline(accepted.worldline.id),
    ).toHaveLength(1);

    createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: delta.id,
      status: "reactivated",
      idempotencyKey: "lifecycle-2",
    });
    const deltas = listSettingDeltasForWorldline(accepted.worldline.id);
    const lifecycles = listSettingDeltaLifecyclesForWorldline(
      accepted.worldline.id,
    );
    expect(
      deriveActiveSettingDeltas({
        tree: buildSceneTree([]),
        deltas,
        lifecycles,
        path: [],
      }),
    ).toHaveLength(1);

    createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: delta.id,
      status: "deleted",
      idempotencyKey: "lifecycle-3",
    });
    expect(
      derivePathSettingDeltas({
        tree: buildSceneTree([]),
        deltas,
        lifecycles: listSettingDeltaLifecyclesForWorldline(
          accepted.worldline.id,
        ),
        path: [],
      }),
    ).toEqual([]);
  });

  it("rejects lifecycle events for a target outside the current worldline", async () => {
    const first = await createChildWorldline(context);
    const second = await createChildWorldline(context);
    const delta = createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: first.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "跨世界线" },
      statement: "跨世界线生命周期测试。",
      idempotencyKey: "lifecycle-cross-delta",
    });
    expect(() =>
      createSettingDeltaLifecycleArtifact({
        projectId: context.project.id,
        worldlineId: second.worldline.id,
        targetDeltaId: delta.id,
        status: "deactivated",
        idempotencyKey: "lifecycle-cross",
      }),
    ).toThrow("设定增量不存在或不属于当前 Worldline");
  });

  it("exposes lifecycle changes through the server actions", async () => {
    const accepted = await createChildWorldline(context);
    const added = await addSettingDeltaAction({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "Action 生命周期" },
      statement: "通过 Action 添加的规则。",
      idempotencyKey: "action-lifecycle-add",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const deactivated = await deactivateSettingDeltaAction({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: added.artifact.id,
      idempotencyKey: "action-lifecycle-deactivate",
    });
    expect(deactivated.ok).toBe(true);
    const reactivated = await reactivateSettingDeltaAction({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: added.artifact.id,
      idempotencyKey: "action-lifecycle-reactivate",
    });
    expect(reactivated.ok).toBe(true);
    const deleted = await deleteSettingDeltaAction({
      projectId: context.project.id,
      worldlineId: accepted.worldline.id,
      targetDeltaId: added.artifact.id,
      idempotencyKey: "action-lifecycle-delete",
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.artifact.lifecycle.status).toBe("deleted");
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
