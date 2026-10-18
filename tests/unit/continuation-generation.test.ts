import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ContinuationDirectionsModelOutput,
  ContinuationSceneModelOutput,
  ContinuationSceneModelOutputV3,
  ImpactPlan,
} from "@/domain/schemas";
import {
  buildRelatedEvidenceItems,
  divergenceDependencyEventIds,
  selectRelatedCanon,
} from "@/domain/continuation/canon-context";
import {
  buildSettingDeltaContextItems,
  deriveActiveSettingDeltas,
  renderSettingDeltaContextText,
  settingDeltaActiveFingerprint,
} from "@/domain/continuation/setting-deltas";
import { buildSceneTree } from "@/domain/continuation/scene-tree";
import { MockAIProvider } from "@/server/ai/mock-provider";
import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "@/server/ai/types";
import {
  generateConfiguredContinuationDirections,
  generateConfiguredContinuationScene,
} from "@/server/continuation/generate-configured-continuation";
import {
  generateContinuationDirections,
  generateContinuationScene,
  readContinuationContextMaxChars,
} from "@/server/continuation/generate-continuation";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import {
  createContinuationDirectionsArtifact,
  createContinuationDirectionsArtifactV2,
  createContinuationSceneArtifact,
  createContinuationSceneArtifactV2,
  createSettingDeltaArtifact,
  createSettingDeltaLifecycleArtifact,
  getContinuationArtifact,
  getLatestDirectionsBatch,
  listContinuationArtifactsForWorldline,
  listScenesForDirection,
  listSettingDeltasForWorldline,
} from "@/server/repositories/continuation-repository";
import {
  createGenerationRun,
  listProjectGenerationRuns,
  succeedGenerationRun,
} from "@/server/repositories/generation-run-repository";
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
  createStoryMapRevision,
  getStoryMapArtifact,
} from "@/server/repositories/story-map-artifact-repository";
import { generateImpactPlan } from "@/server/ripple/generate-impact-plan";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";
import { M1_06_LONG_SCENE_PROSE } from "../helpers/continuation-scene-fixtures";
import { completeReviewAndConfirm } from "../helpers/confirm-ready-story-map";

let temporaryDirectory: string;
const previousEnvironment = new Map<string, string | undefined>();

function promptSection(prompt: string, kind: string): string {
  const match = new RegExp(`<${kind}>\\n([\\s\\S]*?)\\n</${kind}>`).exec(
    prompt,
  );
  return match?.[1] ?? "";
}

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-continuation-"),
  );
  process.env.DB_FILE_NAME = path.join(temporaryDirectory, "test.db");
  for (const name of [
    "AI_PROVIDER_NAME",
    "OPENAI_MODEL",
    "OPENAI_STRUCTURED_OUTPUT_MODE",
    "CONTINUATION_CONTEXT_MAX_CHARS",
  ]) {
    previousEnvironment.set(name, process.env[name]);
  }
  process.env.AI_PROVIDER_NAME = "mock";
  process.env.OPENAI_MODEL = "mock-continuation-model";
  process.env.OPENAI_STRUCTURED_OUTPUT_MODE = "json_schema";
  delete process.env.CONTINUATION_CONTEXT_MAX_CHARS;
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

/** 慢速 provider：让两个并发请求都先进入 in-flight 窗口。 */
class SlowAIProvider implements AIProvider {
  readonly providerName = "slow-mock";
  readonly requests: AIProviderRequest[] = [];
  readonly #output: string;

  constructor(output: string) {
    this.#output = output;
  }

