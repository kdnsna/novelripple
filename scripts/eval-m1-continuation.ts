import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import {
  M1ContinuationReportSchema,
  determineM1ContinuationStatus,
  type M1ContinuationReport,
  type M1ContinuationStory,
} from "../src/evals/m1-continuation";
import {
  InstrumentedAIProvider,
  countBenchmarkCharacters,
  summarizeProviderObservations,
  validateM1BenchmarkManifest,
  type ProviderObservation,
} from "../src/evals/m1-baseline";
import { prepareSourceImport } from "../src/domain/source/normalize-source";
import type {
  ContinuationDirectionsArtifact,
  ContinuationSceneArtifact,
  ImpactPlanArtifact,
  StoryMap,
  Worldline,
} from "../src/domain/schemas";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const manifestSchemaPath = path.join(
  repositoryRoot,
  "benchmarks",
  "m1",
  "manifest.schema.json",
);
const previousDatabasePath = process.env.DB_FILE_NAME;

type BenchmarkTarget = {
  storyClass: "A" | "B" | "C";
  contentHash: string;
};

type GenerationStage = M1ContinuationStory["impactPlan"];
type StoryMapProvisioning = M1ContinuationStory["storyMapProvisioning"];
type WorldlineStage = M1ContinuationStory["worldline"];
type IsolationChecks = M1ContinuationStory["isolation"];
type SceneStage = M1ContinuationStory["scene"];

type PrivateSceneArchive = {
  storyClass: "A" | "B" | "C";
  evaluatedAt: string;
  commitSha: string;
  provider: string;
  model: string;
  structuredOutputMode: string;
  storyMap: {
    provisioning: string;
    version: number;
    characterCount: number;
    eventCount: number;
    edgeCount: number;
    endingCandidateCount: number;
  };
  divergence: {
    source: string;
    type: string;
    instruction: string;
  };
  acceptedImpactPlan: {
    impactCount: number;
    characterChangesCount: number;
    threadsOpenedCount: number;
    threadsClosedCount: number;
    factsRemovedKeys: string[];
    factsAddedStatements: string[];
  };
  directions: Array<{
    title: string;
    premise: string;
    affectedCharacterNames: string[];
    expectedConsequence: string;
  }>;
  selectedDirectionIndex: number;
  scene: {
    title: string;
    prose: string;
    statePatch: {
      factsAdded: Array<{ key: string; statement: string }>;
      factsRemoved: string[];
      characterChanges: Array<{
        characterName: string;
        change: Record<string, unknown>;
      }>;
      threadsOpened: string[];
      threadsClosed: string[];
    };
  };
  automaticChecks: {
    proseTotalChars: number;
    proseCjkChars: number;
    proseWithinTargetRange: boolean;
    consistencyHardGatePassed: boolean;
    schemaValidated: boolean;
    worldlineIsolationVerified: boolean;
  };
};

class EvaluationSetupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvaluationSetupError";
  }
}

let report: M1ContinuationReport | undefined;
let reportPath: string | undefined;
let scenesDirectory: string | undefined;

