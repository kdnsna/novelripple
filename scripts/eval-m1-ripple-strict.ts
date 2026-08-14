import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { z } from "zod";

import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import {
  InstrumentedAIProvider,
  countBenchmarkCharacters,
  validateM1BenchmarkManifest,
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

const M1RippleStrictReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("m1_ripple_strict"),
    runId: z.string().min(1),
    commitSha: z.string().min(1),
    evaluatedAt: z.iso.datetime(),
    provider: z.string().min(1),
    model: z.string().min(1),
    structuredOutputMode: z.string().min(1),
    status: z.enum(["passed", "failed", "awaiting_human_review"]),
    databaseFile: z.literal("eval.db"),
    stories: z
      .array(
        z
          .object({
            storyClass: z.enum(["A", "B", "C"]),
            divergenceId: z.string().min(1),
            divergenceType: z.string().min(1),
            anchorIds: z.array(z.string()),
            status: z.enum(["succeeded", "failed"]),
            failureCode: z.string().nullable(),
            impactPlan: z
              .object({
                durationMs: z.number().int().nonnegative().nullable(),
                totalTokens: z.number().int().nonnegative().nullable(),
                attempts: z.number().int().nonnegative().nullable(),
                impacts: z.number().int().nullable(),
                anchorRetained: z.boolean().nullable(),
                anchorNotes: z.string().nullable(),
              })
              .strict(),
            hardValidation: z
              .object({
                preDivergenceMutations: z.number().int().nonnegative(),
                reasonPathValid: z.boolean(),
                hardGatePassed: z.boolean(),
              })
              .strict(),
          })
          .strict(),
      )
      .length(3),
    privacy: z
      .object({
        containsSourceBody: z.literal(false),
        containsRawModelOutput: z.literal(false),
        containsPrivateTitleOrNames: z.literal(false),
      })
      .strict(),
  })
  .strict();

type M1RippleStrictReport = z.infer<typeof M1RippleStrictReportSchema>;
type BenchmarkTarget = {
  storyClass: "A" | "B" | "C";
  contentHash: string;
  characterCount: number;
  strictDivergence: {
    id: string;
    eventId: string;
    type: "prevent" | "choice" | "outcome";
    mode: string;
    instruction: string;
    anchorIds?: string[];
    eventLabel?: string;
  };
};

class EvaluationSetupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvaluationSetupError";
  }
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
  if (!values["baseline-db"]) {
    throw new EvaluationSetupError("baseline_db_required");
  }
  if ((values.manifest?.length ?? 0) !== 3) {
    throw new EvaluationSetupError("three_manifests_required");
  }
  return {
    baselineDb: values["baseline-db"],
    manifestPaths: values.manifest ?? [],
  };
}

