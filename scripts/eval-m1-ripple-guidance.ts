import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import {
  M1RippleGuidanceReportSchema,
  determineM1RippleGuidanceStatus,
  type M1RippleGuidanceReport,
  type M1RippleGuidanceStory,
} from "../src/evals/m1-ripple-guidance";
import {
  InstrumentedAIProvider,
  countBenchmarkCharacters,
  summarizeProviderObservations,
  validateM1BenchmarkManifest,
  type ProviderObservation,
} from "../src/evals/m1-baseline";
import { prepareSourceImport } from "../src/domain/source/normalize-source";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const manifestSchemaPath = path.join(
  repositoryRoot,
  "benchmarks",
  "m1",
  "manifest.schema.json",
);
const previousDatabasePath = process.env.DB_FILE_NAME;
const feedbackProbe =
  "请重新核对所有 direct impact：分歧点前已发生的事实必须保持不变，人物只有在当前因果链明确支持时才能退出原有行动。";

type BenchmarkTarget = {
  storyClass: "A" | "B" | "C";
  contentHash: string;
};

type GenerationStage = M1RippleGuidanceStory["initialCandidate"];

class EvaluationSetupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvaluationSetupError";
  }
}

let report: M1RippleGuidanceReport | undefined;
let reportPath: string | undefined;

