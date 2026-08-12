import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  M0LiveEvalFailureReportSchema,
  M0LiveEvalSuccessReportSchema,
  evaluateM0ReleaseGate,
  scoreContinuationStatePatch,
  scoreFixtureImpactPlan,
  scoreFixtureStoryMap,
  type ContinuationEvalScore,
  type ImpactPlanEvalScore,
  type M0LiveEvalFailedStage,
  type M0LiveEvalReport,
  type StoryMapEvalScore,
} from "../src/evals/m0-live-eval";
import { deriveWorldlineDelta } from "../src/domain/invariants/validate-continuation";
import {
  createConfiguredAIProvider,
  readConfiguredAI,
} from "../src/server/ai/configured-runtime";
import { generateContinuationDirections, generateContinuationScene } from "../src/server/continuation/generate-continuation";
import { closeDatabase, getDatabase } from "../src/server/db/client";
import { loadRippleFixture } from "../src/server/fixtures/load-ripple-fixture";
import { generateImpactPlan } from "../src/server/ripple/generate-impact-plan";
import { generateStoryMap } from "../src/server/story-map/generate-story-map";
import { listProjectGenerationRuns } from "../src/server/repositories/generation-run-repository";
import {
  createProject,
  importProjectSource,
} from "../src/server/repositories/project-repository";
import { acceptImpactPlan } from "../src/server/repositories/ripple-repository";
import { confirmStoryMapArtifact } from "../src/server/repositories/story-map-artifact-repository";

const evaluatedAt = new Date().toISOString();
const reportPath = path.resolve(
  process.env.LIVE_EVAL_REPORT_PATH ??
    path.join(".data", "evals", "m0-live-eval.json"),
);
const previousDatabasePath = process.env.DB_FILE_NAME;
let temporaryDirectory: string | undefined;
let providerName = process.env.AI_PROVIDER_NAME?.trim() || "unconfigured";
let model = process.env.OPENAI_MODEL?.trim() || "unconfigured";
let report: M0LiveEvalReport;
let failedStage: M0LiveEvalFailedStage = "configuration";
let liveEvalProjectId: string | undefined;
let observedPromptVersions: Array<{ kind: string; version: string }> = [];
let partialStoryMap: StoryMapEvalScore | undefined;
const partialImpacts: ImpactPlanEvalScore[] = [];
let partialContinuation: ContinuationEvalScore | undefined;

