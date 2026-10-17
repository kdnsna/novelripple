import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  HARD_RULE_IDS,
  buildM1DashboardMarkdown,
  M1ContinuationHumanSchema,
  M1CorrectionCostHumanSchema,
  M1EvalReportSchema,
  M1RippleHumanSchema,
  M1StoryMapHumanSchema,
  M1UserObservationSchema,
  combineHardRules,
  combineTargets,
  evaluateAggregateStoryMapTargets,
  evaluateContinuationTargets,
  evaluateCorrectionCostTargets,
  evaluateHardRules,
  evaluateRippleTargets,
  evaluateStoryMapTargets,
  evaluateUserObservationTargets,
  hardRulesPassed,
  type M1ContinuationHuman,
  type M1CorrectionCostHuman,
  type M1RippleHuman,
  type M1StoryMapHuman,
  type M1UserObservation,
} from "../src/evals/m1-eval";

const repositoryRoot = process.cwd();
const storyClasses = ["A", "B", "C"] as const;
type StoryClass = (typeof storyClasses)[number];

function parseArguments(): {
  manifestPaths: string[];
  humanDir: string;
  baselineRun: string | undefined;
  continuationRun: string | undefined;
  reportDir: string;
} {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string", multiple: true },
      "human-dir": { type: "string" },
      "baseline-run": { type: "string" },
      "continuation-run": { type: "string" },
      "report-dir": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if ((values.manifest?.length ?? 0) !== 3) {
    throw new Error("必须提供 3 个 --manifest");
  }
  return {
    manifestPaths: values.manifest ?? [],
    humanDir: values["human-dir"]
      ? path.resolve(values["human-dir"])
      : path.join(repositoryRoot, ".data", "m1-human"),
    baselineRun: values["baseline-run"],
    continuationRun: values["continuation-run"],
    reportDir: values["report-dir"]
      ? path.resolve(values["report-dir"])
      : path.join(repositoryRoot, ".data", "evals", "m1-eval"),
  };
}

type ManifestMeta = {
  id: string;
  rightsMode: string;
  characterCount: number;
  unseenByPromptAuthors: boolean;
};

async function readManifestMeta(manifestPath: string): Promise<ManifestMeta> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  const id = raw.id ?? path.basename(path.dirname(manifestPath));
  const rights = raw.rights ?? "unknown";
  const characterCount =
    raw.characterCount ??
    raw.characterCountByClass ??
    (raw.scale?.characters ?? null);
  return {
    id,
    rightsMode:
      typeof rights === "string"
        ? rights
        : rights.mode ?? JSON.stringify(rights),
    characterCount: Number(characterCount ?? 0),
    unseenByPromptAuthors: Boolean(raw.unseenByPromptAuthors),
  };
}

async function readHumanFile<T>(
  humanDir: string,
  fileName: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  key: string,
): Promise<T | null> {
  const filePath = path.join(humanDir, fileName);
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    const entries = Array.isArray(raw) ? raw : [raw];
    const target = entries.find(
      (entry: { storyClass?: string }) =>
        entry?.storyClass?.toUpperCase() === key,
    );
    if (!target) return null;
    const parsed = schema.safeParse(target);
    if (!parsed.success) {
      console.error(`[warn] ${fileName} 中 Story ${key} 解析失败：忽略`);
      return null;
    }
    return parsed.data as T;
  } catch {
    return null;
  }
}

