import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import {
  InstrumentedAIProvider,
  M1BaselineStoryReportSchema,
  M1BaselineSuiteReportSchema,
  assertM1BaselineSuite,
  countBenchmarkCharacters,
  scoreM1StoryMapCandidate,
  summarizeProviderObservations,
  validateM1BenchmarkManifest,
  type M1BaselineSuiteReport,
  type M1BenchmarkManifest,
} from "../src/evals/m1-baseline";
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
};

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const publicBenchmarkRoot = path.join(repositoryRoot, "benchmarks", "m1", "public");
const privateBenchmarkRoot = path.join(repositoryRoot, "benchmarks", "private");
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
  const manifestPaths = parseManifestArguments();
  const jsonSchema = JSON.parse(await readFile(manifestSchemaPath, "utf8")) as unknown;
  const benchmarks: LoadedBenchmark[] = [];
  for (const manifestPath of manifestPaths) {
    benchmarks.push(await loadBenchmark(manifestPath, jsonSchema));
  }
  assertM1BaselineSuite(benchmarks.map((item) => item.manifest));

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
    kind: "m1_unoptimized_baseline",
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
): Promise<LoadedBenchmark> {
  const manifestPath = await realpath(path.resolve(suppliedManifestPath));
  const benchmarkRoot = await resolveBenchmarkRoot(manifestPath);
  const storyDirectory = path.dirname(manifestPath);
  if (!isInside(benchmarkRoot, storyDirectory)) {
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
  if (!isInside(storyDirectory, sourcePath)) {
    throw new BaselineSetupError("source_outside_story_directory");
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
  const expectedVisibility = benchmarkRoot === publicBenchmarkRoot
    ? "public"
    : "private";
  if (manifest.visibility !== expectedVisibility) {
    throw new BaselineSetupError("manifest_visibility_mismatch");
  }
  return {
    manifest,
    sourceBytes,
    fileName: path.basename(sourcePath),
  };
}

async function resolveBenchmarkRoot(manifestPath: string): Promise<string> {
  const resolvedPublicRoot = await realpath(publicBenchmarkRoot);
  if (isInside(resolvedPublicRoot, manifestPath)) return publicBenchmarkRoot;
  try {
    const resolvedPrivateRoot = await realpath(privateBenchmarkRoot);
    if (isInside(resolvedPrivateRoot, manifestPath)) return privateBenchmarkRoot;
  } catch {
    // A missing private directory is a valid repository state.
  }
  throw new BaselineSetupError("manifest_outside_benchmark_root");
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
    });
    return M1BaselineStoryReportSchema.parse({
      ...storyIdentity(benchmark.manifest, config),
      status: "generated",
      promptVersions: promptVersions(project.id),
      wallClockDurationMs: elapsedMilliseconds(startedAt),
      calls: instrumented.observations,
      generation: summarizeProviderObservations(instrumented.observations),
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

function parseManifestArguments(): string[] {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string", multiple: true },
    },
    strict: true,
    allowPositionals: false,
  });
  const manifests = values.manifest ?? [];
  if (manifests.length < 3) {
    throw new BaselineSetupError("at_least_three_manifests_required");
  }
  return manifests;
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

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function safeFailureCode(error: unknown): string {
  if (error instanceof BaselineSetupError) return error.code;
  if (error instanceof Error && error.name === "StructuredGenerationError") {
    return "schema_validation_failed";
  }
  return "pipeline_failed";
}

function printReport(value: M1BaselineSuiteReport, reportPath: string): void {
  console.log("NovelRipple M1 unoptimized baseline");
  console.log(`Commit: ${value.commitSha}`);
  console.log(`Status: ${value.status}`);
  for (const story of value.stories) {
    console.log(
      `${story.storyId} [${story.storyClass}]: ${story.status}; calls=${story.generation.callCount}; repairs=${story.generation.repairCount}; inputTokens=${story.generation.inputTokens ?? "unreported"}; outputTokens=${story.generation.outputTokens ?? "unreported"}; wallMs=${story.wallClockDurationMs}`,
    );
    if (story.storyMap) {
      console.log(
        `${story.storyId}: characters=${story.storyMap.identity.candidateTotal}; events=${story.storyMap.events.candidateTotal}; evidence=${formatRate(story.storyMap.evidenceValidity)}; event/ending recall=human-review-required`,
      );
    }
  }
  console.log(`Sanitized JSON: ${reportPath}`);
  console.log("下一步：使用 eval.db 完成人工 revision/确认与 strict/open Ripple；不得把正文复制到报告。 ");
}

function formatRate(value: { matched: number; total: number; rate: number }) {
  return `${value.matched}/${value.total} (${(value.rate * 100).toFixed(1)}%)`;
}