try {
  const { baselineDb, manifestPaths, scenesDir } = parseArguments();
  scenesDirectory = scenesDir;
  const commitSha = await readCommitSha();
  const evaluatedAt = new Date().toISOString();
  const runId = createRunId(evaluatedAt, commitSha);
  const reportDirectory = path.join(
    repositoryRoot,
    ".data",
    "evals",
    "m1-continuation",
    runId,
  );
  await mkdir(path.dirname(reportDirectory), { recursive: true });
  await mkdir(reportDirectory, { recursive: false });
  const evaluationDatabasePath = path.join(reportDirectory, "eval.db");
  await backupDatabase(baselineDb, evaluationDatabasePath);
  process.env.DB_FILE_NAME = evaluationDatabasePath;

  const { closeDatabase, getDatabase } = await import("../src/server/db/client");
  closeDatabase();
  migrate(getDatabase(), {
    migrationsFolder: path.join(repositoryRoot, "drizzle"),
  });

  const targets = await loadBenchmarkTargets(manifestPaths);
  const {
    createConfiguredAIProvider,
    readConfiguredAI,
  } = await import("../src/server/ai/configured-runtime");
  const config = readConfiguredAI();
  if (config.providerName !== "openai-compatible") {
    throw new EvaluationSetupError("real_provider_required");
  }
  const provider = new InstrumentedAIProvider(
    createConfiguredAIProvider(config),
  );

  const stories: M1ContinuationStory[] = [];
  const archives: PrivateSceneArchive[] = [];
  for (const target of targets.toSorted((a, b) =>
    a.storyClass.localeCompare(b.storyClass),
  )) {
    const result = await evaluateStory(
      target,
      provider,
      evaluatedAt,
      commitSha,
      config.modelConfig.model,
      config.modelConfig.structuredOutputMode,
    );
    stories.push(result.story);
    if (result.archive) archives.push(result.archive);
  }

  report = M1ContinuationReportSchema.parse({
    schemaVersion: 1,
    kind: "m1_continuation",
    runId,
    commitSha,
    evaluatedAt,
    provider: config.providerName,
    model: config.modelConfig.model,
    structuredOutputMode: config.modelConfig.structuredOutputMode,
    status: determineM1ContinuationStatus(stories),
    databaseFile: "eval.db",
    baselineDatabase: "m1-04-local-observation-copy",
    stories,
    privacy: {
      containsSourceBody: false,
      containsRawModelOutput: false,
      containsPrivateTitleOrNames: false,
    },
  });
  reportPath = path.join(reportDirectory, "metrics.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writePrivateSceneArchives(scenesDirectory, runId, evaluatedAt, commitSha, config.modelConfig.model, config.modelConfig.structuredOutputMode, archives);
  closeDatabase();
} catch (error) {
  console.error(`M1 Continuation 未运行：${safeFailureCode(error)}`);
  if (error instanceof Error) {
    console.error(`[detail] ${error.message}`);
    if (error.stack) console.error(error.stack.split("\n").slice(0, 8).join("\n"));
  }
  process.exitCode = 1;
} finally {
  const { closeDatabase } = await import("../src/server/db/client");
  closeDatabase();
  if (previousDatabasePath === undefined) delete process.env.DB_FILE_NAME;
  else process.env.DB_FILE_NAME = previousDatabasePath;
}

if (report && reportPath) {
  printReport(report, reportPath);
  if (report.status === "failed") process.exitCode = 1;
}

async function evaluateStory(
  target: BenchmarkTarget,
  provider: InstrumentedAIProvider,
  evaluatedAt: string,
  commitSha: string,
  model: string,
  structuredOutputMode: string,
): Promise<{ story: M1ContinuationStory; archive: PrivateSceneArchive | null }> {
  const {
    listProjects,
    listProjectSources,
    getProjectSource,
  } = await import("../src/server/repositories/project-repository");
  const {
    listStoryMapArtifactsForSource,
    getStoryMapArtifact,
    createStoryMapRevision,
    confirmStoryMapArtifact,
  } = await import(
    "../src/server/repositories/story-map-artifact-repository"
  );
  const {
    getImpactPlanArtifact,
    acceptImpactPlan,
    listProjectWorldlines,
    getWorldline,
  } = await import("../src/server/repositories/ripple-repository");
  const { generateRippleSuggestions } = await import(
    "../src/server/ripple/generate-ripple-suggestions"
  );
  const { generateImpactPlan } = await import(
    "../src/server/ripple/generate-impact-plan"
  );
  const {
    generateContinuationDirections,
    generateContinuationScene,
  } = await import("../src/server/continuation/generate-continuation");
  const { deriveWorldlineDelta, validateContinuationStatePatch } =
    await import("../src/domain/invariants/validate-continuation");
  const { readConfiguredAI } = await import(
    "../src/server/ai/configured-runtime"
  );
  const config = readConfiguredAI();

  const matches = listProjects().flatMap((project) =>
    listProjectSources(project.id)
      .filter((source) => source.contentHash === target.contentHash)
      .map((source) => ({ project, source })),
  );
  if (matches.length !== 1) {
    return {
      story: failedStory(target.storyClass, "confirmed_story_map_match_failed"),
      archive: null,
    };
  }
  const [{ project, source }] = matches;

  // ── 1. Story Map：复用 confirmed，否则由评测器完成确定性确认 ──
  let confirmedArtifact = listStoryMapArtifactsForSource(
    project.id,
    source.id,
  )
    .filter((artifact) => artifact.storyMap.status === "confirmed")
    .toSorted((left, right) => right.version - left.version)[0];
  let provisioning: StoryMapProvisioning;
  if (confirmedArtifact) {
    provisioning = {
      status: "reused_confirmed",
      baselineConfirmedVersion: confirmedArtifact.version,
      draftVersionConfirmed: null,
      reviewOperationsApplied: 0,
      finalVersion: confirmedArtifact.version,
      failureCode: null,
    };
  } else {
    let latest = listStoryMapArtifactsForSource(project.id, source.id)
      .filter((artifact) => artifact.storyMap.status === "draft")
      .toSorted((left, right) => right.version - left.version)[0];
    if (!latest) {
      return {
        story: failedStory(target.storyClass, "story_map_missing"),
        archive: null,
      };
    }
    const draftVersion = latest.version;
    let operationsApplied = 0;
    try {
      for (const character of latest.storyMap.characters) {
        latest = createStoryMapRevision({
          projectId: project.id,
          artifactId: latest.id,
          change: { type: "confirm_character", characterId: character.id },
        });
        operationsApplied += 1;
      }
      for (const event of latest.storyMap.events) {
        for (const evidence of event.evidence) {
          latest = createStoryMapRevision({
            projectId: project.id,
            artifactId: latest.id,
            change: { type: "confirm_evidence", eventId: event.id, evidence },
          });
          operationsApplied += 1;
        }
      }
      for (const edge of latest.storyMap.edges) {
        for (const evidence of edge.evidence) {
          latest = createStoryMapRevision({
            projectId: project.id,
            artifactId: latest.id,
            change: {
              type: "confirm_edge_evidence",
              edgeId: edge.id,
              evidence,
            },
          });
          operationsApplied += 1;
        }
      }
      for (const ending of latest.storyMap.endingCandidates) {
        latest = createStoryMapRevision({
          projectId: project.id,
          artifactId: latest.id,
          change: {
            type: "confirm_ending_candidate",
            endingCandidateId: ending.id,
          },
        });
        operationsApplied += 1;
      }
      latest = confirmStoryMapArtifact({
        projectId: project.id,
        artifactId: latest.id,
      });
      operationsApplied += 1;
      confirmedArtifact = latest;
      provisioning = {
        status: "confirmed_by_harness",
        baselineConfirmedVersion: null,
        draftVersionConfirmed: draftVersion,
        reviewOperationsApplied: operationsApplied,
        finalVersion: confirmedArtifact.version,
        failureCode: null,
      };
    } catch (error) {
      provisioning = {
        status: "failed",
        baselineConfirmedVersion: null,
        draftVersionConfirmed: draftVersion,
        reviewOperationsApplied: operationsApplied,
        finalVersion: null,
        failureCode: safeFailureCode(error),
      };
      return {
        story: {
          ...failedStory(target.storyClass, provisioning.failureCode),
          confirmedStoryMapMatched: true,
          storyMapProvisioning: provisioning,
        },
        archive: null,
      };
    }
  }

  const sourceSnapshot = JSON.stringify(source);
  const storyMapSnapshot = JSON.stringify(confirmedArtifact);
  const worldlinesBefore = listProjectWorldlines(project.id).length;

  // ── 2. 3 个 Ripple Suggestions（沿用 M1-05 评测入口）──
  let suggestionsStage: M1ContinuationStory["suggestions"];
  let suggestionsArtifact:
    | Awaited<ReturnType<typeof generateRippleSuggestions>>["artifact"]
    | undefined;
  {
    const startedAt = performance.now();
    const observationStart = provider.observations.length;
    try {
      const result = await generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: confirmedArtifact.id,
        provider,
        modelConfig: config.modelConfig,
      });
      suggestionsArtifact = result.artifact;
      suggestionsStage = {
        ...successfulStage(
          result.generation,
          "ripple-suggestions.v3",
          elapsedMilliseconds(startedAt),
          provider.observations.slice(observationStart),
        ),
        suggestionCount: result.artifact.suggestions.length,
        selectedSuggestionIndex: 0,
      };
    } catch (error) {
      suggestionsStage = {
        ...failedStage(
          "ripple-suggestions.v3",
          elapsedMilliseconds(startedAt),
          provider.observations.slice(observationStart),
          error,
        ),
        suggestionCount: null,
        selectedSuggestionIndex: null,
      };
    }
  }
  if (!suggestionsArtifact) {
    return {
      story: {
        ...failedStory(target.storyClass, suggestionsStage.failureCode),
        confirmedStoryMapMatched: true,
        storyMapProvisioning: provisioning,
        suggestions: suggestionsStage,
      },
      archive: null,
    };
  }

  // ── 3. Impact Plan candidate（suggestions[0]，open 模式）──
  let impactPlanStage: GenerationStage;
  let impactPlanArtifact:
    | Awaited<ReturnType<typeof generateImpactPlan>>["artifact"]
    | undefined;
  {
    const suggestion = suggestionsArtifact.suggestions[0];
    const startedAt = performance.now();
    const observationStart = provider.observations.length;
    try {
      const result = await generateImpactPlan({
        projectId: project.id,
        storyMapArtifactId: confirmedArtifact.id,
        divergence: {
          id: `divergence_${randomUUID()}`,
          eventId: suggestion.eventId,
          type: suggestion.divergenceType,
          instruction: suggestion.instruction,
        },
        mode: "open",
        endingCandidateIds: [],
        provider,
        modelConfig: config.modelConfig,
      });
      impactPlanArtifact = result.artifact;
      impactPlanStage = successfulStage(
        result.generation,
        "impact-plan.v3",
        elapsedMilliseconds(startedAt),
        provider.observations.slice(observationStart),
      );
    } catch (error) {
      impactPlanStage = failedStage(
        "impact-plan.v3",
        elapsedMilliseconds(startedAt),
        provider.observations.slice(observationStart),
        error,
      );
    }
  }
  if (!impactPlanArtifact) {
    return {
      story: {
        ...failedStory(target.storyClass, impactPlanStage.failureCode),
        confirmedStoryMapMatched: true,
        storyMapProvisioning: provisioning,
        suggestions: suggestionsStage,
        impactPlan: impactPlanStage,
      },
      archive: null,
    };
  }

  // ── 4. 接受 Impact Plan → active Worldline ──
  let worldlineStage: WorldlineStage;
  let canonicalWorldlineId: string | null = null;
  let childWorldlineId: string | null = null;
  {
    const startedAt = performance.now();
    try {
      const accepted = acceptImpactPlan({
        projectId: project.id,
        candidateArtifactId: impactPlanArtifact.id,
      });
      canonicalWorldlineId = accepted.canonicalWorldline.id;
      childWorldlineId = accepted.worldline.id;
      const worldlinesAfter = listProjectWorldlines(project.id);
      worldlineStage = {
        status: "succeeded",
        mode: "open",
        anchorCount: accepted.acceptedArtifact.impactPlan.anchors.length,
        durationMs: elapsedMilliseconds(startedAt),
        worldlinesBefore,
        worldlinesAfter: worldlinesAfter.length,
        canonicalWorldlineCreated: Boolean(
          getWorldline(canonicalWorldlineId),
        ),
        childWorldlineActive:
          getWorldline(childWorldlineId)?.status === "active",
        acceptedArtifactPersisted: Boolean(
          getImpactPlanArtifact(accepted.acceptedArtifact.id),
        ),
        failureCode: null,
      };
    } catch (error) {
      worldlineStage = {
        status: "failed",
        mode: "open",
        anchorCount: null,
        durationMs: elapsedMilliseconds(startedAt),
        worldlinesBefore,
        worldlinesAfter: listProjectWorldlines(project.id).length,
        canonicalWorldlineCreated: false,
        childWorldlineActive: false,
        acceptedArtifactPersisted: false,
        failureCode: safeFailureCode(error),
      };
    }
  }
  if (!canonicalWorldlineId || !childWorldlineId) {
    return {
      story: {
        ...failedStory(target.storyClass, worldlineStage.failureCode),
        confirmedStoryMapMatched: true,
        storyMapProvisioning: provisioning,
        suggestions: suggestionsStage,
        impactPlan: impactPlanStage,
        worldline: worldlineStage,
      },
      archive: null,
    };
  }

  const canonicalSnapshot = JSON.stringify(getWorldline(canonicalWorldlineId));
  const siblingSnapshot = listProjectWorldlines(project.id)
    .filter(
      (worldline) =>
        worldline.id !== canonicalWorldlineId &&
        worldline.id !== childWorldlineId,
    )
    .map((worldline) => JSON.stringify(worldline));

  // ── 5. 3 个 Continuation directions（continuation.v1）──
  let directionsStage: M1ContinuationStory["directions"];
  let directionsArtifact:
    | Awaited<ReturnType<typeof generateContinuationDirections>>["artifact"]
    | undefined;
  {
    const startedAt = performance.now();
    const observationStart = provider.observations.length;
    try {
      const result = await generateContinuationDirections({
        projectId: project.id,
        worldlineId: childWorldlineId,
        provider,
        modelConfig: config.modelConfig,
      });
      directionsArtifact = result.artifact;
      const titles = new Set(
        result.artifact.continuation.directions.map(
          (direction) => direction.title,
        ),
      );
      directionsStage = {
        ...successfulStage(
          result.generation,
          "continuation.v1",
          elapsedMilliseconds(startedAt),
          provider.observations.slice(observationStart),
        ),
        directionCount: result.artifact.continuation.directions.length,
        distinctTitleCount: titles.size,
        selectedDirectionIndex: 0,
        selectedAffectedCharacterCount:
          result.artifact.continuation.directions[0].affectedCharacterIds
            .length,
      };
    } catch (error) {
      directionsStage = {
        ...failedStage(
          "continuation.v1",
          elapsedMilliseconds(startedAt),
          provider.observations.slice(observationStart),
          error,
        ),
        directionCount: null,
        distinctTitleCount: null,
        selectedDirectionIndex: null,
        selectedAffectedCharacterCount: null,
      };
    }
  }
  if (!directionsArtifact) {
    return {
      story: {
        ...failedStory(target.storyClass, directionsStage.failureCode),
        confirmedStoryMapMatched: true,
        storyMapProvisioning: provisioning,
        suggestions: suggestionsStage,
        impactPlan: impactPlanStage,
        worldline: worldlineStage,
        directions: directionsStage,
      },
      archive: null,
    };
  }

  // ── 6. 1 个 scene（continuation.v2，direction[0]）──
  let sceneStage: SceneStage;
  let sceneArtifact:
    | Awaited<ReturnType<typeof generateContinuationScene>>["artifact"]
    | undefined;
  {
    const selectedDirectionId =
      directionsArtifact.continuation.directions[0].id;
    const startedAt = performance.now();
    const observationStart = provider.observations.length;
    try {
      const result = await generateContinuationScene({
        projectId: project.id,
        worldlineId: childWorldlineId,
        directionsArtifactId: directionsArtifact.id,
        selectedDirectionId,
        provider,
        modelConfig: config.modelConfig,
      });
      sceneArtifact = result.artifact;
      const scene = sceneArtifact.continuation;
      const currentState = deriveWorldlineDelta({
        worldline: getWorldline(childWorldlineId)!,
        impactPlan: getImpactPlanArtifact(
          sceneArtifact.continuation.acceptedImpactPlanId,
        )!.impactPlan,
        storyMap: confirmedArtifact.storyMap,
      });
      const divergenceEventId =
        getWorldline(childWorldlineId)!.divergence?.eventId;
      const consistencyIssues = divergenceEventId
        ? validateContinuationStatePatch(
            scene.statePatch,
            currentState,
            confirmedArtifact.storyMap,
            divergenceEventId,
            getWorldline(childWorldlineId)!.anchors.map(
              (anchor) => anchor.targetEventId,
            ),
          )
        : [];
      const consistency = summarizeConsistency(consistencyIssues);
      const proseTotalChars = [...scene.prose].length;
      const proseCjkChars = countHanCharacters(scene.prose);
      sceneStage = {
        ...successfulStage(
          result.generation,
          "continuation.v2",
          elapsedMilliseconds(startedAt),
          provider.observations.slice(observationStart),
        ),
        proseTotalChars,
        proseCjkChars,
        proseWithinTargetRange: proseCjkChars >= 1200 && proseCjkChars <= 2000,
        statePatch: {
          factsAddedCount: scene.statePatch.factsAdded.length,
          factsRemovedCount: scene.statePatch.factsRemoved.length,
          characterChangesCount: scene.statePatch.characterChanges.length,
          threadsOpenedCount: scene.statePatch.threadsOpened.length,
          threadsClosedCount: scene.statePatch.threadsClosed.length,
        },
        consistency,
      };
    } catch (error) {
      sceneStage = {
        ...failedStage(
          "continuation.v2",
          elapsedMilliseconds(startedAt),
          provider.observations.slice(observationStart),
          error,
        ),
        proseTotalChars: null,
        proseCjkChars: null,
        proseWithinTargetRange: null,
        statePatch: null,
        consistency: null,
      };
    }
  }
  if (!sceneArtifact) {
    return {
      story: {
        ...failedStory(target.storyClass, sceneStage.failureCode),
        confirmedStoryMapMatched: true,
        storyMapProvisioning: provisioning,
        suggestions: suggestionsStage,
        impactPlan: impactPlanStage,
        worldline: worldlineStage,
        directions: directionsStage,
        scene: sceneStage,
      },
      archive: null,
    };
  }

  // ── 7. Worldline 隔离校验 ──
  const isolation: IsolationChecks = {
    sourceContentHashUnchanged:
      JSON.stringify(getProjectSource(project.id, source.id)) ===
      sourceSnapshot,
    storyMapArtifactUnchanged:
      JSON.stringify(getStoryMapArtifact(confirmedArtifact.id)) ===
      storyMapSnapshot,
    canonicalWorldlineUnchanged:
      JSON.stringify(getWorldline(canonicalWorldlineId)) ===
      canonicalSnapshot,
    siblingWorldlinesUnchanged:
      JSON.stringify(
        listProjectWorldlines(project.id)
          .filter(
            (worldline) =>
              worldline.id !== canonicalWorldlineId &&
              worldline.id !== childWorldlineId,
          )
          .map((worldline) => JSON.stringify(worldline)),
      ) === JSON.stringify(siblingSnapshot),
    worldlineCountExpected:
      listProjectWorldlines(project.id).length === worldlinesBefore + 2,
  };

  const completed = Boolean(
    sceneStage.consistency?.hardGatePassed &&
      Object.values(isolation).every(Boolean),
  );

  const story: M1ContinuationStory = {
    storyClass: target.storyClass,
    status: completed ? "completed" : "failed",
    confirmedStoryMapMatched: true,
    storyMapProvisioning: provisioning,
    suggestions: suggestionsStage,
    impactPlan: impactPlanStage,
    worldline: worldlineStage,
    directions: directionsStage,
    scene: sceneStage,
    isolation,
    humanReview: {
      worldlineConsistency: null,
      characterContinuity: null,
      narrativeContinuity: null,
      sceneInterest: null,
      wouldContinueReading: null,
      status: "awaiting_human_review",
    },
  };

  const archive = completed
    ? buildPrivateSceneArchive({
        storyClass: target.storyClass,
        evaluatedAt,
        commitSha,
        model,
        structuredOutputMode,
        sourceSnapshot: confirmedArtifact.storyMap,
        provisioning,
        suggestion: suggestionsArtifact.suggestions[0],
        acceptedImpactPlan: impactPlanArtifact,
        worldline: getWorldline(childWorldlineId)!,
        directionsArtifact,
        sceneArtifact,
        proseTotalChars: sceneStage.proseTotalChars ?? 0,
        proseCjkChars: sceneStage.proseCjkChars ?? 0,
        proseWithinTargetRange: sceneStage.proseWithinTargetRange ?? false,
        consistencyHardGatePassed:
          sceneStage.consistency?.hardGatePassed ?? false,
        worldlineIsolationVerified:
          Object.values(isolation).every(Boolean),
      })
    : null;

  return { story, archive };
}