async function findLatestRun(
  directory: string,
): Promise<string | undefined> {
  // 没有 continuation 运行记录时，性能数据记为 n/a，而不是让仪表盘整体无法生成。
  const dirs = (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return dirs.length > 0 ? dirs[dirs.length - 1] : undefined;
}

async function readContinuationPerformance(
  runId: string | undefined,
): Promise<Record<StoryClass, {
  modelCalls: number | null;
  repairCount: number | null;
  totalTokens: number | null;
  wallClockDurationMs: number | null;
}>> {
  const empty: Record<StoryClass, {
    modelCalls: number | null;
    repairCount: number | null;
    totalTokens: number | null;
    wallClockDurationMs: number | null;
  }> = {
    A: { modelCalls: null, repairCount: null, totalTokens: null, wallClockDurationMs: null },
    B: { modelCalls: null, repairCount: null, totalTokens: null, wallClockDurationMs: null },
    C: { modelCalls: null, repairCount: null, totalTokens: null, wallClockDurationMs: null },
  };
  if (!runId) return empty;
  const base = path.join(
    repositoryRoot,
    ".data",
    "evals",
    "m1-continuation",
    runId,
  );
  try {
    const metrics = JSON.parse(
      await readFile(path.join(base, "metrics.json"), "utf8"),
    );
    for (const story of metrics.stories ?? []) {
      const cls = story.storyClass as StoryClass;
      if (!empty[cls]) continue;
      const stages = ["suggestions", "impactPlan", "directions", "scene"];
      let calls = 0;
      let repairs = 0;
      let tokens = 0;
      let wallMs = 0;
      for (const stage of stages) {
        const s = story[stage];
        if (!s) continue;
        if (s.status === "succeeded") calls += 1;
        if (s.attemptCount && s.attemptCount > 1) repairs += s.attemptCount - 1;
        tokens += s.totalTokens ?? 0;
        wallMs += s.durationMs ?? 0;
      }
      empty[cls] = {
        modelCalls: calls,
        repairCount: repairs,
        totalTokens: tokens,
        wallClockDurationMs: wallMs,
      };
    }
  } catch {
    // 指标缺失时保持 null
  }
  return empty;
}

async function main() {
  const args = parseArguments();
  const runId = `m1-eval-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 14)}`;
  const evaluatedAt = new Date().toISOString();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const commitSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout.trim();

  // 1. manifest 元数据（三篇按 storyClass 排序）
  const manifests = await Promise.all(
    args.manifestPaths.map((p) => readManifestMeta(p)),
  );

  // 2. 人工输入（缺失 = null，计入 missingData）
  const storyMaps: Record<StoryClass, M1StoryMapHuman | null> = {
    A: null, B: null, C: null,
  };
  const corrections: Record<StoryClass, M1CorrectionCostHuman | null> = {
    A: null, B: null, C: null,
  };
  const ripples: Record<StoryClass, M1RippleHuman | null> = {
    A: null, B: null, C: null,
  };
  const continuations: Record<StoryClass, M1ContinuationHuman | null> = {
    A: null, B: null, C: null,
  };
  for (const cls of storyClasses) {
    storyMaps[cls] = await readHumanFile(
      args.humanDir,
      "story-map.json",
      M1StoryMapHumanSchema,
      cls,
    );
    corrections[cls] = await readHumanFile(
      args.humanDir,
      "correction-cost.json",
      M1CorrectionCostHumanSchema,
      cls,
    );
    ripples[cls] = await readHumanFile(
      args.humanDir,
      "ripple.json",
      M1RippleHumanSchema,
      cls,
    );
    continuations[cls] = await readHumanFile(
      args.humanDir,
      "continuation.json",
      M1ContinuationHumanSchema,
      cls,
    );
  }
  let userObservation: M1UserObservation | null = null;
  try {
    const raw = JSON.parse(
      await readFile(path.join(args.humanDir, "users.json"), "utf8"),
    );
    const parsed = M1UserObservationSchema.safeParse(raw);
    if (parsed.success) userObservation = parsed.data;
  } catch {
    // 缺失保持 null
  }

  // 3. performance（continuation run）
  const latestContinuationRun =
    args.continuationRun ??
    (await findLatestRun(
      path.join(repositoryRoot, ".data", "evals", "m1-continuation"),
    ));
  const performance = await readContinuationPerformance(
    latestContinuationRun,
  );

  // 4. 硬规则 + 质量目标
  const stories = storyClasses.map((cls) => {
    const manifest = manifests[storyClasses.indexOf(cls)];
    return {
      storyClass: cls,
      identity: {
        benchmarkId: manifest.id,
        rightsMode: manifest.rightsMode,
        characterCount: manifest.characterCount,
        unseenByPromptAuthors: manifest.unseenByPromptAuthors,
        promptVersions: [],
      },
      storyMap: storyMaps[cls],
      correctionCost: corrections[cls],
      ripple: ripples[cls],
      continuation: continuations[cls],
      hardRules: evaluateHardRules({
        storyMap: storyMaps[cls],
        ripple: ripples[cls],
        continuation: continuations[cls],
      }),
      targets: {
        storyMap: evaluateStoryMapTargets(storyMaps[cls]),
        correctionCost: evaluateCorrectionCostTargets(
          corrections[cls],
          manifest.characterCount,
        ),
        ripple: evaluateRippleTargets(ripples[cls]),
        continuation: evaluateContinuationTargets(continuations[cls]),
      },
      performance: performance[cls],
    };
  });

  const aggregate = evaluateAggregateStoryMapTargets([
    storyMaps.A,
    storyMaps.B,
    storyMaps.C,
  ]);
  const hardRules = combineHardRules(stories.map((s) => s.hardRules));
  const passed = hardRulesPassed(hardRules);

  // 缺失数据只是"未测"，不影响结论；真人观察是可选项。
  const notMeasured: string[] = [];
  for (const cls of storyClasses) {
    if (!storyMaps[cls]) notMeasured.push(`story_map_${cls}`);
    if (!corrections[cls]) notMeasured.push(`correction_cost_${cls}`);
    if (!ripples[cls]) notMeasured.push(`ripple_${cls}`);
    if (!continuations[cls]) notMeasured.push(`continuation_${cls}`);
  }
  if (!userObservation) notMeasured.push("user_observation (optional)");

  const report = M1EvalReportSchema.parse({
    schemaVersion: 2,
    kind: "m1_dashboard",
    runId,
    commitSha,
    evaluatedAt,
    status: passed ? "reported" : "hard_rule_violation",
    stories,
    dashboard: {
      hardRules,
      hardRulesPassed: passed,
      targets: {
        storyMap: combineTargets(stories.map((s) => s.targets.storyMap)),
        aggregateStoryMap: { status: aggregate.status, misses: aggregate.misses },
        correctionCost: combineTargets(
          stories.map((s) => s.targets.correctionCost),
        ),
        ripple: combineTargets(stories.map((s) => s.targets.ripple)),
        continuation: combineTargets(stories.map((s) => s.targets.continuation)),
        userObservation: evaluateUserObservationTargets(userObservation),
      },
      aggregate: {
        identityF1: aggregate.identityF1,
        keyEventRecall: aggregate.keyEventRecall,
      },
      userObservation,
      notMeasured,
    },
    privacy: {
      containsSourceBody: false,
      containsRawModelOutput: false,
      containsPrivateTitleOrNames: false,
    },
  });

  await mkdir(args.reportDir, { recursive: true });
  const runDirectory = path.join(args.reportDir, runId);
  await mkdir(runDirectory, { recursive: true });
  const metricsPath = path.join(runDirectory, "metrics.json");
  await writeFile(metricsPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  // 5. 脱敏仪表盘报告
  const reportPath = path.join(
    repositoryRoot,
    "docs",
    "evals",
    "runs",
    `m1-dashboard-${new Date().toISOString().slice(0, 10)}-${commitSha.slice(0, 7)}.md`,
  );
  await writeFile(reportPath, buildM1DashboardMarkdown(report), "utf8");

  console.log("NovelRipple M1 质量仪表盘");
  console.log(`Run: ${runId}`);
  console.log(
    `Hard rules: ${passed ? "PASS" : "VIOLATED"} (${HARD_RULE_IDS.map((id) => `${id}=${hardRules[id].status}`).join(" ")})`,
  );
  for (const [name, result] of Object.entries(report.dashboard.targets)) {
    console.log(
      `Target ${name}: ${result.status}${result.misses.length > 0 ? ` (${result.misses.join(", ")})` : ""}`,
    );
  }
  console.log(`Not measured: ${notMeasured.join(", ") || "none"}`);
  console.log(`Sanitized JSON: ${metricsPath}`);
  console.log(`Report: ${reportPath}`);
  // 只有硬规则被违反才以非零退出；质量目标未达标只记录。
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`M1 仪表盘未运行：${(error as Error).message}`);
  process.exitCode = 1;
});
