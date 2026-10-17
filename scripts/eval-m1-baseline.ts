import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import {
  BenchmarkRootError,
  isPathInside,
  resolveBenchmarkRoot,
  type BenchmarkRootSelection,
} from "../src/evals/benchmark-root";
import {
  M1BaselineArgumentError,
  parseM1BaselineArguments,
} from "../src/evals/m1-baseline-arguments";
import {
  InstrumentedAIProvider,
  M1BaselineStoryReportSchema,
  M1BaselineSuiteReportSchema,
  assertM1BaselineSuite,
  countBenchmarkCharacters,
  scoreM1StoryMapCandidate,
  summarizeProviderObservations,
  summarizeStoryMapValidation,
  validateM1BenchmarkManifest,
  type M1BaselineSuiteReport,
  type M1BenchmarkManifest,
} from "../src/evals/m1-baseline";
import { parseM1Gold, type M1Gold } from "../src/evals/m1-gold";
import type { M1GoldMatch } from "../src/evals/m1-gold-matcher";
import {
  createConfiguredAIProvider,
  readConfiguredAI,
  type ConfiguredAI,
} from "../src/server/ai/configured-runtime";
import { closeDatabase, getDatabase } from "../src/server/db/client";
import { listProjectGenerationRuns } from "../src/server/repositories/generation-run-repository";
import {
  createProject,
  importProjectSource,
} from "../src/server/repositories/project-repository";
import { generateStoryMap } from "../src/server/story-map/generate-story-map";

type LoadedBenchmark = {
  manifest: M1BenchmarkManifest;
  sourceBytes: Uint8Array;
  fileName: string;
  gold: M1Gold | null;
};

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const publicBenchmarkRoot = path.join(repositoryRoot, "benchmarks", "m1", "public");
const privateBenchmarkRoot = path.join(repositoryRoot, "benchmarks", "private");
const extraPrivateBenchmarkRoot = process.env.NOVELRIPPLE_BENCH_ROOT;
const manifestSchemaPath = path.join(
  repositoryRoot,
  "benchmarks",
  "m1",
  "manifest.schema.json",
);
const previousDatabasePath = process.env.DB_FILE_NAME;

class BaselineSetupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BaselineSetupError";
  }
}

let reportDirectory: string | undefined;
let report: M1BaselineSuiteReport | undefined;

try {
  const { manifestPaths, tuning } = parseM1BaselineArguments(
    process.argv.slice(2),
  );
  const jsonSchema = JSON.parse(await readFile(manifestSchemaPath, "utf8")) as unknown;
  const benchmarks: LoadedBenchmark[] = [];
  for (const manifestPath of manifestPaths) {
    benchmarks.push(
      await loadBenchmark(manifestPath, jsonSchema, extraPrivateBenchmarkRoot),
    );
  }
  if (!tuning) {
    assertM1BaselineSuite(benchmarks.map((item) => item.manifest));
  } else if (benchmarks.some((item) => item.manifest.unseenByPromptAuthors)) {
    // 调参运行不得使用 unseen 作品，否则它就不再是 unseen。
    throw new BaselineSetupError("tuning_must_not_use_unseen_story");
  }

  let config: ConfiguredAI;
  try {
    config = readConfiguredAI();
  } catch {
    throw new BaselineSetupError("provider_configuration_invalid");
  }
  if (config.providerName !== "openai-compatible") {
    throw new BaselineSetupError("real_provider_required");
  }
  const commitSha = await readCommitSha();
  const evaluatedAt = new Date().toISOString();
  const runId = createRunId(evaluatedAt, commitSha);
  reportDirectory = path.join(
    repositoryRoot,
    ".data",
    "evals",
    "m1-baseline",
    runId,
  );
  await mkdir(path.dirname(reportDirectory), { recursive: true });
  await mkdir(reportDirectory, { recursive: false });
  process.env.DB_FILE_NAME = path.join(reportDirectory, "eval.db");
  closeDatabase();
  migrate(getDatabase(), {
    migrationsFolder: path.join(repositoryRoot, "drizzle"),
  });

  const provider = createConfiguredAIProvider(config);
  const stories = [];
  for (const benchmark of benchmarks) {
    stories.push(await runStoryMapBaseline(benchmark, config, provider));
  }
  report = M1BaselineSuiteReportSchema.parse({
    schemaVersion: 1,
    kind: tuning ? "m1_tuning" : "m1_unoptimized_baseline",
    commitSha,
    evaluatedAt,
    status: stories.some((story) => story.status === "failed")
      ? "failed"
      : "awaiting_human_review",
    databaseFile: "eval.db",
    stories,
    privacy: {
      containsSourceBody: false,
      containsRawModelOutput: false,
      containsPrivateTitleOrNames: false,
    },
  });
} catch (error) {
  console.error(`M1 baseline 未运行：${safeFailureCode(error)}`);
  process.exitCode = 1;
} finally {
  closeDatabase();
  if (previousDatabasePath === undefined) delete process.env.DB_FILE_NAME;
  else process.env.DB_FILE_NAME = previousDatabasePath;
}