function summarizeConsistency(
  issues: Array<{ path: string; message: string }>,
): SceneStage["consistency"] {
  const counts = {
    resurrectedRemovedFacts: 0,
    deletedAcceptedFacts: 0,
    preDivergenceMutation: 0,
    anchorDeletion: 0,
    invalidCharacter: 0,
    invalidThread: 0,
    otherViolations: 0,
  };
  for (const issue of issues) {
    if (issue.message.includes("不得恢复已删除事实")) {
      counts.resurrectedRemovedFacts += 1;
    } else if (issue.message.includes("不得删除 accepted ImpactPlan")) {
      counts.deletedAcceptedFacts += 1;
    } else if (issue.message.includes("不得删除分歧前 Canon 事实")) {
      counts.preDivergenceMutation += 1;
    } else if (issue.message.includes("不得删除严格模式 Anchor 目标")) {
      counts.anchorDeletion += 1;
    } else if (issue.message.includes("引用了未知人物")) {
      counts.invalidCharacter += 1;
    } else if (
      issue.message.includes("不能重复开启当前线索") ||
      issue.message.includes("不能关闭尚未开启的线索")
    ) {
      counts.invalidThread += 1;
    } else {
      counts.otherViolations += 1;
    }
  }
  return {
    resurrectedRemovedFacts: counts.resurrectedRemovedFacts === 0,
    deletedAcceptedFacts: counts.deletedAcceptedFacts === 0,
    preDivergenceMutation: counts.preDivergenceMutation === 0,
    anchorDeletion: counts.anchorDeletion === 0,
    invalidCharacter: counts.invalidCharacter === 0,
    invalidThread: counts.invalidThread === 0,
    otherViolations: counts.otherViolations,
    hardGatePassed:
      counts.otherViolations === 0 &&
      Object.entries(counts)
        .filter(([key]) => key !== "otherViolations")
        .every(([, value]) => value === 0),
  };
}