try {
  const { baselineDb, manifestPaths } = parseArguments();
  const commitSha = await readCommitSha();
  const evaluatedAt = new Date().toISOString();
  const runId = createRunId(evaluatedAt, commitSha);
  const reportDirectory = path.join(
    repositoryRoot,
    ".data",
    "evals",
    "m1-ripple-guidance",
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

  const stories: M1RippleGuidanceStory[] = [];
  for (const target of targets.toSorted((a, b) =>
    a.storyClass.localeCompare(b.storyClass),
  )) {
    stories.push(await evaluateStory(target, provider));
  }

  report = M1RippleGuidanceReportSchema.parse({
    schemaVersion: 1,
    kind: "m1_ripple_guidance",
    runId,
    commitSha,
    evaluatedAt,
    provider: config.providerName,
    model: config.modelConfig.model,
    structuredOutputMode: config.modelConfig.structuredOutputMode,
    status: determineM1RippleGuidanceStatus(stories),
    databaseFile: "eval.db",
    stories,
    privacy: {
      containsSourceBody: false,
      containsRawModelOutput: false,
      containsPrivateTitleOrNames: false,
    },
  });
  reportPath = path.join(reportDirectory, "metrics.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  closeDatabase();
} catch (error) {
  console.error(`M1 Ripple guidance 未运行：${safeFailureCode(error)}`);
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
): Promise<M1RippleGuidanceStory> {
  const {
    listProjects,
    listProjectSources,
  } = await import("../src/server/repositories/project-repository");
  const {
    listStoryMapArtifactsForSource,
  } = await import(
    "../src/server/repositories/story-map-artifact-repository"
  );
  const {
    getImpactPlanArtifact,
    listProjectWorldlines,
  } = await import("../src/server/repositories/ripple-repository");
  const { generateRippleSuggestions } = await import(
    "../src/server/ripple/generate-ripple-suggestions"
  );
  const {
    generateImpactPlan,
    regenerateImpactPlanFromFeedback,
  } = await import("../src/server/ripple/generate-impact-plan");
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
    return failedStory(target.storyClass, "confirmed_story_map_match_failed");
  }
  const [{ project, source }] = matches;
  const storyMapArtifact = listStoryMapArtifactsForSource(project.id, source.id)
    .filter((artifact) => artifact.storyMap.status === "confirmed")
    .toSorted((left, right) => right.version - left.version)[0];
  if (!storyMapArtifact) {
    return failedStory(target.storyClass, "confirmed_story_map_missing");
  }

  const worldlinesBefore = listProjectWorldlines(project.id).length;
  let suggestionsStage: M1RippleGuidanceStory["suggestions"];
  let suggestionsArtifact:
    | Awaited<ReturnType<typeof generateRippleSuggestions>>["artifact"]
    | undefined;
  {
    const startedAt = performance.now();
    const observationStart = provider.observations.length;
    try {
      const result = await generateRippleSuggestions({
        projectId: project.id,
        storyMapArtifactId: storyMapArtifact.id,
        provider,
        modelConfig: config.modelConfig,
      });
      suggestionsArtifact = result.artifact;
      suggestionsStage = {
        ...successfulStage(
          result.generation,
          "ripple-suggestions.v1",
          elapsedMilliseconds(startedAt),
          provider.observations.slice(observationStart),
        ),
        suggestionCount: result.artifact.suggestions.length,
      };
    } catch (error) {
      suggestionsStage = {
        ...failedStage(
          "ripple-suggestions.v1",
          elapsedMilliseconds(startedAt),
          provider.observations.slice(observationStart),
          error,
        ),
        suggestionCount: null,
      };
    }
  }

  if (!suggestionsArtifact) {
    return {
      ...failedStory(target.storyClass, suggestionsStage.failureCode),
      confirmedStoryMapMatched: true,
      suggestions: suggestionsStage,
    };
  }

  let initialStage: GenerationStage;
  let initialArtifact:
    | Awaited<ReturnType<typeof generateImpactPlan>>["artifact"]
    | undefined;
  {
    const suggestion = suggestionsArtifact.suggestions[0];
    const startedAt = performance.now();
    const observationStart = provider.observations.length;
    try {
      const result = await generateImpactPlan({
        projectId: project.id,
        storyMapArtifactId: storyMapArtifact.id,
        divergence: {
          eventId: suggestion.eventId,
          type: suggestion.divergenceType,
          instruction: suggestion.instruction,
        },
        mode: "open",
        endingCandidateIds: [],
        provider,
        modelConfig: config.modelConfig,
      });
      initialArtifact = result.artifact;
      initialStage = successfulStage(
        result.generation,
        "impact-plan.v2",
        elapsedMilliseconds(startedAt),
        provider.observations.slice(observationStart),
      );
    } catch (error) {
      initialStage = failedStage(
        "impact-plan.v2",
        elapsedMilliseconds(startedAt),
        provider.observations.slice(observationStart),
        error,
      );
    }
  }

  if (!initialArtifact) {
    return {
      ...failedStory(target.storyClass, initialStage.failureCode),
      confirmedStoryMapMatched: true,
      suggestions: suggestionsStage,
      initialCandidate: initialStage,
      invariants: {
        suggestionsExactlyThree: suggestionsArtifact.suggestions.length === 3,
        noWorldlineWrites:
          listProjectWorldlines(project.id).length === worldlinesBefore,
        oldCandidateImmutable: false,
        lineageContractPreserved: false,
        hardValidationPassed: false,
      },
    };
  }

  const originalCandidateSnapshot = JSON.stringify(initialArtifact);
  let feedbackStage: GenerationStage;
  let feedbackArtifact:
    | Awaited<ReturnType<typeof regenerateImpactPlanFromFeedback>>["artifact"]
    | undefined;
  {
    const startedAt = performance.now();
    const observationStart = provider.observations.length;
    try {
      const result = await regenerateImpactPlanFromFeedback({
        projectId: project.id,
        priorCandidateArtifactId: initialArtifact.id,
        feedback: feedbackProbe,
        provider,
        modelConfig: config.modelConfig,
      });
      feedbackArtifact = result.artifact;
      feedbackStage = successfulStage(
        result.generation,
        "impact-plan-feedback.v1",
        elapsedMilliseconds(startedAt),
        provider.observations.slice(observationStart),
      );
    } catch (error) {
      feedbackStage = failedStage(
        "impact-plan-feedback.v1",
        elapsedMilliseconds(startedAt),
        provider.observations.slice(observationStart),
        error,
      );
    }
  }

  const reloadedInitial = getImpactPlanArtifact(initialArtifact.id);
  const oldCandidateImmutable =
    reloadedInitial !== null &&
    JSON.stringify(reloadedInitial) === originalCandidateSnapshot;
  const lineageContractPreserved = Boolean(
    feedbackArtifact &&
      feedbackArtifact.lineage?.priorCandidateArtifactId === initialArtifact.id &&
      feedbackArtifact.lineage.sameStoryMapArtifactId === storyMapArtifact.id &&
      JSON.stringify(feedbackArtifact.lineage.sameDivergence) ===
        JSON.stringify(initialArtifact.impactPlan.divergence) &&
      feedbackArtifact.lineage.sameMode === initialArtifact.impactPlan.mode &&
      JSON.stringify(feedbackArtifact.lineage.sameAnchors) ===
        JSON.stringify(initialArtifact.impactPlan.anchors),
  );
  const noWorldlineWrites =
    listProjectWorldlines(project.id).length === worldlinesBefore;
  const invariants = {
    suggestionsExactlyThree: suggestionsArtifact.suggestions.length === 3,
    noWorldlineWrites,
    oldCandidateImmutable,
    lineageContractPreserved,
    hardValidationPassed: Boolean(feedbackArtifact),
  };
  const completed = Object.values(invariants).every(Boolean);

  return {
    storyClass: target.storyClass,
    status: completed ? "completed" : "failed",
    confirmedStoryMapMatched: true,
    suggestions: suggestionsStage,
    initialCandidate: initialStage,
    feedbackCandidate: feedbackStage,
    invariants,
    humanReview: {
      valuableSuggestionCount: null,
      feedbackProblemResolved: null,
      status: "awaiting_human_review",
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
  },
  promptVersion: string,
  durationMs: number,
  observations: ProviderObservation[],
): GenerationStage {
  const usage = summarizeProviderObservations(observations);
  return {
    status: "succeeded",
    promptVersion,
    durationMs,
    attemptCount: generation.attemptCount,
    inputTokens: usage.inputTokens ?? generation.usage?.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? generation.usage?.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? generation.usage?.totalTokens ?? null,
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
    attemptCount: observations.length === 2 ? 2 : observations.length === 1 ? 1 : null,
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
): M1RippleGuidanceStory {
  return {
    storyClass,
    status: "failed",
    confirmedStoryMapMatched: false,
    suggestions: {
      ...notRunStage("ripple-suggestions.v1"),
      suggestionCount: null,
      failureCode: failureCode ?? "pipeline_failed",
    },
    initialCandidate: notRunStage("impact-plan.v2"),
    feedbackCandidate: notRunStage("impact-plan-feedback.v1"),
    invariants: {
      suggestionsExactlyThree: false,
      noWorldlineWrites: true,
      oldCandidateImmutable: false,
      lineageContractPreserved: false,
      hardValidationPassed: false,
    },
    humanReview: {
      valuableSuggestionCount: null,
      feedbackProblemResolved: null,
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

function parseArguments(): { baselineDb: string; manifestPaths: string[] } {
  const { values } = parseArgs({
    options: {
      "baseline-db": { type: "string" },
      manifest: { type: "string", multiple: true },
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

function printReport(value: M1RippleGuidanceReport, outputPath: string) {
  console.log("NovelRipple M1 Ripple guidance benchmark");
  console.log(`Run: ${value.runId}`);
  console.log(`Status: ${value.status}`);
  for (const story of value.stories) {
    console.log(
      `Story ${story.storyClass}: ${story.status}; suggestions=${story.suggestions.suggestionCount ?? "not_created"}; suggestionAttempts=${story.suggestions.attemptCount ?? "not_run"}; initialAttempts=${story.initialCandidate.attemptCount ?? "not_run"}; feedbackAttempts=${story.feedbackCandidate.attemptCount ?? "not_run"}; totalTokens=${sumTokens(story)}; wallMs=${sumDuration(story)}`,
    );
  }
  console.log(`Sanitized JSON: ${outputPath}`);
  console.log("Human review: evaluate suggestion value and feedback resolution without copying story text.");
}

function sumTokens(story: M1RippleGuidanceStory): number | "unreported" {
  const values = [
    story.suggestions.totalTokens,
    story.initialCandidate.totalTokens,
    story.feedbackCandidate.totalTokens,
  ];
  return values.every((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : "unreported";
}

function sumDuration(story: M1RippleGuidanceStory): number {
  return (
    story.suggestions.durationMs +
    story.initialCandidate.durationMs +
    story.feedbackCandidate.durationMs
  );
}
