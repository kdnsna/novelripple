import { randomBytes } from "node:crypto";
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
  reportDirProvided: boolean;
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
    reportDirProvided: Boolean(values["report-dir"]),
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
  const fileName = path.basename(manifestPath);
  const id = raw.id ?? path.basename(path.dirname(manifestPath));
  const rights = raw.rights ?? "unknown";
  const candidates = [
    raw.characterCount,
    raw.characterCountByClass,
    raw.scale?.characters,
  ];
  const characterCount = candidates.find(
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value > 0,
  );
  if (characterCount === undefined) {
    throw new Error(
      `${fileName} 缺少正整数 characterCount（characterCount / characterCountByClass / scale.characters）`,
    );
  }
  return {
    id,
    rightsMode:
      typeof rights === "string"
        ? rights
        : rights.mode ?? JSON.stringify(rights),
    characterCount,
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
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    // 文件缺失 = 未测；其它读取错误必须暴露。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${fileName} 不是合法 JSON（Story ${key}）`);
  }
  const entries = Array.isArray(raw) ? raw : [raw];
  const target = entries.find(
    (entry: { storyClass?: string }) =>
      entry?.storyClass?.toUpperCase() === key,
  );
  if (!target) return null;
  const parsed = schema.safeParse(target);
  if (!parsed.success) {
    throw new Error(`${fileName} 中 Story ${key} 未通过 Schema 校验`);
  }
  return parsed.data as T;
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
  const evaluatedAt = new Date().toISOString();
  const timestamp = evaluatedAt.replace(/\D/g, "");
  const randomSuffix = randomBytes(3).toString("hex");
  const runId = `m1-eval-${timestamp}-${randomSuffix}`;
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
  let usersText: string | null = null;
  try {
    usersText = await readFile(path.join(args.humanDir, "users.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (usersText !== null) {
    let usersRaw: unknown;
    try {
      usersRaw = JSON.parse(usersText);
    } catch {
      throw new Error("users.json 不是合法 JSON");
    }
    const parsed = M1UserObservationSchema.safeParse(usersRaw);
    if (!parsed.success) {
      throw new Error("users.json 未通过 Schema 校验");
    }
    userObservation = parsed.data;
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
        aggregateStoryMap: {
          status: aggregate.status,
          misses: aggregate.misses,
          unmeasured: aggregate.unmeasured,
        },
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

  // 5. 脱敏仪表盘报告：--report-dir 时与 metrics.json 同目录，否则写入 docs/evals/runs。
  const reportPath = args.reportDirProvided
    ? path.join(runDirectory, "report.md")
    : path.join(
        repositoryRoot,
        "docs",
        "evals",
        "runs",
        `m1-dashboard-${timestamp}-${randomSuffix}-${commitSha.slice(0, 7)}.md`,
      );
  await mkdir(path.dirname(reportPath), { recursive: true });
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