function countHanCharacters(value: string): number {
  return (value.match(/\p{Script=Han}/gu) ?? []).length;
}

function buildPrivateSceneArchive(input: {
  storyClass: "A" | "B" | "C";
  evaluatedAt: string;
  commitSha: string;
  model: string;
  structuredOutputMode: string;
  sourceSnapshot: StoryMap;
  provisioning: StoryMapProvisioning;
  suggestion: {
    divergenceType: "prevent" | "choice" | "outcome";
    instruction: string;
  };
  acceptedImpactPlan: ImpactPlanArtifact;
  worldline: Worldline;
  directionsArtifact: ContinuationDirectionsArtifact;
  sceneArtifact: ContinuationSceneArtifact;
  proseTotalChars: number;
  proseCjkChars: number;
  proseWithinTargetRange: boolean;
  consistencyHardGatePassed: boolean;
  worldlineIsolationVerified: boolean;
}): PrivateSceneArchive {
  const storyMap = input.sourceSnapshot;
  const characterNames = new Map(
    storyMap.characters.map((character) => [character.id, character.name]),
  );
  const plan = input.acceptedImpactPlan.impactPlan;
  const deltaFactsRemoved: string[] = [];
  for (const impact of plan.impacts) {
    if (
      impact.affectedEventId &&
      (impact.changeType === "removed" || impact.changeType === "modified")
    ) {
      deltaFactsRemoved.push(`event:${impact.affectedEventId}`);
    }
  }
  deltaFactsRemoved.push(`event:${plan.divergence.eventId}`);
  const scene = input.sceneArtifact.continuation;
  return {
    storyClass: input.storyClass,
    evaluatedAt: input.evaluatedAt,
    commitSha: input.commitSha,
    provider: "openai-compatible",
    model: input.model,
    structuredOutputMode: input.structuredOutputMode,
    storyMap: {
      provisioning: input.provisioning.status,
      version: input.provisioning.finalVersion ?? 0,
      characterCount: storyMap.characters.length,
      eventCount: storyMap.events.length,
      edgeCount: storyMap.edges.length,
      endingCandidateCount: storyMap.endingCandidates.length,
    },
    divergence: {
      source: "ripple-suggestions.v3 suggestion[0]",
      type: input.suggestion.divergenceType,
      instruction: input.suggestion.instruction,
    },
    acceptedImpactPlan: {
      impactCount: plan.impacts.length,
      characterChangesCount: plan.characterChanges.length,
      threadsOpenedCount: plan.threadChanges.opened.length,
      threadsClosedCount: plan.threadChanges.closed.length,
      factsRemovedKeys: [...new Set(deltaFactsRemoved)],
      factsAddedStatements: [
        ...(plan.divergence.type === "prevent"
          ? []
          : [plan.divergence.instruction]),
        ...plan.impacts
          .filter(
            (impact) =>
              impact.changeType === "added" || impact.changeType === "modified",
          )
          .map((impact) => impact.summary),
      ],
    },
    directions: input.directionsArtifact.continuation.directions.map(
      (direction) => ({
        title: direction.title,
        premise: direction.premise,
        affectedCharacterNames: direction.affectedCharacterIds.map(
          (id) => characterNames.get(id) ?? id,
        ),
        expectedConsequence: direction.expectedConsequence,
      }),
    ),
    selectedDirectionIndex: 0,
    scene: {
      title: scene.title,
      prose: scene.prose,
      statePatch: {
        factsAdded: scene.statePatch.factsAdded.map((fact) => ({
          key: fact.key,
          statement: fact.statement,
        })),
        factsRemoved: scene.statePatch.factsRemoved,
        characterChanges: scene.statePatch.characterChanges.map((change) => ({
          characterName:
            characterNames.get(change.characterId) ?? change.characterId,
          change: change as unknown as Record<string, unknown>,
        })),
        threadsOpened: scene.statePatch.threadsOpened,
        threadsClosed: scene.statePatch.threadsClosed,
      },
    },
    automaticChecks: {
      proseTotalChars: input.proseTotalChars,
      proseCjkChars: input.proseCjkChars,
      proseWithinTargetRange: input.proseWithinTargetRange,
      consistencyHardGatePassed: input.consistencyHardGatePassed,
      schemaValidated: true,
      worldlineIsolationVerified: input.worldlineIsolationVerified,
    },
  };
}