try {
  const config = readConfiguredAI();
  providerName = config.providerName;
  model = config.modelConfig.model;
  if (config.providerName !== "openai-compatible") {
    throw new Error(
      "Live Eval 必须显式配置真实 openai-compatible 供应商，Mock 不属于 Live Eval",
    );
  }
  const provider = createConfiguredAIProvider(config);
  failedStage = "setup";
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-live-eval-"),
  );
  process.env.DB_FILE_NAME = path.join(temporaryDirectory, "eval.db");
  closeDatabase();
  migrate(getDatabase(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });

  const fixture = await loadRippleFixture();
  const sourceBytes = await readFile(
    path.join(process.cwd(), "fixtures", "ripple-001", "source.md"),
  );
  const project = createProject({ title: `M0 Live Eval ${evaluatedAt}` });
  liveEvalProjectId = project.id;
  const imported = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: sourceBytes,
  });
  failedStage = "story_map";
  const generatedStoryMap = await generateStoryMap({
    projectId: project.id,
    sourceId: imported.source.id,
    provider,
    modelConfig: config.modelConfig,
  });
  const confirmedStoryMap = confirmStoryMapArtifact({
    projectId: project.id,
    artifactId: generatedStoryMap.artifact.id,
  });
  const storyMapScore = scoreFixtureStoryMap({
    goldenSource: fixture.source,
    candidateSource: imported.source,
    golden: fixture.storyMap,
    candidate: confirmedStoryMap.storyMap,
  });
  partialStoryMap = storyMapScore;

  const generatedImpactPlans = [];
  const impactScores = [];
  for (const expected of fixture.impactPlans) {
    failedStage = "impact_plan";
    const mappedDivergenceEvent =
      storyMapScore.eventIdMap[expected.divergence.eventId];
    if (!mappedDivergenceEvent) {
      throw new Error(
        `无法将分歧 ${expected.divergence.id} 映射到生成的 Story Map`,
      );
    }
    const endingCandidateIds = expected.anchors.map((anchor) => {
      const mappedTarget = storyMapScore.eventIdMap[anchor.targetEventId];
      const ending = confirmedStoryMap.storyMap.endingCandidates.find(
        (candidate) => candidate.targetEventId === mappedTarget,
      );
      if (!ending) {
        throw new Error(
          `无法将 ${expected.divergence.id} 的 Anchor 映射到 Ending Candidate`,
        );
      }
      return ending.id;
    });
    const generated = await generateImpactPlan({
      projectId: project.id,
      storyMapArtifactId: confirmedStoryMap.id,
      divergence: {
        ...expected.divergence,
        eventId: mappedDivergenceEvent,
      },
      mode: expected.mode,
      endingCandidateIds,
      provider,
      modelConfig: config.modelConfig,
    });
    generatedImpactPlans.push(generated);
    const impactScore = scoreFixtureImpactPlan({
        expected,
        candidate: generated.artifact.impactPlan,
        eventIdMap: storyMapScore.eventIdMap,
        storyMap: confirmedStoryMap.storyMap,
      });
    impactScores.push(impactScore);
    partialImpacts.push(impactScore);
  }

  const reroutedCandidate = generatedImpactPlans[0];
  if (!reroutedCandidate) throw new Error("缺少 rerouted Impact Plan 候选");
  failedStage = "worldline";
  const accepted = acceptImpactPlan({
    projectId: project.id,
    candidateArtifactId: reroutedCandidate.artifact.id,
  });
  const currentState = deriveWorldlineDelta({
    worldline: accepted.worldline,
    impactPlan: accepted.acceptedArtifact.impactPlan,
    storyMap: confirmedStoryMap.storyMap,
  });
  const divergenceEventId = accepted.worldline.divergence?.eventId;
  if (!divergenceEventId) {
    throw new Error("Live Eval Worldline 缺少 Divergence Event");
  }
  failedStage = "continuation_directions";
  const directions = await generateContinuationDirections({
    projectId: project.id,
    worldlineId: accepted.worldline.id,
    provider,
    modelConfig: config.modelConfig,
  });
  const selectedDirection = directions.artifact.continuation.directions[0];
  if (!selectedDirection) throw new Error("Continuation 未返回后续方向");
  failedStage = "continuation_scene";
  const scene = await generateContinuationScene({
    projectId: project.id,
    worldlineId: accepted.worldline.id,
    directionsArtifactId: directions.artifact.id,
    selectedDirectionId: selectedDirection.id,
    provider,
    modelConfig: config.modelConfig,
  });
  const continuationScore = scoreContinuationStatePatch({
    patch: scene.artifact.continuation.statePatch,
    currentState,
    storyMap: confirmedStoryMap.storyMap,
    divergenceEventId,
    protectedAnchorEventIds: accepted.worldline.anchors.map(
      (anchor) => anchor.targetEventId,
    ),
  });
  partialContinuation = continuationScore;
  failedStage = "release_gate";
  const releaseGate = evaluateM0ReleaseGate({
    storyMapScore,
    impactScores,
    continuationScore,
  });
  observedPromptVersions = uniquePromptVersions(
    listProjectGenerationRuns(project.id).map((run) => ({
      kind: run.kind,
      version: run.promptVersion,
    })),
  );

  report = M0LiveEvalSuccessReportSchema.parse({
    schemaVersion: 1,
    fixtureId: "ripple-001",
    evaluatedAt,
    provider: providerName,
    model,
    status: "completed",
    promptVersions: observedPromptVersions,
    storyMap: storyMapScore,
    impacts: impactScores,
    continuation: continuationScore,
    deterministicScope: {
      hallucination:
        "invalid domain references or missing valid Source Evidence",
      continuation: "statePatch against the accepted Worldline Delta",
    },
    releaseGate,
  });
} catch (error) {
  if (liveEvalProjectId) {
    try {
      observedPromptVersions = uniquePromptVersions(
        listProjectGenerationRuns(liveEvalProjectId).map((run) => ({
          kind: run.kind,
          version: run.promptVersion,
        })),
      );
    } catch {
      // Failure diagnostics must never hide the original pipeline error.
    }
  }
  report = M0LiveEvalFailureReportSchema.parse({
    schemaVersion: 1,
    fixtureId: "ripple-001",
    evaluatedAt,
    provider: providerName,
    model,
    status: "failed",
    failedStage,
    promptVersions: observedPromptVersions,
    partial: {
      storyMap: partialStoryMap,
      impacts: partialImpacts,
      continuation: partialContinuation,
    },
    error: errorMessage(error),
  });
} finally {
  closeDatabase();
  if (previousDatabasePath === undefined) delete process.env.DB_FILE_NAME;
  else process.env.DB_FILE_NAME = previousDatabasePath;
  if (temporaryDirectory) {
    const resolvedTemporaryDirectory = path.resolve(temporaryDirectory);
    const resolvedSystemTemp = path.resolve(tmpdir());
    if (
      path.dirname(resolvedTemporaryDirectory) !== resolvedSystemTemp ||
      !path.basename(resolvedTemporaryDirectory).startsWith(
        "novelripple-live-eval-",
      )
    ) {
      throw new Error("拒绝清理不属于 Live Eval 的目录");
    }
    await rm(resolvedTemporaryDirectory, { recursive: true });
  }
}

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
printReport(report, reportPath);
if (report.status === "failed" || !report.releaseGate.passed) {
  process.exitCode = 1;
}