async function readCommitSha(): Promise<string> {
  return (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout.trim();
}

function createRunId(evaluatedAt: string, commitSha: string): string {
  const timestamp = evaluatedAt.replace(/\D/g, "").slice(0, 14);
  return `${timestamp}-${commitSha.slice(0, 7)}-${Math.random().toString(16).slice(2, 10)}`;
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

function safeFailureCode(error: unknown): string {
  if (error instanceof EvaluationSetupError) return error.code;
  if (error instanceof z.ZodError) return "invalid_report";
  return (error as Error).message;
}

let report: M1RippleStrictReport | undefined;
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
    "m1-ripple-strict",
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

  const stories = [];
  for (const target of targets.toSorted((a, b) =>
    a.storyClass.localeCompare(b.storyClass),
  )) {
    stories.push(await evaluateStory(target, provider));
  }

  const allSucceeded = stories.every((s) => s.status === "succeeded");
  report = M1RippleStrictReportSchema.parse({
    schemaVersion: 1,
    kind: "m1_ripple_strict",
    runId,
    commitSha,
    evaluatedAt,
    provider: config.providerName,
    model: config.modelConfig.model,
    structuredOutputMode: config.modelConfig.structuredOutputMode,
    status: allSucceeded ? "awaiting_human_review" : "failed",
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
  console.error(`M1 Ripple strict 未运行：${safeFailureCode(error)}`);
  process.exitCode = 1;
} finally {
  const { closeDatabase } = await import("../src/server/db/client");
  closeDatabase();
  if (previousDatabasePath === undefined) delete process.env.DB_FILE_NAME;
  else process.env.DB_FILE_NAME = previousDatabasePath;
}

if (report && reportPath) {
  console.log("NovelRipple M1 Ripple strict divergence benchmark");
  console.log(`Run: ${report.runId}`);
  console.log(`Status: ${report.status}`);
  for (const story of report.stories) {
    console.log(
      `Story ${story.storyClass}: ${story.status}; divergence=${story.divergenceId}(${story.divergenceType}); anchors=${story.anchorIds.join(",")}; anchorRetained=${story.impactPlan.anchorRetained}; impacts=${story.impactPlan.impacts}; preDivergenceMutations=${story.hardValidation.preDivergenceMutations}; hardGate=${story.hardValidation.hardGatePassed}; tokens=${story.impactPlan.totalTokens}; wallMs=${story.impactPlan.durationMs}`,
    );
  }
  console.log(`Sanitized JSON: ${reportPath}`);
  console.log(
    "Human review: approve each direct impact (anchor consistency + causality) without copying story text.",
  );
  if (report.status === "failed") process.exitCode = 1;
}

async function evaluateStory(
  target: BenchmarkTarget,
  provider: InstrumentedAIProvider,
): Promise<M1RippleStrictReport["stories"][number]> {
  const {
    listProjects,
    listProjectSources,
  } = await import("../src/server/repositories/project-repository");
  const {
    listStoryMapArtifactsForSource,
  } = await import("../src/server/repositories/story-map-artifact-repository");
  const { generateImpactPlan } = await import(
    "../src/server/ripple/generate-impact-plan"
  );
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
    return failedStory(target, "confirmed_story_map_match_failed");
  }
  const [{ project, source }] = matches;
  const storyMapArtifact = listStoryMapArtifactsForSource(project.id, source.id)
    .filter((artifact) => artifact.storyMap.status === "confirmed")
    .toSorted((left, right) => right.version - left.version)[0];
  if (!storyMapArtifact) {
    return failedStory(target, "confirmed_story_map_missing");
  }

  const divergence = target.strictDivergence;
  const anchorIds = divergence.anchorIds ?? [];
  const storyMapEndings = storyMapArtifact.storyMap.endingCandidates;

  // manifest 的 eventId 是 Gold 事件 id，需映射到确认版 Story Map 的事件 id
  const storyMapEvents = storyMapArtifact.storyMap.events;
  let divergenceEventId = divergence.eventId;
  if (!storyMapEvents.some((e) => e.id === divergenceEventId)) {
    const goldLabel = divergence.eventLabel ?? "";
    const norm = (text: string): string =>
      text.replace(/[\s，。、；：！？（）《》"'“”‘’·\-—…]/g, "");
    const goldSet = new Set(norm(goldLabel));
    let best: { id: string; score: number } | null = null;
    if (goldSet.size > 0) {
      for (const event of storyMapEvents) {
        const candidateSet = new Set(norm(`${event.title} ${event.summary ?? ""}`));
        const overlap = [...goldSet].filter((ch) => candidateSet.has(ch)).length;
        const coverage = overlap / goldSet.size;
        const jaccard = overlap / Math.max(goldSet.size + candidateSet.size - overlap, 1);
        const score = 0.7 * coverage + 0.3 * jaccard;
        if (!best || score > best.score) best = { id: event.id, score };
      }
    }
    if (!best || best.score < 0.35) {
      return failedStory(target, "divergence_event_not_mapped");
    }
    divergenceEventId = best.id;
  }

  const startedAt = performance.now();
  try {
    const result = await generateImpactPlan({
      projectId: project.id,
      storyMapArtifactId: storyMapArtifact.id,
      divergence: {
        id: `divergence_${divergence.id}`,
        eventId: divergenceEventId,
        type: divergence.type,
        instruction: divergence.instruction,
      },
      mode: "strict",
      endingCandidateIds: anchorIds,
      provider,
      modelConfig: config.modelConfig,
    });
    const plan = result.artifact.impactPlan;
    const anchorNotes: string[] = [];
    let anchorRetained: boolean | null = null;
    for (const anchorId of anchorIds) {
      const storyMapEnding = storyMapEndings.find((e) => e.id === anchorId);
      if (!storyMapEnding) {
        anchorNotes.push(`${anchorId}:not_in_story_map`);
        continue;
      }
      const expectedAnchorId = anchorId.startsWith("ending_")
        ? `anchor_${anchorId.slice("ending_".length)}`
        : `anchor_${anchorId}`;
      const retained =
        plan.anchors.some((a) => a.id === expectedAnchorId) ||
        plan.anchors.some(
          (a) =>
            a.strength === "hard" &&
            a.targetEventId === storyMapEnding.targetEventId,
        );
      anchorRetained = anchorRetained === null ? retained : anchorRetained && retained;
      anchorNotes.push(`${anchorId}:${retained ? "retained" : "dropped"}`);
    }
    return {
      storyClass: target.storyClass,
      divergenceId: divergence.id,
      divergenceType: divergence.type,
      anchorIds,
      status: "succeeded",
      failureCode: null,
      impactPlan: {
        durationMs: Math.round(performance.now() - startedAt),
        totalTokens: result.generation?.usage?.totalTokens ?? null,
        attempts: result.generation?.attemptCount ?? null,
        impacts: plan.impacts?.length ?? null,
        anchorRetained,
        anchorNotes: anchorNotes.join("; ") || null,
      },
      hardValidation: {
        preDivergenceMutations: 0,
        reasonPathValid: true,
        hardGatePassed: true,
      },
    };
  } catch (error) {
    const message = (error as Error).message;
    return {
      ...failedStory(target, (error as Error).message),
      impactPlan: {
        durationMs: Math.round(performance.now() - startedAt),
        totalTokens: null,
        attempts: null,
        impacts: null,
        anchorRetained: null,
        anchorNotes: null,
      },
      hardValidation: {
        preDivergenceMutations: message.includes("pre-divergence") ||
          message.includes("preDivergence")
          ? 1
          : 0,
        reasonPathValid: !(
          message.includes("reasonPath") || message.includes("reason_path")
        ),
        hardGatePassed: false,
      },
    };
  }
}

function failedStory(
  target: BenchmarkTarget,
  failureCode: string,
): M1RippleStrictReport["stories"][number] {
  return {
    storyClass: target.storyClass,
    divergenceId: target.strictDivergence.id,
    divergenceType: target.strictDivergence.type,
    anchorIds: target.strictDivergence.anchorIds ?? [],
    status: "failed",
    failureCode,
    impactPlan: {
      durationMs: null,
      totalTokens: null,
      attempts: null,
      impacts: null,
      anchorRetained: null,
      anchorNotes: null,
    },
    hardValidation: {
      preDivergenceMutations: 0,
      reasonPathValid: true,
      hardGatePassed: false,
    },
  };
}

async function loadBenchmarkTargets(
  manifestPaths: string[],
): Promise<BenchmarkTarget[]> {
  const jsonSchema = JSON.parse(
    await readFile(manifestSchemaPath, "utf8"),
  );
  const targets: BenchmarkTarget[] = [];
  for (const manifestPath of manifestPaths) {
    const storyDirectory = path.dirname(manifestPath);
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    const sourcePath = path.resolve(storyDirectory, raw.sourcePath);
    if (!sourcePath.startsWith(path.resolve(storyDirectory))) {
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
    const strictDivergenceRaw = (manifest.testDivergences ?? []).find(
      (d: { mode?: string }) => d.mode === "strict",
    );
    if (!strictDivergenceRaw) {
      throw new EvaluationSetupError(
        `strict_divergence_missing_${manifest.storyClass}`,
      );
    }
    const goldEvent = (manifest.expectedKeyEvents ?? []).find(
      (e: { id: string }) => e.id === strictDivergenceRaw.eventId,
    );
    const strictDivergence = {
      ...strictDivergenceRaw,
      eventLabel: goldEvent?.label ?? "",
    };
    targets.push({
      storyClass: manifest.storyClass,
      contentHash: prepared.contentHash,
      characterCount: countBenchmarkCharacters(prepared.normalizedText),
      strictDivergence,
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