function successfulStage(
  generation: {
    attemptCount: 1 | 2;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  } | null,
  promptVersion: string,
  durationMs: number,
  observations: ProviderObservation[],
): GenerationStage {
  const usage = summarizeProviderObservations(observations);
  const attemptCount = (generation?.attemptCount ??
    (observations.length === 1 || observations.length === 2
      ? observations.length
      : null)) as 1 | 2 | null;
  return {
    status: "succeeded",
    promptVersion,
    durationMs,
    attemptCount,
    inputTokens: usage.inputTokens ?? generation?.usage?.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? generation?.usage?.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? generation?.usage?.totalTokens ?? null,
    artifactCreated: true,
    failureCode: null,
  };
}

function failedStage(
  promptVersion: string,
  durationMs: number,
  observations: ProviderObservation[],
  error: unknown,
): GenerationStage {
  const usage = summarizeProviderObservations(observations);
  return {
    status: "failed",
    promptVersion,
    durationMs,
    attemptCount:
      observations.length === 2 ? 2 : observations.length === 1 ? 1 : null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    artifactCreated: false,
    failureCode: safeFailureCode(error),
  };
}

function notRunStage(promptVersion: string): GenerationStage {
  return {
    status: "not_run",
    promptVersion,
    durationMs: 0,
    attemptCount: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    artifactCreated: false,
    failureCode: "dependency_failed",
  };
}