function uniquePromptVersions(
  versions: Array<{ kind: string; version: string }>,
): Array<{ kind: string; version: string }> {
  const unique = new Map<string, { kind: string; version: string }>();
  for (const value of versions) {
    unique.set(`${value.kind}:${value.version}`, value);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.version.localeCompare(right.version),
  );
}

function printReport(value: M0LiveEvalReport, outputPath: string): void {
  console.log("NovelRipple M0 Live Eval · ripple-001");
  console.log(`Provider/model: ${value.provider}/${value.model}`);
  if (value.status === "failed") {
    console.log(`Status: FAILED at ${value.failedStage} · ${value.error}`);
    console.log(
      `Prompt versions: ${value.promptVersions
        .map((prompt) => `${prompt.kind}=${prompt.version}`)
        .join(", ") || "none completed"}`,
    );
    if (value.partial.storyMap) printStoryMapScore(value.partial.storyMap);
    if (value.partial.impacts.length > 0) printImpactScores(value.partial.impacts);
    if (value.partial.continuation) {
      printContinuationScore(value.partial.continuation);
    }
    console.log(`JSON: ${outputPath}`);
    return;
  }

  console.log(
    `Prompt versions: ${value.promptVersions
      .map((prompt) => `${prompt.kind}=${prompt.version}`)
      .join(", ")}`,
  );
  printStoryMapScore(value.storyMap);
  printImpactScores(value.impacts);
  printContinuationScore(value.continuation);
  console.log(
    `Release gate: ${value.releaseGate.passed ? "PASS" : "FAIL"}`,
  );
  for (const failure of value.releaseGate.failures) console.log(`- ${failure}`);
  console.log(`JSON: ${outputPath}`);
}

function printStoryMapScore(value: StoryMapEvalScore): void {
  console.log(`Event recall: ${formatRate(value.eventRecall)}`);
  console.log(`Character recall: ${formatRate(value.characterRecall)}`);
  console.log(`Evidence validity: ${formatRate(value.evidenceValidity)}`);
  console.log(
    `Invalid/hallucinated events (deterministic): ${value.invalidOrHallucinatedEvents.map((event) => event.eventId).join(", ") || "none"}`,
  );
  console.log(
    `Source-backed unmatched events (manual review): ${value.unmatchedSourceBackedEventIds.join(", ") || "none"}`,
  );
}

function printImpactScores(values: ImpactPlanEvalScore[]): void {
  console.log(
    `Expected direct impact hit rate: ${values
      .map(
        (impact) =>
          `${impact.divergenceId}=${formatRate(impact.directImpactHitRate)}`,
      )
      .join(", ")}`,
  );
  console.log(
    `reasonPath contract: ${values
      .map(
        (impact) =>
          `${impact.divergenceId}=${impact.reasonPathContract.passed ? "PASS" : "FAIL"}`,
      )
      .join(", ")}`,
  );
  console.log(
    `Anchor result: ${values
      .map(
        (impact) =>
          `${impact.divergenceId}=${impact.anchorResult.actualStatuses.join("+") || "none"}`,
      )
      .join(", ")}`,
  );
}

function printContinuationScore(value: ContinuationEvalScore): void {
  console.log(
    `Continuation contradiction (statePatch): ${value.contradictionDetected ? "detected" : "none"}`,
  );
}

function formatRate(score: {
  matched: number;
  total: number;
  rate: number;
}): string {
  return `${score.matched}/${score.total} (${(score.rate * 100).toFixed(1)}%)`;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown Live Eval failure").slice(
    0,
    2_000,
  );
}
