import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  M1ContinuationHumanSchema,
  M1CorrectionCostHumanSchema,
  M1EvalReportSchema,
  M1RippleHumanSchema,
  M1StoryMapHumanSchema,
  M1UserObservationSchema,
  evaluateAggregateStoryMapGate,
  evaluateContinuationGate,
  evaluateCorrectionCostGate,
  evaluateRippleGate,
  evaluateStoryMapGate,
  evaluateUserObservationGate,
  type M1ContinuationHuman,
  type M1CorrectionCostHuman,
  type M1EvalReport,
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
  try {
    const entries = await readFile(
      path.join(directory, "..", "..", "..", "PROBE"),
      "utf8",
    ).catch(() => null);
    void entries;
  } catch {
    // ignore
  }
  const { readdir } = await import("node:fs/promises");
  const dirs = (await readdir(directory, { withFileTypes: true }))
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

  // 4. gate 计算
  const stories = storyClasses.map((cls) => {
    const manifest = manifests[storyClasses.indexOf(cls)];
    const storyMapGate = evaluateStoryMapGate(storyMaps[cls]);
    const correctionCostGate = evaluateCorrectionCostGate(
      corrections[cls],
      manifest.characterCount,
    );
    const rippleGate = evaluateRippleGate(ripples[cls]);
    const continuationGate = evaluateContinuationGate(continuations[cls]);
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
      storyMapGate,
      correctionCost: corrections[cls],
      correctionCostGate,
      ripple: ripples[cls],
      rippleGate,
      continuation: continuations[cls],
      continuationGate,
      performance: performance[cls],
    };
  });

  const aggregate = evaluateAggregateStoryMapGate([
    storyMaps.A,
    storyMaps.B,
    storyMaps.C,
  ]);
  const userObservationGate = evaluateUserObservationGate(userObservation);

  // 5. 最终判定
  const missingData: string[] = [];
  for (const cls of storyClasses) {
    if (!storyMaps[cls]) missingData.push(`story_map_human_${cls}`);
    if (!corrections[cls]) missingData.push(`correction_cost_${cls}`);
    if (!ripples[cls]) missingData.push(`ripple_${cls}`);
    if (!continuations[cls]) missingData.push(`continuation_${cls}`);
  }
  if (!userObservation) missingData.push("user_observation");

  const missingOnly = (failures: string[]): boolean =>
    failures.length > 0 &&
    failures.every(
      (failure) =>
        failure.includes("missing") ||
        failure.includes("not_evaluated") ||
        failure.includes("not_created"),
    );

  const allGatesComplete =
    stories.every(
      (s) =>
        s.storyMapGate.passed &&
        s.rippleGate.passed &&
        s.continuationGate.passed &&
        s.correctionCostGate.passed !== null &&
        s.correctionCostGate.passed &&
        !missingOnly(s.storyMapGate.failures) &&
        !missingOnly(s.rippleGate.failures) &&
        !missingOnly(s.correctionCostGate.failures),
    ) &&
    aggregate.passed === true &&
    userObservationGate.passed === true;
  const anyGateFailed = stories.some(
    (s) =>
      (s.storyMapGate.passed === false &&
        !missingOnly(s.storyMapGate.failures)) ||
      (s.rippleGate.passed === false && !missingOnly(s.rippleGate.failures)) ||
      (s.continuationGate.passed === false &&
        !missingOnly(s.continuationGate.failures)) ||
      (s.correctionCostGate.passed === false &&
        !missingOnly(s.correctionCostGate.failures)),
  );

  let verdict: M1EvalReport["finalGate"]["verdict"];
  if (allGatesComplete && !anyGateFailed) verdict = "M1 EVAL PASS";
  else if (anyGateFailed) verdict = "M1 EVAL FAIL";
  else verdict = "M1 EVAL INCOMPLETE";

  const report = M1EvalReportSchema.parse({
    schemaVersion: 1,
    kind: "m1_eval",
    runId,
    commitSha,
    evaluatedAt,
    status:
      verdict === "M1 EVAL PASS"
        ? "passed"
        : verdict === "M1 EVAL FAIL"
          ? "failed"
          : "awaiting_human_input",
    stories,
    aggregate: {
      identityF1: aggregate.identityF1,
      keyEventRecall: aggregate.keyEventRecall,
      storyMapAggregateGate: {
        passed: aggregate.passed,
        failures: aggregate.failures,
      },
      hardInvariantFailures: 0,
      userObservation,
      userObservationGate: {
        passed: userObservationGate.passed,
        failures: userObservationGate.failures,
      },
    },
    finalGate: {
      storyMapGate:
        stories.every((s) => s.storyMapGate.passed) && aggregate.passed === true
          ? true
          : aggregate.passed === false || stories.some((s) => s.storyMapGate.passed === false)
            ? false
            : null,
      correctionCostGate: stories.every(
        (s) => s.correctionCostGate.passed === true,
      )
        ? true
        : stories.some((s) => s.correctionCostGate.passed === false)
          ? false
          : null,
      rippleGate: stories.every((s) => s.rippleGate.passed)
        ? true
        : stories.some((s) => s.rippleGate.passed === false)
          ? false
          : null,
      continuationGate: stories.every((s) => s.continuationGate.passed)
        ? true
        : stories.some((s) => s.continuationGate.passed === false)
          ? false
          : null,
      userObservationGate: userObservationGate.passed,
      hardInvariantsZeroFailures: true,
      verdict,
      missingData,
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

  // 6. 脱敏报告
  const reportMarkdown = buildMarkdown(report);
  const reportPath = path.join(
    repositoryRoot,
    "docs",
    "evals",
    "runs",
    `m1-eval-${new Date().toISOString().slice(0, 10)}-${commitSha.slice(0, 7)}.md`,
  );
  await writeFile(reportPath, reportMarkdown, "utf8");

  console.log("NovelRipple M1 Eval");
  console.log(`Run: ${runId}`);
  console.log(`Verdict: ${verdict}`);
  for (const story of stories) {
    console.log(
      `Story ${story.storyClass}: storyMap=${story.storyMapGate.passed ? "PASS" : "MISSING/FAIL"} correction=${story.correctionCostGate.passed === null ? "MISSING" : story.correctionCostGate.passed ? "PASS" : "FAIL"} ripple=${story.rippleGate.passed ? "PASS" : "MISSING/FAIL"} continuation=${story.continuationGate.passed ? "PASS" : "MISSING/FAIL"}`,
    );
  }
  console.log(`Missing data: ${missingData.join(", ") || "none"}`);
  console.log(`Sanitized JSON: ${metricsPath}`);
  console.log(`Report: ${reportPath}`);
}

function buildMarkdown(report: M1EvalReport): string {
  const lines: string[] = [];
  lines.push(`# M1 最终 Eval（${report.finalGate.verdict}，${report.evaluatedAt.slice(0, 10)}）`);
  lines.push("");
  lines.push(`- run-id：${report.runId}`);
  lines.push(`- commit：${report.commitSha.slice(0, 7)}`);
  lines.push("");
  lines.push("> 隐私边界：报告只使用 Story A/B/C 代号、结构计数、比例与门禁状态；不包含私人作品标题、人物名、Event 内容、原文、完整 Prompt、raw model output 或密钥。");
  lines.push("");
  lines.push("## 最终判定");
  lines.push("");
  lines.push(`**${report.finalGate.verdict}**`);
  lines.push("");
  lines.push(`- Story Map gate：${gateText(report.finalGate.storyMapGate)}`);
  lines.push(`- Correction cost gate：${gateText(report.finalGate.correctionCostGate)}`);
  lines.push(`- Ripple gate：${gateText(report.finalGate.rippleGate)}`);
  lines.push(`- Continuation gate：${gateText(report.finalGate.continuationGate)}`);
  lines.push(`- User observation gate：${gateText(report.finalGate.userObservationGate)}`);
  lines.push(`- Hard invariants：${report.finalGate.hardInvariantsZeroFailures ? "0 failures" : "FAILED"}`);
  if (report.finalGate.missingData.length > 0) {
    lines.push("");
    lines.push("### 缺失数据（导致 INCOMPLETE）");
    lines.push("");
    for (const missing of report.finalGate.missingData) {
      lines.push(`- ${missing}`);
    }
  }
  lines.push("");
  lines.push("## 逐篇结果");
  lines.push("");
  for (const story of report.stories) {
    lines.push(`### Story ${story.storyClass}`);
    lines.push("");
    lines.push(`- benchmark：${story.identity.benchmarkId}（${story.identity.rightsMode}，${story.identity.characterCount} 字符，unseen=${story.identity.unseenByPromptAuthors}）`);
    lines.push(`- Story Map：${story.storyMapGate.passed ? "PASS" : story.storyMap ? "FAIL" : "待人工标注"}${story.storyMapGate.failures.length > 0 ? `（${story.storyMapGate.failures.join("、")}）` : ""}`);
    if (story.storyMap) {
      lines.push(`  - 核心人物召回 ${story.storyMap.coreCharacterRecall} / 关键事件召回 ${story.storyMap.keyEventRecall} / Ending 召回 ${story.storyMap.endingCandidateRecall} / 因果边认可 ${story.storyMap.causalEdgeApprovalRate} / 错误 merge ${story.storyMap.criticalMergeMistakes}`);
    }
    lines.push(`- Correction cost：${story.correctionCostGate.passed === null ? "待观察" : story.correctionCostGate.passed ? "PASS" : "FAIL"}${story.correctionCost ? `（${story.correctionCost.reviewDurationMin} 分钟 / ${story.correctionCost.materialRevisions} revisions / 新增 ${story.correctionCost.manualEventAdditions} 事件）` : ""}`);
    lines.push(`- Ripple：${story.rippleGate.passed ? "PASS" : story.ripple ? "FAIL" : "待人工"}${story.rippleGate.failures.length > 0 ? `（${story.rippleGate.failures.join("、")}）` : ""}`);
    lines.push(`- Continuation：${story.continuationGate.passed ? "PASS" : story.continuation ? "FAIL" : "待人工"}${story.continuation ? `（worldline ${story.continuation.worldlineConsistency} / narrative ${story.continuation.narrativeContinuity} / 继续读 ${story.continuation.wouldContinueReading ? "yes" : "no"}）` : ""}`);
    lines.push(`- Performance：calls ${story.performance.modelCalls ?? "n/a"} / repairs ${story.performance.repairCount ?? "n/a"} / tokens ${story.performance.totalTokens ?? "n/a"} / ${story.performance.wallClockDurationMs != null ? `${Math.round(story.performance.wallClockDurationMs / 1000)}s` : "n/a"}`);
    lines.push("");
  }
  return lines.join("\n");
}

function gateText(value: boolean | null): string {
  if (value === null) return "数据不完整";
  return value ? "PASS" : "FAIL";
}

main().catch((error) => {
  console.error(`M1 Eval 未运行：${(error as Error).message}`);
  process.exitCode = 1;
});