function failedStory(
  storyClass: "A" | "B" | "C",
  failureCode: string | null,
): M1ContinuationStory {
  return {
    storyClass,
    status: "failed",
    confirmedStoryMapMatched: false,
    storyMapProvisioning: {
      status: "failed",
      baselineConfirmedVersion: null,
      draftVersionConfirmed: null,
      reviewOperationsApplied: 0,
      finalVersion: null,
      failureCode: failureCode ?? "pipeline_failed",
    },
    suggestions: {
      ...notRunStage("ripple-suggestions.v3"),
      suggestionCount: null,
      selectedSuggestionIndex: null,
    },
    impactPlan: notRunStage("impact-plan.v3"),
    worldline: {
      status: "not_run",
      mode: null,
      anchorCount: null,
      durationMs: 0,
      worldlinesBefore: null,
      worldlinesAfter: null,
      canonicalWorldlineCreated: false,
      childWorldlineActive: false,
      acceptedArtifactPersisted: false,
      failureCode: failureCode ?? "pipeline_failed",
    },
    directions: {
      ...notRunStage("continuation.v1"),
      directionCount: null,
      distinctTitleCount: null,
      selectedDirectionIndex: null,
      selectedAffectedCharacterCount: null,
    },
    scene: {
      ...notRunStage("continuation.v2"),
      proseTotalChars: null,
      proseCjkChars: null,
      proseWithinTargetRange: null,
      statePatch: null,
      consistency: null,
    },
    isolation: {
      sourceContentHashUnchanged: false,
      storyMapArtifactUnchanged: false,
      canonicalWorldlineUnchanged: false,
      siblingWorldlinesUnchanged: false,
      worldlineCountExpected: false,
    },
    humanReview: {
      worldlineConsistency: null,
      characterContinuity: null,
      narrativeContinuity: null,
      sceneInterest: null,
      wouldContinueReading: null,
      status: "awaiting_human_review",
    },
  };
}