if (report && reportDirectory) {
  const reportPath = path.join(reportDirectory, "metrics.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printReport(report, reportPath);
  if (report.status === "failed") process.exitCode = 1;
}

async function loadBenchmark(
  suppliedManifestPath: string,
  jsonSchema: unknown,
  extraPrivateRoot: string | undefined,
): Promise<LoadedBenchmark> {
  const manifestPath = await realpath(path.resolve(suppliedManifestPath));
  let selection: BenchmarkRootSelection | null;
  try {
    selection = await resolveBenchmarkRoot({
      manifestPath,
      publicRoot: publicBenchmarkRoot,
      privateRoot: privateBenchmarkRoot,
      ...(extraPrivateRoot ? { extraPrivateRoot } : {}),
    });
  } catch (error) {
    if (error instanceof BenchmarkRootError) {
      throw new BaselineSetupError(error.code);
    }
    throw error;
  }
  if (!selection) {
    throw new BaselineSetupError("manifest_outside_benchmark_root");
  }
  const benchmarkRoot = selection.root;
  const storyDirectory = path.dirname(manifestPath);
  if (!isPathInside(benchmarkRoot, storyDirectory)) {
    throw new BaselineSetupError("manifest_outside_benchmark_root");
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch {
    throw new BaselineSetupError("manifest_invalid");
  }
  if (!rawManifest || typeof rawManifest !== "object") {
    throw new BaselineSetupError("manifest_invalid");
  }
  const sourcePathValue = (rawManifest as { sourcePath?: unknown }).sourcePath;
  if (typeof sourcePathValue !== "string") {
    throw new BaselineSetupError("manifest_invalid");
  }
  const sourcePath = await realpath(path.resolve(storyDirectory, sourcePathValue));
  if (!isPathInside(storyDirectory, sourcePath)) {
    throw new BaselineSetupError("source_outside_story_directory");
  }
  if (!isPathInside(benchmarkRoot, sourcePath)) {
    throw new BaselineSetupError("source_outside_benchmark_root");
  }
  const sourceBytes = await readFile(sourcePath);
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  } catch {
    throw new BaselineSetupError("source_not_utf8");
  }
  let manifest: M1BenchmarkManifest;
  try {
    manifest = validateM1BenchmarkManifest({
      value: rawManifest,
      jsonSchema,
      actualCharacterCount: countBenchmarkCharacters(sourceText),
    });
  } catch {
    throw new BaselineSetupError("manifest_contract_failed");
  }
  if (manifest.visibility !== selection.visibility) {
    throw new BaselineSetupError("manifest_visibility_mismatch");
  }
  const gold =
    selection.visibility === "private"
      ? await loadStoryGold({
          storyDirectory,
          benchmarkRoot,
          manifestId: manifest.id,
        })
      : null;
  return {
    manifest,
    sourceBytes,
    fileName: path.basename(sourcePath),
    gold,
  };
}

async function loadStoryGold(input: {
  storyDirectory: string;
  benchmarkRoot: string;
  manifestId: string;
}): Promise<M1Gold | null> {
  const requestedPath = path.join(input.storyDirectory, "gold.json");
  let goldPath: string;
  try {
    goldPath = await realpath(requestedPath);
  } catch {
    return null;
  }
  if (
    !isPathInside(input.storyDirectory, goldPath) ||
    !isPathInside(input.benchmarkRoot, goldPath)
  ) {
    throw new BaselineSetupError("gold_outside_story_directory");
  }

  let rawGold: unknown;
  try {
    rawGold = JSON.parse(await readFile(goldPath, "utf8")) as unknown;
  } catch {
    throw new BaselineSetupError("gold_invalid");
  }

  let gold: M1Gold;
  try {
    gold = parseM1Gold(rawGold);
  } catch {
    throw new BaselineSetupError("gold_invalid");
  }
  if (gold.storyId !== input.manifestId) {
    throw new BaselineSetupError("gold_story_mismatch");
  }
  return gold;
}

async function runStoryMapBaseline(
  benchmark: LoadedBenchmark,
  config: ConfiguredAI,
  provider: ReturnType<typeof createConfiguredAIProvider>,
) {
  const instrumented = new InstrumentedAIProvider(provider);
  const project = createProject({
    title: `M1 baseline ${benchmark.manifest.id}`,
  });
  let sourceId: string | undefined;
  const startedAt = performance.now();
  try {
    const imported = importProjectSource({
      projectId: project.id,
      fileName: benchmark.fileName,
      bytes: benchmark.sourceBytes,
    });
    sourceId = imported.source.id;
    const generated = await generateStoryMap({
      projectId: project.id,
      sourceId: imported.source.id,
      provider: instrumented,
      modelConfig: config.modelConfig,
    });
    const score = scoreM1StoryMapCandidate({
      manifest: benchmark.manifest,
      source: imported.source,
      storyMap: generated.artifact.storyMap,
      ...(benchmark.gold ? { gold: benchmark.gold } : {}),
    });
    return M1BaselineStoryReportSchema.parse({
      ...storyIdentity(benchmark.manifest, config),
      status: "generated",
      promptVersions: promptVersions(project.id),
      wallClockDurationMs: elapsedMilliseconds(startedAt),
      calls: instrumented.observations,
      generation: summarizeProviderObservations(instrumented.observations),
      compatibility: summarizeStoryMapValidation({
        calls: instrumented.observations,
        runs: validationRuns(project.id),
        evidenceValidity: score.evidenceValidity,
        storyMapArtifactCreated: true,
      }),
      reviewTarget: {
        projectId: project.id,
        sourceId: imported.source.id,
        storyMapArtifactId: generated.artifact.id,
      },
      storyMap: score,
      modelFailures: instrumented.observations
        .filter((item) => item.status === "failed")
        .map((item) => ({
          stage: "story_map" as const,
          code: item.failureCode ?? "provider_error",
        })),
    });
  } catch (error) {
    return M1BaselineStoryReportSchema.parse({
      ...storyIdentity(benchmark.manifest, config),
      status: "failed",
      promptVersions: promptVersions(project.id),
      wallClockDurationMs: elapsedMilliseconds(startedAt),
      calls: instrumented.observations,
      generation: summarizeProviderObservations(instrumented.observations),
      compatibility: summarizeStoryMapValidation({
        calls: instrumented.observations,
        runs: validationRuns(project.id),
        evidenceValidity: null,
        storyMapArtifactCreated: false,
      }),
      reviewTarget: null,
      storyMap: null,
      modelFailures: [
        ...instrumented.observations
          .filter((item) => item.status === "failed")
          .map((item) => ({
            stage: "story_map" as const,
            code: item.failureCode ?? "provider_error",
          })),
        {
          stage: sourceId ? ("story_map" as const) : ("source_import" as const),
          code: safeFailureCode(error),
        },
      ],
    });
  }
}

function storyIdentity(manifest: M1BenchmarkManifest, config: ConfiguredAI) {
  return {
    storyId: manifest.id,
    storyClass: manifest.storyClass,
    visibility: manifest.visibility,
    unseenByPromptAuthors: manifest.unseenByPromptAuthors,
    characterCount: manifest.characterCount,
    provider: config.providerName,
    model: config.modelConfig.model,
    structuredOutputMode: config.modelConfig.structuredOutputMode,
  };
}

function promptVersions(projectId: string) {
  const unique = new Map<string, { kind: string; version: string }>();
  for (const run of listProjectGenerationRuns(projectId)) {
    unique.set(`${run.kind}:${run.promptVersion}`, {
      kind: run.kind,
      version: run.promptVersion,
    });
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.version.localeCompare(right.version),
  );
}

function validationRuns(projectId: string) {
  return listProjectGenerationRuns(projectId).map((run) => ({
    kind: run.kind,
    status: run.status,
  }));
}

async function readCommitSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  const value = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new BaselineSetupError("commit_sha_unavailable");
  }
  return value;
}