  async generate(request: AIProviderRequest): Promise<AIProviderResponse> {
    this.requests.push(request);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { rawOutput: this.#output };
  }
}

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

function makeSceneOutput(input?: {
  title?: string;
  factKey?: string;
  factStatement?: string;
}): ContinuationSceneModelOutputV3 {
  const title = input?.title ?? "潮标站的第二把锁";
  return {
    title,
    prose: M1_06_LONG_SCENE_PROSE,
    summary: `${title}：许澄把红账原件封存，并在沈砚与周岚的见证下安排下一步交接。`,
    statePatch: {
      factsAdded: [
        {
          key: input?.factKey ?? "generated:scene_tide_station_lock",
          statement:
            input?.factStatement ??
            "许澄把红账原件封存在旧潮标站铁柜，并由沈砚和周岚远程见证。",
        },
      ],
      factsRemoved: [],
      characterChanges: [
        {
          characterId: "char_xucheng",
          summary: "许澄决定继续持有钥匙并在风暴后亲自提交全部证据。",
        },
      ],
      threadsOpened: [],
      threadsClosed: [],
    },
  };
}

const sceneOutput = makeSceneOutput();

function withoutSummary(
  output: ContinuationSceneModelOutputV3,
): ContinuationSceneModelOutput {
  return {
    title: output.title,
    prose: output.prose,
    statePatch: output.statePatch,
  };
}

function toImpactModelOutput(plan: ImpactPlan) {
  return {
    impacts: plan.impacts,
    characterChanges: plan.characterChanges,
    threadChanges: plan.threadChanges,
    anchorEvaluations: plan.anchorEvaluations,
    uncertainties: plan.uncertainties,
  };
}

async function createAcceptedWorldline(input?: {
  markedUncertainEdgeIds?: string[];
}) {
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
  let storyMapArtifact = completeReviewAndConfirm({
    projectId: project.id,
    source: imported.source,
    artifact: generated.artifact,
  });
  for (const edgeId of input?.markedUncertainEdgeIds ?? []) {
    const marked = createStoryMapRevision({
      projectId: project.id,
      artifactId: storyMapArtifact.id,
      change: { type: "mark_edge_uncertain", edgeId },
    });
    storyMapArtifact = confirmStoryMapArtifact({
      projectId: project.id,
      artifactId: marked.id,
    });
  }
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

function successfulRun(input: {
  projectId: string;
  worldlineId: string;
  kind: "continuation_directions" | "continuation_scene";
  promptVersion: string;
}) {
  const run = createGenerationRun({
    ...input,
    provider: "mock",
    model: "legacy-continuation-model",
    inputHash: "a".repeat(64),
  });
  return succeedGenerationRun({ id: run.id, rawOutput: "{}" });
}

describe("Continuation scene tree generation", () => {
  it("generates v2 directions and a root scene with an assembled no-prose manifest", async () => {
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

    expect(directions.artifact.continuation).toMatchObject({
      schemaVersion: 2,
      parentSceneId: null,
      batchIndex: 0,
    });
    expect(directions.artifact.continuation.directions).toHaveLength(3);
    expect(
      listProjectGenerationRuns(context.project.id).find(
        (run) => run.id === directions.generation?.runId,
      )?.promptVersion,
    ).toBe("continuation-directions.v4");
    expect(directionProvider.requests).toHaveLength(1);
    const directionsPrompt = directionProvider.requests[0]?.prompt ?? "";
    expect(directionsPrompt).toContain("<worldline_setup>");
    expect(directionsPrompt).toContain("<canon_events>");
    expect(directionsPrompt).toContain("<canon_evidence>");
    expect(directionsPrompt).toContain("<anchor_reminder>");
    expect(directionsPrompt).toContain("acceptedImpactPlan");
    expect(directionsPrompt).toContain("currentState");
    expect(directionsPrompt).toContain("[事件 event_");
    expect(directionsPrompt).not.toContain("<selected_direction>");
    expect(directionsPrompt).not.toContain(context.source.normalizedText);

    const repeatedDirections = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([]),
      modelConfig,
    });
    expect(repeatedDirections.artifact.id).toBe(directions.artifact.id);
    expect(repeatedDirections.generation).toBeNull();
    expect(
      getLatestDirectionsBatch(context.worldline.id, null)?.id,
    ).toBe(directions.artifact.id);

    const selectedDirection = directions.artifact.continuation.directions[0]!;
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
      schemaVersion: 2,
      worldlineId: context.worldline.id,
      acceptedImpactPlanId: context.acceptedArtifact.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: selectedDirection.id,
      parentSceneId: null,
      depth: 1,
      origin: "generated",
      attemptIndex: 0,
      summary: sceneOutput.summary,
      title: sceneOutput.title,
      statePatch: sceneOutput.statePatch,
    });
    expect(
      listProjectGenerationRuns(context.project.id).find(
        (run) => run.id === scene.generation?.runId,
      )?.promptVersion,
    ).toBe("continuation-scene.v6");
    expect(sceneProvider.requests[0]?.prompt).toContain(selectedDirection.title);
    expect(sceneProvider.requests[0]?.prompt).toContain("<canon_events>");
    expect(sceneProvider.requests[0]?.prompt).toContain("<canon_evidence>");
    expect(sceneProvider.requests[0]?.prompt).toContain("<selected_direction>");
    expect(sceneProvider.requests[0]?.prompt).toContain("acceptedImpactPlan");
    expect(sceneProvider.requests[0]?.prompt).toContain("currentState");
    // 旧 styleContext / representativeExcerpts 的等价内容仍在 canon_evidence。
    expect(sceneProvider.requests[0]?.prompt).toContain("[opening ");
    expect(sceneProvider.requests[0]?.prompt).toContain("[人物 char_");
    expect(sceneProvider.requests[0]?.prompt).not.toContain(
      context.source.normalizedText,
    );

    if (scene.artifact.continuation.schemaVersion !== 2) {
      throw new Error("expected v2 scene");
    }
    const manifest = scene.artifact.continuation.contextManifest;
    expect(manifest.budget.maxChars).toBe(24_000);
    expect(manifest.sections.map((section) => section.kind)).toEqual([
      "worldline_setup",
      "canon_events",
      "setting_deltas",
      "path_summary",
      "canon_evidence",
      "recent_scenes",
      "selected_direction",
      "anchor_reminder",
    ]);
    expect(
      manifest.sections.find((section) => section.kind === "selected_direction")
        ?.included,
    ).toBe(true);
    const divergenceEventId =
      context.acceptedArtifact.impactPlan.divergence.eventId;
    const pinnedEventIds = divergenceDependencyEventIds(
      context.storyMapArtifact.storyMap,
      divergenceEventId,
    );
    expect(pinnedEventIds.has("event_07")).toBe(true);
    expect(pinnedEventIds.has("event_06")).toBe(true);
    const canonEvidenceSection = manifest.sections.find(
      (section) => section.kind === "canon_evidence",
    )!;
    expect(canonEvidenceSection.pinnedItemIds).toBeDefined();
    for (const eventId of pinnedEventIds) {
      expect(
        canonEvidenceSection.pinnedItemIds!.some((id) =>
          id.startsWith(`related:${eventId}:`),
        ),
      ).toBe(true);
    }
    for (const id of canonEvidenceSection.pinnedItemIds!) {
      expect(canonEvidenceSection.droppedItemIds).not.toContain(id);
    }
    expect(JSON.stringify(manifest)).not.toContain(
      sceneOutput.prose.slice(0, 40),
    );
    expect(JSON.stringify(manifest)).not.toContain(
      context.source.normalizedText.slice(0, 40),
    );

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

    const artifacts = listContinuationArtifactsForWorldline(
      context.worldline.id,
    );
    expect(artifacts.directions).toHaveLength(1);
    expect(artifacts.scenes).toHaveLength(1);
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
  });

  it("marks accepted uncertain impacts as possibilities in continuation context and prompts", async () => {
    const context = await createAcceptedWorldline({
      markedUncertainEdgeIds: ["edge_07_08"],
    });
    expect(context.acceptedArtifact.impactPlan.uncertainImpactIds).toEqual([
      "impact_02",
    ]);
    const directionProvider = new MockAIProvider([
      JSON.stringify(directionOutput),
    ]);

    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: directionProvider,
      modelConfig,
    });

    const directionsPrompt = directionProvider.requests[0]?.prompt ?? "";
    expect(directionsPrompt).toMatch(
      /"id":"impact_02"[^}]*"uncertain":true/,
    );
    expect(directionsPrompt).not.toMatch(
      /"id":"impact_01"[^}]*"uncertain":true/,
    );
    expect(directionsPrompt).toContain("只是可能性，不是已成立的事实");
    expect(
      listProjectGenerationRuns(context.project.id).find(
        (run) => run.id === directions.generation?.runId,
      )?.promptVersion,
    ).toBe("continuation-directions.v4");

    const selectedDirection = directions.artifact.continuation.directions[0]!;
    const sceneProvider = new MockAIProvider([JSON.stringify(sceneOutput)]);
    await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: selectedDirection.id,
      provider: sceneProvider,
      modelConfig,
    });
    const scenePrompt = sceneProvider.requests[0]?.prompt ?? "";
    expect(scenePrompt).toMatch(/"id":"impact_02"[^}]*"uncertain":true/);
    expect(scenePrompt).toContain("只是可能性，不是已成立的事实");
  });

  it("continues from a scene at depth 2 with the parent path in context", async () => {
    const context = await createAcceptedWorldline();
    const rootDirections = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    const rootDirection =
      rootDirections.artifact.continuation.directions[0]!;
    const rootScene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: rootDirections.artifact.id,
      selectedDirectionId: rootDirection.id,
      provider: new MockAIProvider([JSON.stringify(sceneOutput)]),
      modelConfig,
    });

    const childDirections = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      parentSceneId: rootScene.artifact.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    expect(childDirections.artifact.continuation).toMatchObject({
      schemaVersion: 2,
      parentSceneId: rootScene.artifact.id,
      batchIndex: 0,
    });
    expect(childDirections.artifact.id).not.toBe(rootDirections.artifact.id);
    expect(
      getLatestDirectionsBatch(context.worldline.id, rootScene.artifact.id)?.id,
    ).toBe(childDirections.artifact.id);

    const childDirection =
      childDirections.artifact.continuation.directions[0]!;
    const childOutput = makeSceneOutput({
      title: "旧灯塔的夜谈",
      factKey: "generated:scene_lighthouse_talk",
      factStatement: "许澄与沈砚在旧灯塔灯室继续核对封条编号。",
    });
    const childProvider = new MockAIProvider([JSON.stringify(childOutput)]);
    const childScene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: childDirections.artifact.id,
      selectedDirectionId: childDirection.id,
      provider: childProvider,
      modelConfig,
    });

    expect(childScene.artifact.continuation).toMatchObject({
      schemaVersion: 2,
      parentSceneId: rootScene.artifact.id,
      depth: 2,
      origin: "generated",
      attemptIndex: 0,
    });
    const childPrompt = childProvider.requests[0]?.prompt ?? "";
    expect(childPrompt).toContain("<recent_scenes>");
    expect(childPrompt).toContain(sceneOutput.prose);
    expect(childPrompt).toContain("generated:scene_tide_station_lock");
    expect(childPrompt).toContain(childDirection.title);

    if (childScene.artifact.continuation.schemaVersion !== 2) {
      throw new Error("expected v2 scene");
    }
    const recentScenes = childScene.artifact.continuation.contextManifest.sections.find(
      (section) => section.kind === "recent_scenes",
    );
    expect(recentScenes?.included).toBe(true);
    expect(recentScenes?.chars).toBeGreaterThan(0);
  });

  it("keeps every related Canon event and evidence excerpt for root and depth-2 scenes", async () => {
    const context = await createAcceptedWorldline();
    const impactPlan = context.fixture.impactPlans[0]!;
    const related = selectRelatedCanon({
      storyMap: context.storyMapArtifact.storyMap,
      impactPlan,
      anchors: context.worldline.anchors,
    });
    const relatedEvidence = buildRelatedEvidenceItems({
      storyMap: context.storyMapArtifact.storyMap,
      source: context.source,
      impactPlan,
    });
    expect(related.events).toHaveLength(6);
    expect(relatedEvidence).toHaveLength(7);

    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([
        JSON.stringify(context.fixture.continuation.directions),
      ]),
      modelConfig,
    });
    const rootProvider = new MockAIProvider([
      JSON.stringify(context.fixture.continuation.scene),
    ]);
    const rootScene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId:
        directions.artifact.continuation.directions[0]!.id,
      provider: rootProvider,
      modelConfig,
    });
    expectRelatedCanonCoverage(rootProvider.requests[0]?.prompt ?? "");

    const childDirections = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      parentSceneId: rootScene.artifact.id,
      provider: new MockAIProvider([
        JSON.stringify(context.fixture.continuation.directions),
      ]),
      modelConfig,
    });
    const childProvider = new MockAIProvider([
      JSON.stringify(
        makeSceneOutput({
          title: "旧灯塔的夜谈",
          factKey: "generated:coverage_depth_two",
          factStatement: "许澄与沈砚在旧灯塔灯室继续核对封条编号。",
        }),
      ),
    ]);
    const childScene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: childDirections.artifact.id,
      selectedDirectionId:
        childDirections.artifact.continuation.directions[0]!.id,
      provider: childProvider,
      modelConfig,
    });
    expect(childScene.artifact.continuation).toMatchObject({ depth: 2 });
    expectRelatedCanonCoverage(childProvider.requests[0]?.prompt ?? "");

    function expectRelatedCanonCoverage(prompt: string): void {
      for (const event of related.events) {
        expect(prompt).toContain(event.id);
        expect(prompt).toContain(event.title);
      }
      for (const item of relatedEvidence) {
        expect(prompt).toContain(item.text);
      }
    }
  });

  it("coalesces concurrent identical new-batch and retry requests into one provider call", async () => {
    const context = await createAcceptedWorldline();
    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    const direction = directions.artifact.continuation.directions[0]!;
    const original = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: direction.id,
      provider: new MockAIProvider([JSON.stringify(sceneOutput)]),
      modelConfig,
    });

    const slowDirections = new SlowAIProvider(JSON.stringify(directionOutput));
    const [firstBatch, secondBatch] = await Promise.all([
      generateContinuationDirections({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        newBatch: true,
        provider: slowDirections,
        modelConfig,
      }),
      generateContinuationDirections({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        newBatch: true,
        provider: slowDirections,
        modelConfig,
      }),
    ]);
    expect(slowDirections.requests).toHaveLength(1);
    expect(firstBatch.artifact.id).toBe(secondBatch.artifact.id);

    const slowScenes = new SlowAIProvider(JSON.stringify(sceneOutput));
    const [firstRetry, secondRetry] = await Promise.all([
      generateContinuationScene({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        directionsArtifactId: directions.artifact.id,
        selectedDirectionId: direction.id,
        retry: true,
        provider: slowScenes,
        modelConfig,
      }),
      generateContinuationScene({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        directionsArtifactId: directions.artifact.id,
        selectedDirectionId: direction.id,
        retry: true,
        provider: slowScenes,
        modelConfig,
      }),
    ]);
    expect(slowScenes.requests).toHaveLength(1);
    expect(firstRetry.artifact.id).toBe(secondRetry.artifact.id);
    expect(firstRetry.artifact.id).not.toBe(original.artifact.id);

    const scenes = listScenesForDirection(
      directions.artifact.id,
      direction.id,
    );
    expect(
      scenes.map((scene) =>
        scene.continuation.schemaVersion === 1
          ? -1
          : scene.continuation.attemptIndex,
      ),
    ).toEqual([0, 1]);
  });

  it("creates a retry sibling without mutating the original scene", async () => {
    const context = await createAcceptedWorldline();
    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    const direction = directions.artifact.continuation.directions[0]!;
    const original = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: direction.id,
      provider: new MockAIProvider([JSON.stringify(sceneOutput)]),
      modelConfig,
    });
    const originalBefore = structuredClone(original.artifact);

    const retry = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: direction.id,
      retry: true,
      provider: new MockAIProvider([JSON.stringify(sceneOutput)]),
      modelConfig,
    });

    expect(retry.artifact.id).not.toBe(original.artifact.id);
    expect(retry.artifact.continuation).toMatchObject({
      schemaVersion: 2,
      parentSceneId: null,
      depth: 1,
      origin: "retry",
      attemptIndex: 1,
    });
    expect(getContinuationArtifact(original.artifact.id)).toEqual(
      originalBefore,
    );
    const scenes = listScenesForDirection(
      directions.artifact.id,
      direction.id,
    );
    expect(
      scenes.map((scene) =>
        scene.continuation.schemaVersion === 1
          ? -1
          : scene.continuation.attemptIndex,
      ),
    ).toEqual([0, 1]);

    const notRetried = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: direction.id,
      provider: new MockAIProvider([]),
      modelConfig,
    });
    expect(notRetried.artifact.id).toBe(original.artifact.id);
  });

  it("creates a new directions batch while keeping the old batch readable", async () => {
    const context = await createAcceptedWorldline();
    const first = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    const firstBefore = structuredClone(first.artifact);

    const second = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      newBatch: true,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });

    expect(second.artifact.id).not.toBe(first.artifact.id);
    expect(second.artifact.continuation).toMatchObject({
      schemaVersion: 2,
      parentSceneId: null,
      batchIndex: 1,
    });
    expect(getContinuationArtifact(first.artifact.id)).toEqual(firstBefore);
    expect(getLatestDirectionsBatch(context.worldline.id, null)?.id).toBe(
      second.artifact.id,
    );
    expect(
      listContinuationArtifactsForWorldline(context.worldline.id).directions,
    ).toHaveLength(2);

    const oldBatchScene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: first.artifact.id,
      selectedDirectionId:
        first.artifact.continuation.directions[0]!.id,
      provider: new MockAIProvider([JSON.stringify(sceneOutput)]),
      modelConfig,
    });
    expect(oldBatchScene.artifact.continuation.schemaVersion).toBe(2);
  });

  it("isolates sibling path state so one branch's fact never reaches the other", async () => {
    const context = await createAcceptedWorldline();
    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    const branchAOutput = makeSceneOutput({
      title: "分支 A 场景",
      factKey: "generated:branch_a_fact",
      factStatement: "这是只属于分支 A 的独占事实。",
    });
    const branchAScene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId:
        directions.artifact.continuation.directions[0]!.id,
      provider: new MockAIProvider([JSON.stringify(branchAOutput)]),
      modelConfig,
    });

    const branchBProvider = new MockAIProvider([
      JSON.stringify(branchAOutput),
    ]);
    const branchBScene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId:
        directions.artifact.continuation.directions[1]!.id,
      provider: branchBProvider,
      modelConfig,
    });

    expect(branchBScene.artifact.id).not.toBe(branchAScene.artifact.id);
    expect(branchBScene.artifact.continuation).toMatchObject({
      parentSceneId: null,
      depth: 1,
    });
    const branchBPrompt = branchBProvider.requests[0]?.prompt ?? "";
    expect(branchBPrompt).not.toContain("generated:branch_a_fact");
    expect(branchBPrompt).not.toContain("这是只属于分支 A 的独占事实。");
    expect(
      branchBScene.artifact.continuation.statePatch.factsAdded.map(
        (fact) => fact.key,
      ),
    ).toEqual(["generated:branch_a_fact"]);
  });

  it("keeps v1 direction and scene rows readable and usable as a root parent", async () => {
    const context = await createAcceptedWorldline();
    const directionsRun = successfulRun({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      kind: "continuation_directions",
      promptVersion: "continuation.v1",
    });
    const legacyDirections = createContinuationDirectionsArtifact({
      projectId: context.project.id,
      sourceId: context.source.id,
      worldline: context.worldline,
      acceptedImpactPlanArtifact: context.acceptedArtifact,
      output: directionOutput,
      generationRunId: directionsRun.id,
    });
    const sceneRun = successfulRun({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      kind: "continuation_scene",
      promptVersion: "continuation.v2",
    });
    const legacyScene = createContinuationSceneArtifact({
      projectId: context.project.id,
      sourceId: context.source.id,
      worldline: context.worldline,
      acceptedImpactPlanArtifact: context.acceptedArtifact,
      directionsArtifact: legacyDirections,
      selectedDirectionId: legacyDirections.continuation.directions[0]!.id,
      output: withoutSummary(sceneOutput),
      generationRunId: sceneRun.id,
    });

    expect(legacyDirections.continuation.schemaVersion).toBe(1);
    expect(legacyScene.continuation.schemaVersion).toBe(1);
    const legacyArtifacts = listContinuationArtifactsForWorldline(
      context.worldline.id,
    );
    expect(legacyArtifacts.directions.map((artifact) => artifact.id)).toContain(
      legacyDirections.id,
    );
    expect(legacyArtifacts.scenes.map((artifact) => artifact.id)).toContain(
      legacyScene.id,
    );
    expect(getLatestDirectionsBatch(context.worldline.id, null)?.id).toBe(
      legacyDirections.id,
    );

    const childDirections = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      parentSceneId: legacyScene.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    expect(childDirections.artifact.continuation).toMatchObject({
      parentSceneId: legacyScene.id,
      batchIndex: 0,
    });

    const childScene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: childDirections.artifact.id,
      selectedDirectionId:
        childDirections.artifact.continuation.directions[0]!.id,
      provider: new MockAIProvider([
        JSON.stringify(
          makeSceneOutput({
            title: "从 v1 根节点继续",
            factKey: "generated:legacy_child_fact",
            factStatement: "新场景从 v1 根场景继续。",
          }),
        ),
      ]),
      modelConfig,
    });
    expect(childScene.artifact.continuation).toMatchObject({
      schemaVersion: 2,
      parentSceneId: legacyScene.id,
      depth: 2,
    });
  });

  it("returns existing rows for duplicate v2 repository writes", async () => {
    const context = await createAcceptedWorldline();
    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    if (!directions.generation) throw new Error("expected generation run");
    const duplicatedDirections = createContinuationDirectionsArtifactV2({
      projectId: context.project.id,
      sourceId: context.source.id,
      worldline: context.worldline,
      acceptedImpactPlanArtifact: context.acceptedArtifact,
      parentSceneId: null,
      batchIndex: 0,
      output: directionOutput,
      generationRunId: directions.generation.runId,
    });
    expect(duplicatedDirections.id).toBe(directions.artifact.id);

    const scene = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId:
        directions.artifact.continuation.directions[0]!.id,
      provider: new MockAIProvider([JSON.stringify(sceneOutput)]),
      modelConfig,
    });
    if (
      !scene.generation ||
      scene.artifact.continuation.schemaVersion !== 2
    ) {
      throw new Error("expected v2 scene generation");
    }
    const duplicatedScene = createContinuationSceneArtifactV2({
      projectId: context.project.id,
      sourceId: context.source.id,
      worldline: context.worldline,
      acceptedImpactPlanArtifact: context.acceptedArtifact,
      directionsArtifact: directions.artifact,
      selectedDirectionId: scene.artifact.continuation.selectedDirectionId,
      parentSceneId: null,
      depth: 1,
      origin: "generated",
      attemptIndex: 0,
      summary: scene.artifact.continuation.summary,
      contextManifest: scene.artifact.continuation.contextManifest,
      output: withoutSummary(sceneOutput),
      generationRunId: scene.generation.runId,
    });
    expect(duplicatedScene.id).toBe(scene.artifact.id);

    const artifacts = listContinuationArtifactsForWorldline(
      context.worldline.id,
    );
    expect(artifacts.directions).toHaveLength(1);
    expect(artifacts.scenes).toHaveLength(1);
  });

  it("lets the deterministic fixture provider serve summary scenes, retries and later batches", async () => {
    const context = await createAcceptedWorldline();
    const directions = await generateConfiguredContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
    });
    const direction = directions.artifact.continuation.directions[0]!;
    const rootScene = await generateConfiguredContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: direction.id,
    });
    if (rootScene.artifact.continuation.schemaVersion !== 2) {
      throw new Error("expected v2 scene");
    }
    expect(rootScene.artifact.continuation.summary.length).toBeLessThanOrEqual(
      200,
    );

    const retry = await generateConfiguredContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: directions.artifact.id,
      selectedDirectionId: direction.id,
      retry: true,
    });
    expect(retry.artifact.continuation).toMatchObject({
      schemaVersion: 2,
      origin: "retry",
      attemptIndex: 1,
    });

    const childDirections = await generateConfiguredContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      parentSceneId: rootScene.artifact.id,
      newBatch: true,
    });
    expect(childDirections.artifact.continuation).toMatchObject({
      parentSceneId: rootScene.artifact.id,
      batchIndex: 0,
    });
    const childScene = await generateConfiguredContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: childDirections.artifact.id,
      selectedDirectionId:
        childDirections.artifact.continuation.directions[0]!.id,
    });
    expect(childScene.artifact.continuation).toMatchObject({
      schemaVersion: 2,
      parentSceneId: rootScene.artifact.id,
      depth: 2,
    });
  });

  it("validates the context budget environment variable and records it in the manifest", async () => {
    const context = await createAcceptedWorldline();
    try {
      for (const invalid of ["0", "-1", "1.5", "abc", "  "]) {
        process.env.CONTINUATION_CONTEXT_MAX_CHARS = invalid;
        expect(() => readContinuationContextMaxChars()).toThrow(
          "CONTINUATION_CONTEXT_MAX_CHARS",
        );
        await expect(
          generateContinuationDirections({
            projectId: context.project.id,
            worldlineId: context.worldline.id,
            provider: new MockAIProvider([]),
            modelConfig,
          }),
        ).rejects.toThrow("CONTINUATION_CONTEXT_MAX_CHARS");
      }

      process.env.CONTINUATION_CONTEXT_MAX_CHARS = "20000";
      expect(readContinuationContextMaxChars()).toBe(20_000);
      const directions = await generateContinuationDirections({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        provider: new MockAIProvider([JSON.stringify(directionOutput)]),
        modelConfig,
      });
      const scene = await generateContinuationScene({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        directionsArtifactId: directions.artifact.id,
        selectedDirectionId:
          directions.artifact.continuation.directions[0]!.id,
        provider: new MockAIProvider([JSON.stringify(sceneOutput)]),
        modelConfig,
      });
      if (scene.artifact.continuation.schemaVersion !== 2) {
        throw new Error("expected v2 scene");
      }
      expect(
        scene.artifact.continuation.contextManifest.budget.maxChars,
      ).toBe(20_000);
    } finally {
      delete process.env.CONTINUATION_CONTEXT_MAX_CHARS;
    }
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
    expect(
      listContinuationArtifactsForWorldline(context.worldline.id).scenes,
    ).toHaveLength(0);
    const failedRun = listProjectGenerationRuns(context.project.id).find(
      (run) => run.kind === "continuation_scene",
    );
    expect(failedRun).toMatchObject({
      worldlineId: context.worldline.id,
      status: "failed",
    });
  });

  it("puts only path-scoped setting deltas into the setting_deltas section", async () => {
    const context = await createAcceptedWorldline();
    const rootDirections = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    const rootDirection = rootDirections.artifact.continuation.directions[0]!;
    const branchA = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: rootDirections.artifact.id,
      selectedDirectionId: rootDirection.id,
      provider: new MockAIProvider([JSON.stringify(sceneOutput)]),
      modelConfig,
    });
    const branchB = await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: rootDirections.artifact.id,
      selectedDirectionId:
        rootDirections.artifact.continuation.directions[1]!.id,
      provider: new MockAIProvider([
        JSON.stringify(
          makeSceneOutput({
            title: "分支 B 场景",
            factKey: "generated:branch_b_fact",
            factStatement: "这是只属于分支 B 的独占事实。",
          }),
        ),
      ]),
      modelConfig,
    });

    const rootDelta = createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "旧灯塔" },
      statement: "旧灯塔已被封锁,任何人不得进入。",
      idempotencyKey: "generation-delta-root",
    });
    createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      anchorSceneId: branchA.artifact.id,
      subject: { kind: "term", name: "渡船" },
      statement: "夜班渡船已经停航。",
      idempotencyKey: "generation-delta-a",
    });
    createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      anchorSceneId: branchB.artifact.id,
      subject: { kind: "term", name: "北侧石阶" },
      statement: "北侧石阶已经塌方，不能通行。",
      idempotencyKey: "generation-delta-b",
    });

    const rootProvider = new MockAIProvider([JSON.stringify(directionOutput)]);
    await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      newBatch: true,
      provider: rootProvider,
      modelConfig,
    });
    const rootPrompt = rootProvider.requests[0]?.prompt ?? "";
    const rootSetup = promptSection(rootPrompt, "worldline_setup");
    expect(rootSetup).not.toContain("settingDeltas");
    expect(rootSetup).not.toContain("旧灯塔已被封锁,任何人不得进入。");
    const rootSettingDeltas = promptSection(rootPrompt, "setting_deltas");
    expect(rootSettingDeltas).toContain("旧灯塔已被封锁,任何人不得进入。");
    expect(rootSettingDeltas).toContain("自分歧点起");
    expect(rootPrompt).not.toContain("夜班渡船已经停航。");
    expect(rootPrompt).not.toContain("北侧石阶已经塌方，不能通行。");
    expect(rootPrompt.indexOf("<setting_deltas>")).toBeGreaterThan(
      rootPrompt.indexOf("<canon_events>"),
    );

    const childDirectionsProvider = new MockAIProvider([
      JSON.stringify(directionOutput),
    ]);
    const childDirections = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      parentSceneId: branchA.artifact.id,
      newBatch: true,
      provider: childDirectionsProvider,
      modelConfig,
    });
    const childDirectionsPrompt =
      childDirectionsProvider.requests[0]?.prompt ?? "";
    const childSettingDeltas = promptSection(
      childDirectionsPrompt,
      "setting_deltas",
    );
    expect(childSettingDeltas).toContain("旧灯塔已被封锁,任何人不得进入。");
    expect(childSettingDeltas).toContain("夜班渡船已经停航。");
    expect(childSettingDeltas).toContain("自第 1 幕起");
    expect(childDirectionsPrompt).not.toContain(
      "北侧石阶已经塌方，不能通行。",
    );
    expect(
      promptSection(childDirectionsPrompt, "worldline_setup"),
    ).not.toContain("settingDeltas");
    expect(childDirectionsPrompt).toContain(
      "不能改写分歧点之前已发生的原著事实",
    );
    expect(
      listProjectGenerationRuns(context.project.id).find(
        (run) => run.id === childDirections.generation?.runId,
      )?.promptVersion,
    ).toBe("continuation-directions.v4");

    const sceneProvider = new MockAIProvider([
      JSON.stringify(
        makeSceneOutput({
          title: "从分支 A 继续",
          factKey: "generated:from_branch_a",
          factStatement: "新场景只从分支 A 的路径继续。",
        }),
      ),
    ]);
    await generateContinuationScene({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      directionsArtifactId: childDirections.artifact.id,
      selectedDirectionId:
        childDirections.artifact.continuation.directions[0]!.id,
      provider: sceneProvider,
      modelConfig,
    });
    const scenePrompt = sceneProvider.requests[0]?.prompt ?? "";
    expect(promptSection(scenePrompt, "setting_deltas")).toContain(
      "夜班渡船已经停航。",
    );
    expect(scenePrompt).not.toContain("北侧石阶已经塌方，不能通行。");
    expect(scenePrompt).toContain("`setting_deltas` 是读者为当前路径写下的设定规则");
    expect(scenePrompt).toContain(
      "不能改写分歧点之前已发生的原著事实",
    );

    // 停用根规则后，后续生成不再携带它；重新启用后恢复原说明。
    createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      targetDeltaId: rootDelta.id,
      status: "deactivated",
      idempotencyKey: "generation-lifecycle-deactivate",
    });
    const deactivatedProvider = new MockAIProvider([
      JSON.stringify(directionOutput),
    ]);
    await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      newBatch: true,
      provider: deactivatedProvider,
      modelConfig,
    });
    const deactivatedPrompt = deactivatedProvider.requests[0]?.prompt ?? "";
    expect(deactivatedPrompt).not.toContain("旧灯塔已被封锁,任何人不得进入。");

    createSettingDeltaLifecycleArtifact({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      targetDeltaId: rootDelta.id,
      status: "reactivated",
      idempotencyKey: "generation-lifecycle-reactivate",
    });
    const reactivatedProvider = new MockAIProvider([
      JSON.stringify(directionOutput),
    ]);
    await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      newBatch: true,
      provider: reactivatedProvider,
      modelConfig,
    });
    expect(reactivatedProvider.requests[0]?.prompt ?? "").toContain(
      "旧灯塔已被封锁,任何人不得进入。",
    );
  });

  it("attaches non-blocking canon warnings to the saved directions artifact", async () => {
    const context = await createAcceptedWorldline();
    const warningDirections: ContinuationDirectionsModelOutput = {
      directions: directionOutput.directions.map((direction, index) =>
        index === 0
          ? {
              ...direction,
              premise: "她想起铜门被打开那晚，从此不再靠近海岸。",
            }
          : direction,
      ),
    };
    const result = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(warningDirections)]),
      modelConfig,
    });
    const continuation = result.artifact.continuation;
    expect(continuation.schemaVersion).toBe(2);
    if (continuation.schemaVersion !== 2) return;
    expect(continuation.canonWarnings).toEqual([
      expect.objectContaining({
        eventId: "event_02",
        field: "directions.0.premise",
      }),
    ]);
  });

  it("turns a hard canon rejection into a warning under the warn policy", async () => {
    const context = await createAcceptedWorldline();
    const violatingDirections: ContinuationDirectionsModelOutput = {
      directions: directionOutput.directions.map((direction, index) =>
        index === 0
          ? { ...direction, premise: "铜门被打开根本没有发生过，许澄仍被挡在门外。" }
          : direction,
      ),
    };
    const previous = process.env.CONTINUATION_CANON_GUARD;
    process.env.CONTINUATION_CANON_GUARD = "warn";
    try {
      const result = await generateContinuationDirections({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        provider: new MockAIProvider([JSON.stringify(violatingDirections)]),
        modelConfig,
      });
      const continuation = result.artifact.continuation;
      expect(continuation.schemaVersion).toBe(2);
      if (continuation.schemaVersion !== 2) return;
      expect(continuation.canonWarnings).toEqual([
        expect.objectContaining({
          eventId: "event_02",
          field: "directions.0.premise",
        }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.CONTINUATION_CANON_GUARD;
      else process.env.CONTINUATION_CANON_GUARD = previous;
    }
  });

  it("rejects directions that rewrite a locked pre-divergence event", async () => {
    const context = await createAcceptedWorldline();
    const violatingDirections: ContinuationDirectionsModelOutput = {
      directions: directionOutput.directions.map((direction, index) =>
        index === 0
          ? {
              ...direction,
              premise: "铜门被打开从来没有发生过，许澄仍被挡在门外。",
            }
          : direction,
      ),
    };
    const provider = new MockAIProvider([
      JSON.stringify(violatingDirections),
      JSON.stringify(violatingDirections),
    ]);

    await expect(
      generateContinuationDirections({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        provider,
        modelConfig,
      }),
    ).rejects.toThrow(
      "生成内容明确否定了分歧前已确认的原著事件「铜门被打开」",
    );

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.repair?.validationIssues.join(" ")).toContain(
      "分歧前已确认的事件",
    );
    expect(
      listContinuationArtifactsForWorldline(context.worldline.id).directions,
    ).toHaveLength(0);
    expect(
      listProjectGenerationRuns(context.project.id).find(
        (run) => run.kind === "continuation_directions",
      ),
    ).toMatchObject({ status: "failed" });
  });

  it("rejects a scene that rewrites a locked pre-divergence event without writing an artifact", async () => {
    const context = await createAcceptedWorldline();
    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    const violatingScene: ContinuationSceneModelOutputV3 = {
      ...sceneOutput,
      prose: `${M1_06_LONG_SCENE_PROSE}\n\n铜门被打开根本没有发生过，许澄仍在门外等待。`,
    };
    const provider = new MockAIProvider([
      JSON.stringify(violatingScene),
      JSON.stringify(violatingScene),
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
    ).rejects.toThrow(
      "生成内容明确否定了分歧前已确认的原著事件「铜门被打开」",
    );

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.repair?.validationIssues.join(" ")).toContain(
      "分歧前已确认的事件",
    );
    expect(
      listContinuationArtifactsForWorldline(context.worldline.id).scenes,
    ).toHaveLength(0);
    expect(
      listProjectGenerationRuns(context.project.id).find(
        (run) => run.kind === "continuation_scene",
      ),
    ).toMatchObject({ status: "failed" });
  });

  it("measures the exact rendered setting_deltas text that enters the prompt", async () => {
    const context = await createAcceptedWorldline();
    const jamo = "\u1100\u1161\u11a8";
    createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: jamo.repeat(10) },
      statement: jamo.repeat(60),
      idempotencyKey: "prompt-measured-nfc",
    });
    const provider = new MockAIProvider([JSON.stringify(directionOutput)]);
    await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider,
      modelConfig,
    });
    const prompt = provider.requests[0]?.prompt ?? "";
    const section = promptSection(prompt, "setting_deltas");
    const tree = buildSceneTree([]);
    const active = deriveActiveSettingDeltas({
      tree,
      deltas: listSettingDeltasForWorldline(context.worldline.id),
      path: [],
    });
    const rendered = renderSettingDeltaContextText(
      buildSettingDeltaContextItems({
        active,
        characters: context.storyMapArtifact.storyMap.characters,
      }),
    );
    // 写时测量 == 实际渲染；NFC 组合字符在两侧一致。
    expect(section).toBe(rendered);
    expect(section.length).toBe(rendered.length);
    expect(section).toContain("\uAC01");
  });

  it("records the generation-start fingerprint and marks a rule added mid-call stale", async () => {
    const context = await createAcceptedWorldline();
    let added = false;
    const provider: AIProvider = {
      providerName: "mock",
      async generate(): Promise<AIProviderResponse> {
        // 模拟模型调用进行中读者新增规则：批次落库晚于规则 createdAt，
        // 但指纹是在组装上下文时冻结的，因此必须仍被判为 stale。
        createSettingDeltaArtifact({
          projectId: context.project.id,
          worldlineId: context.worldline.id,
          anchorSceneId: null,
          subject: { kind: "term", name: "生成期间新增" },
          statement: "生成期间新增的规则。",
          idempotencyKey: "race-added-during-generation",
        });
        added = true;
        return { rawOutput: JSON.stringify(directionOutput) };
      },
    };
    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider,
      modelConfig,
    });
    expect(added).toBe(true);
    const continuation = directions.artifact.continuation;
    expect(continuation.schemaVersion).toBe(2);
    if (continuation.schemaVersion !== 2) return;
    expect(continuation.settingDeltaFingerprint).toBeDefined();

    const tree = buildSceneTree([]);
    const currentFingerprint = settingDeltaActiveFingerprint(
      deriveActiveSettingDeltas({
        tree,
        deltas: listSettingDeltasForWorldline(context.worldline.id),
        path: [],
      }),
    );
    expect(currentFingerprint).not.toBe(continuation.settingDeltaFingerprint);

    await expect(
      generateContinuationScene({
        projectId: context.project.id,
        worldlineId: context.worldline.id,
        directionsArtifactId: directions.artifact.id,
        selectedDirectionId:
          directions.artifact.continuation.directions[0]!.id,
        provider: new MockAIProvider([JSON.stringify(sceneOutput)]),
        modelConfig,
      }),
    ).rejects.toThrow("设定已更新，请换一批以生效");
  });

  it("rejects scene generation from a stale direction batch after a setting delta", async () => {
    const context = await createAcceptedWorldline();
    const directions = await generateContinuationDirections({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      provider: new MockAIProvider([JSON.stringify(directionOutput)]),
      modelConfig,
    });
    // 批次与增量都用毫秒 ISO 时间；让 delta 的 createdAt 严格晚于批次。
    await new Promise((resolve) => setTimeout(resolve, 5));
    createSettingDeltaArtifact({
      projectId: context.project.id,
      worldlineId: context.worldline.id,
      anchorSceneId: null,
      subject: { kind: "term", name: "旧灯塔" },
      statement: "旧灯塔已被封锁,任何人不得进入。",
      idempotencyKey: "stale-batch-delta",
    });
    const provider = new MockAIProvider([JSON.stringify(sceneOutput)]);

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
    ).rejects.toThrow("设定已更新，请换一批以生效");
    expect(provider.requests).toHaveLength(0);
    expect(
      listContinuationArtifactsForWorldline(context.worldline.id).scenes,
    ).toHaveLength(0);
  });
});