async function loadBenchmarkTargets(
  manifestPaths: string[],
): Promise<BenchmarkTarget[]> {
  const jsonSchema = JSON.parse(
    await readFile(manifestSchemaPath, "utf8"),
  ) as unknown;
  const targets: BenchmarkTarget[] = [];
  for (const suppliedPath of manifestPaths) {
    const manifestPath = await realpath(path.resolve(suppliedPath));
    if (!manifestPath.split(path.sep).includes("private")) {
      throw new EvaluationSetupError("private_manifest_required");
    }
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sourcePath?: unknown;
    };
    if (typeof raw.sourcePath !== "string") {
      throw new EvaluationSetupError("manifest_invalid");
    }
    const sourcePath = await realpath(
      path.resolve(path.dirname(manifestPath), raw.sourcePath),
    );
    if (!isInside(path.dirname(manifestPath), sourcePath)) {
      throw new EvaluationSetupError("source_outside_story_directory");
    }
    const sourceBytes = await readFile(sourcePath);
    const prepared = prepareSourceImport({
      fileName: path.basename(sourcePath),
      bytes: sourceBytes,
    });
    const manifest = validateM1BenchmarkManifest({
      value: raw,
      jsonSchema,
      actualCharacterCount: countBenchmarkCharacters(prepared.normalizedText),
    });
    if (manifest.visibility !== "private") {
      throw new EvaluationSetupError("private_manifest_required");
    }
    targets.push({
      storyClass: manifest.storyClass,
      contentHash: prepared.contentHash,
    });
  }
  if (
    targets.length !== 3 ||
    new Set(targets.map((target) => target.storyClass)).size !== 3
  ) {
    throw new EvaluationSetupError("story_a_b_c_required");
  }
  return targets;
}