function createRunId(evaluatedAt: string, commitSha: string): string {
  const timestamp = evaluatedAt.replace(/[-:.TZ]/g, "");
  return `${timestamp}-${commitSha.slice(0, 7)}-${randomUUID().slice(0, 8)}`;
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function safeFailureCode(error: unknown): string {
  if (error instanceof BaselineSetupError) return error.code;
  if (error instanceof M1BaselineArgumentError) return error.code;
  if (error instanceof Error && error.name === "StructuredGenerationError") {
    return "schema_validation_failed";
  }
  return "pipeline_failed";
}

function printReport(value: M1BaselineSuiteReport, reportPath: string): void {
  console.log(
    value.kind === "m1_tuning"
      ? "NovelRipple M1 tuning run (not a formal baseline)"
      : "NovelRipple M1 unoptimized baseline",
  );
  console.log(`Commit: ${value.commitSha}`);
  console.log(`Status: ${value.status}`);
  for (const story of value.stories) {
    const goldMatch = story.storyMap?.goldMatch;
    const goldSummary = goldMatch
      ? `; ${formatGoldMatch(goldMatch)}`
      : "; goldMatch=not_available";
    const tieredIdentity = story.storyMap?.tieredIdentity;
    const tieredSummary = tieredIdentity
      ? `; tieredIdentityR=${formatRateValue(tieredIdentity.recall)}; tieredIdentityP=${formatRateValue(tieredIdentity.precision)}; tieredIdentityF1=${formatRateValue(tieredIdentity.f1)}; minorCandidates=${tieredIdentity.minorCandidateTotal}`
      : "";
    const aliasStats = story.storyMap?.identity.aliasStats;
    const aliasSummary = aliasStats
      ? `; aliases(mean/max/atCap)=${aliasStats.meanAliases.toFixed(1)}/${aliasStats.maxAliases}/${aliasStats.charactersAtCap}`
      : "";
    console.log(
      `${story.storyId} [${story.storyClass}]: ${story.status}; mode=${story.structuredOutputMode}; extractor=${story.compatibility.extractor.firstPassValidation}/${story.compatibility.extractor.repair}; reconciler=${story.compatibility.reconciler.firstPassValidation}/${story.compatibility.reconciler.repair}; evidence=${formatOptionalRate(story.compatibility.evidenceValidity)}; artifact=${story.compatibility.storyMapArtifactCreated}; inputTokens=${story.generation.inputTokens ?? "unreported"}; outputTokens=${story.generation.outputTokens ?? "unreported"}; wallMs=${story.wallClockDurationMs}${goldSummary}${tieredSummary}${aliasSummary}`,
    );
  }
  console.log(`Sanitized JSON: ${reportPath}`);
  console.log("下一步：使用 eval.db 完成人工 revision/确认与 strict/open Ripple；不得把正文复制到报告。 ");
}

function formatGoldMatch(goldMatch: M1GoldMatch): string {
  const chance = goldMatch.chanceBaseline;
  const pair = (loose: number, strict: number) => ({ loose, strict });
  const section = (
    name: string,
    loose: number,
    strict: number,
    matchedChance: { loose: number; strict: number },
    denseChance: { loose: number; strict: number },
    stuffingChance: { loose: number; strict: number },
    sourceCopyChance: { loose: number; strict: number },
  ) =>
    `gold${name} loose=${formatRateValue(loose)} strict=${formatRateValue(strict)} ` +
    `chance(loose/strict)=${formatRateValue(matchedChance.loose)}/${formatRateValue(matchedChance.strict)} ` +
    `dense(loose/strict)=${formatRateValue(denseChance.loose)}/${formatRateValue(denseChance.strict)} ` +
    `stuffing(loose/strict)=${formatRateValue(stuffingChance.loose)}/${formatRateValue(stuffingChance.strict)} ` +
    `sourceCopy(loose/strict)=${formatRateValue(sourceCopyChance.loose)}/${formatRateValue(sourceCopyChance.strict)}`;
  return [
    section(
      "Events",
      goldMatch.events.f1,
      goldMatch.strict.events.f1,
      pair(chance.matched.loose.events.f1, chance.matched.strict.events.f1),
      pair(chance.dense.loose.events.f1, chance.dense.strict.events.f1),
      pair(chance.stuffing.loose.events.f1, chance.stuffing.strict.events.f1),
      pair(chance.sourceCopy.loose.events.f1, chance.sourceCopy.strict.events.f1),
    ),
    section(
      "Edges",
      goldMatch.edges.f1,
      goldMatch.strict.edges.f1,
      pair(chance.matched.loose.edges.f1, chance.matched.strict.edges.f1),
      pair(chance.dense.loose.edges.f1, chance.dense.strict.edges.f1),
      pair(chance.stuffing.loose.edges.f1, chance.stuffing.strict.edges.f1),
      pair(chance.sourceCopy.loose.edges.f1, chance.sourceCopy.strict.edges.f1),
    ),
    section(
      "Endings",
      goldMatch.endings.f1,
      goldMatch.strict.endings.f1,
      pair(chance.matched.loose.endings.f1, chance.matched.strict.endings.f1),
      pair(chance.dense.loose.endings.f1, chance.dense.strict.endings.f1),
      pair(chance.stuffing.loose.endings.f1, chance.stuffing.strict.endings.f1),
      pair(chance.sourceCopy.loose.endings.f1, chance.sourceCopy.strict.endings.f1),
    ),
    `goldHardRecall=${formatRate(goldMatch.edges.hardRecall)}`,
    `goldNonInterpretiveRecall=${formatRate(goldMatch.endings.nonInterpretiveRecall)}`,
    `lenientIdentityF1=${formatRateValue(goldMatch.lenientIdentity.f1)}`,
  ].join("; ");
}

function formatRate(value: { matched: number; total: number; rate: number }) {
  return `${value.matched}/${value.total} (${(value.rate * 100).toFixed(1)}%)`;
}

function formatRateValue(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatOptionalRate(
  value: { matched: number; total: number; rate: number } | null,
) {
  return value ? formatRate(value) : "not_available";
}