function parseArguments(): {
  baselineDb: string;
  manifestPaths: string[];
  scenesDir: string | undefined;
} {
  const { values } = parseArgs({
    options: {
      "baseline-db": { type: "string" },
      manifest: { type: "string", multiple: true },
      "scenes-dir": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values["baseline-db"] || (values.manifest?.length ?? 0) !== 3) {
    throw new EvaluationSetupError("baseline_db_and_three_manifests_required");
  }
  return {
    baselineDb: path.resolve(values["baseline-db"]),
    manifestPaths: values.manifest ?? [],
    scenesDir: values["scenes-dir"]
      ? path.resolve(values["scenes-dir"])
      : undefined,
  };
}

async function backupDatabase(sourcePath: string, destinationPath: string) {
  const resolvedSource = await realpath(sourcePath);
  const source = new Database(resolvedSource, { readonly: true });
  try {
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
}

async function readCommitSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  const value = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new EvaluationSetupError("commit_sha_unavailable");
  }
  return value;
}

function createRunId(evaluatedAt: string, commitSha: string): string {
  return `${evaluatedAt.replace(/[-:.TZ]/g, "")}-${commitSha.slice(0, 7)}-${randomUUID().slice(0, 8)}`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function safeFailureCode(error: unknown): string {
  if (error instanceof EvaluationSetupError) return error.code;
  if (error instanceof Error && error.name === "StructuredGenerationError") {
    return "schema_or_domain_validation_failed";
  }
  return "pipeline_failed";
}

async function writePrivateSceneArchives(
  scenesDir: string | undefined,
  runId: string,
  evaluatedAt: string,
  commitSha: string,
  model: string,
  structuredOutputMode: string,
  archives: PrivateSceneArchive[],
): Promise<void> {
  if (!scenesDir || archives.length === 0) return;
  await mkdir(scenesDir, { recursive: true });
  for (const archive of archives) {
    const content = [
      "# M1-06 Continuation Scene 存档（本地私有 · 严禁进入 Git / 公开报告）",
      "",
      `- runId：${runId}`,
      `- evaluatedAt：${evaluatedAt}`,
      `- commitSha：${commitSha}`,
      `- provider：${archive.provider} / model：${archive.model} / structuredOutputMode：${archive.structuredOutputMode}`,
      "",
      "## Story Map",
      "",
      `- provisioning：${archive.storyMap.provisioning}（finalVersion=${archive.storyMap.version}）`,
      `- 结构：人物 ${archive.storyMap.characterCount} / 事件 ${archive.storyMap.eventCount} / 边 ${archive.storyMap.edgeCount} / Ending Candidate ${archive.storyMap.endingCandidateCount}`,
      "",
      "## Divergence（ripple-suggestions.v3 的 suggestion[0]，open 模式，0 Anchor）",
      "",
      `- type：${archive.divergence.type}`,
      `- instruction：${archive.divergence.instruction}`,
      "",
      "## Accepted Impact Plan 摘要",
      "",
      `- impacts：${archive.acceptedImpactPlan.impactCount} / characterChanges：${archive.acceptedImpactPlan.characterChangesCount} / threadsOpened：${archive.acceptedImpactPlan.threadsOpenedCount} / threadsClosed：${archive.acceptedImpactPlan.threadsClosedCount}`,
      "- factsRemoved keys（派生 Delta）：",
      ...archive.acceptedImpactPlan.factsRemovedKeys.map((key) => `  - ${key}`),
      "- factsAdded statements（派生 Delta）：",
      ...archive.acceptedImpactPlan.factsAddedStatements.map(
        (statement) => `  - ${statement}`,
      ),
      "",
      "## 3 个 Directions（continuation.v1）",
      "",
      ...archive.directions.flatMap((direction, index) => [
        `### direction ${index}${index === archive.selectedDirectionIndex ? "（被选中）" : ""}`,
        `- title：${direction.title}`,
        `- premise：${direction.premise}`,
        `- affectedCharacters：${direction.affectedCharacterNames.join("、")}`,
        `- expectedConsequence：${direction.expectedConsequence}`,
        "",
      ]),
      "## Scene（continuation.v2）",
      "",
      `- title：${archive.scene.title}`,
      "",
      "### prose（全文）",
      "",
      archive.scene.prose,
      "",
      "### statePatch",
      "",
      "- factsAdded：",
      ...archive.scene.statePatch.factsAdded.map(
        (fact) => `  - ${fact.key}：${fact.statement}`,
      ),
      "- factsRemoved：",
      ...archive.scene.statePatch.factsRemoved.map((key) => `  - ${key}`),
      "- characterChanges：",
      ...archive.scene.statePatch.characterChanges.map(
        (entry) =>
          `  - ${entry.characterName}：${JSON.stringify(entry.change)}`,
      ),
      "- threadsOpened：",
      ...archive.scene.statePatch.threadsOpened.map((thread) => `  - ${thread}`),
      "- threadsClosed：",
      ...archive.scene.statePatch.threadsClosed.map((thread) => `  - ${thread}`),
      "",
      "## 自动校验结果",
      "",
      `- proseTotalChars：${archive.automaticChecks.proseTotalChars} / proseCjkChars：${archive.automaticChecks.proseCjkChars} / withinTargetRange(1200-2000 中文字符)：${archive.automaticChecks.proseWithinTargetRange}`,
      `- statePatch 六项一致性硬门：${archive.automaticChecks.consistencyHardGatePassed ? "PASS" : "FAIL"}`,
      `- Schema 校验：${archive.automaticChecks.schemaValidated ? "PASS" : "FAIL"}`,
      `- Worldline 隔离：${archive.automaticChecks.worldlineIsolationVerified ? "PASS" : "FAIL"}`,
      "",
    ].join("\n");
    const outputPath = path.join(scenesDir, `m1-06-story-${archive.storyClass}.md`);
    await writeFile(outputPath, content, "utf8");
    console.log(`私有场景存档：${outputPath}`);
  }
}

function printReport(value: M1ContinuationReport, outputPath: string) {
  console.log("NovelRipple M1 Continuation benchmark");
  console.log(`Run: ${value.runId}`);
  console.log(`Status: ${value.status}`);
  for (const story of value.stories) {
    console.log(
      `Story ${story.storyClass}: ${story.status}; storyMap=${story.storyMapProvisioning.status}(v${story.storyMapProvisioning.finalVersion ?? "?"}); directions=${story.directions.directionCount ?? "not_created"}; sceneAttempts=${story.scene.attemptCount ?? "not_run"}; proseCjk=${story.scene.proseCjkChars ?? "n/a"}; hardGate=${story.scene.consistency?.hardGatePassed ?? "n/a"}; totalTokens=${sumTokens(story)}; wallMs=${sumDuration(story)}`,
    );
  }
  console.log(`Sanitized JSON: ${outputPath}`);
  console.log("Human review: score the private scene archives (worldline/character/narrative/scene-interest 1-5 + would-continue-reading) without copying story text.");
}

function sumTokens(story: M1ContinuationStory): number | "unreported" {
  const values = [
    story.suggestions.totalTokens,
    story.impactPlan.totalTokens,
    story.directions.totalTokens,
    story.scene.totalTokens,
  ];
  return values.every((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : "unreported";
}

function sumDuration(story: M1ContinuationStory): number {
  return (
    story.suggestions.durationMs +
    story.impactPlan.durationMs +
    story.worldline.durationMs +
    story.directions.durationMs +
    story.scene.durationMs
  );
}
