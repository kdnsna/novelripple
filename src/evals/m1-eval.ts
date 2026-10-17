import { z } from "zod";

/**
 * 人工评分来源。作者自评（author）是有效评分；external 表示非作者评审。
 * 缺省视为 author。
 */
export const ReviewerSchema = z.enum(["author", "external"]);

/**
 * M1 质量仪表盘：读取 M1 benchmark manifest、各阶段评测产物与人工评分，
 * 输出两类结论：
 *
 * 1. 硬规则（hard rules）——原文/分歧前历史不被覆盖、证据可追溯、世界线隔离、
 *    坏输出被拒绝。任一被测到违反即为 `hard_rule_violation`，脚本以非零退出。
 * 2. 质量目标（quality targets）——召回率、修正成本、人工评分、真人观察等。
 *    只记录 met / below_target / not_measured，**不阻塞开发或发布**。
 *
 * 本模块只做确定性聚合，不调用模型、不修改生产数据。
 * 决策记录见 docs/decisions/0005-eval-dashboard-not-gate.md。
 */

// ── 人工输入（来自 novelripple-m1-review-kit/m1-07-human/，不进 Git）──

export const M1StoryMapHumanSchema = z
  .object({
    storyClass: z.enum(["A", "B", "C"]),
    coreCharacterRecall: z.number().min(0).max(1),
    coreCharacterTotal: z.number().int().positive(),
    coreCharacterMatched: z.number().int().nonnegative(),
    identityF1: z.number().min(0).max(1),
    keyEventRecall: z.number().min(0).max(1),
    keyEventTotal: z.number().int().positive(),
    keyEventMatched: z.number().int().nonnegative(),
    endingCandidateRecall: z.number().min(0).max(1),
    criticalMergeMistakes: z.number().int().nonnegative(),
    causalEdgeApprovalRate: z.number().min(0).max(1),
    evidenceValidityRate: z.number().min(0).max(1),
    eventsWithoutValidEvidence: z.number().int().nonnegative(),
    reviewer: ReviewerSchema.optional(),
    notes: z.string().optional(),
  })
  .strict();

export const M1CorrectionCostHumanSchema = z
  .object({
    storyClass: z.enum(["A", "B", "C"]),
    reviewDurationMin: z.number().positive(),
    materialRevisions: z.number().int().nonnegative(),
    manualEventAdditions: z.number().int().nonnegative(),
    characterFixes: z.number().int().nonnegative(),
    edgeFixes: z.number().int().nonnegative(),
    reviewer: ReviewerSchema.optional(),
    notes: z.string().optional(),
  })
  .strict();

export const M1RippleHumanSchema = z
  .object({
    storyClass: z.enum(["A", "B", "C"]),
    strictDivergenceEvaluated: z.boolean(),
    openDivergenceEvaluated: z.boolean(),
    approvedSuggestionCount: z.number().int().min(0).max(3),
    directImpactApprovalRate: z.number().min(0).max(1).nullable(),
    anchorConsistencyRate: z.number().min(0).max(1).nullable(),
    preDivergenceMutations: z.number().int().nonnegative(),
    feedbackResolved: z.boolean(),
    reviewer: ReviewerSchema.optional(),
    notes: z.string().optional(),
  })
  .strict();

export const M1ContinuationHumanSchema = z
  .object({
    storyClass: z.enum(["A", "B", "C"]),
    worldlineConsistency: z.number().min(1).max(5),
    characterContinuity: z.number().min(1).max(5),
    narrativeContinuity: z.number().min(1).max(5),
    sceneInterest: z.number().min(1).max(5),
    wouldContinueReading: z.boolean(),
    hardConflicts: z.number().int().nonnegative(),
    recoveredDeletedFacts: z.number().int().nonnegative(),
    preDivergenceRewrites: z.number().int().nonnegative(),
    strictAnchorViolations: z.number().int().nonnegative(),
    reviewer: ReviewerSchema.optional(),
    notes: z.string().optional(),
  })
  .strict();

export const M1UserObservationSchema = z
  .object({
    sessionCount: z.number().int().positive(),
    nonDeveloperParticipantCount: z.number().int().nonnegative(),
    sessions: z
      .array(
        z
          .object({
            sessionId: z.string().min(1),
            participantId: z.string().min(1),
            independentCompletion: z.boolean(),
            blockerCategories: z.array(z.string()),
            wouldUseAgain: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

// ── 仪表盘结构 ──

/** 硬规则状态：not_measured 表示本次没有对应数据，不等于违反。 */
export const HardRuleStatusSchema = z.enum(["pass", "fail", "not_measured"]);
/** 质量目标状态：只用于展示和趋势比较，不阻塞。 */
export const TargetStatusSchema = z.enum([
  "met",
  "below_target",
  "not_measured",
]);

const HardRuleResultSchema = z
  .object({ status: HardRuleStatusSchema, violations: z.array(z.string()) })
  .strict();
const TargetResultSchema = z
  .object({ status: TargetStatusSchema, misses: z.array(z.string()) })
  .strict();

export type HardRuleResult = z.infer<typeof HardRuleResultSchema>;
export type TargetResult = z.infer<typeof TargetResultSchema>;

export const HARD_RULE_IDS = [
  "sourceNotOverwritten",
  "traceability",
  "worldlineIsolation",
  "badOutputRejected",
] as const;
export type HardRuleId = (typeof HARD_RULE_IDS)[number];

const HardRulesSchema = z
  .object({
    sourceNotOverwritten: HardRuleResultSchema,
    traceability: HardRuleResultSchema,
    worldlineIsolation: HardRuleResultSchema,
    badOutputRejected: HardRuleResultSchema,
  })
  .strict();
export type HardRules = z.infer<typeof HardRulesSchema>;

export const M1EvalReportSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("m1_dashboard"),
    runId: z.string().min(1),
    commitSha: z.string().min(1),
    evaluatedAt: z.iso.datetime(),
    /** 只有硬规则被违反才是 hard_rule_violation；质量目标未达标仍是 reported。 */
    status: z.enum(["reported", "hard_rule_violation"]),
    stories: z
      .array(
        z
          .object({
            storyClass: z.enum(["A", "B", "C"]),
            identity: z
              .object({
                benchmarkId: z.string().min(1),
                rightsMode: z.string().min(1),
                characterCount: z.number().int().nonnegative(),
                unseenByPromptAuthors: z.boolean(),
                promptVersions: z.array(z.string()),
              })
              .strict(),
            storyMap: M1StoryMapHumanSchema.nullable(),
            correctionCost: M1CorrectionCostHumanSchema.nullable(),
            ripple: M1RippleHumanSchema.nullable(),
            continuation: M1ContinuationHumanSchema.nullable(),
            hardRules: HardRulesSchema,
            targets: z
              .object({
                storyMap: TargetResultSchema,
                correctionCost: TargetResultSchema,
                ripple: TargetResultSchema,
                continuation: TargetResultSchema,
              })
              .strict(),
            performance: z
              .object({
                modelCalls: z.number().int().nonnegative().nullable(),
                repairCount: z.number().int().nonnegative().nullable(),
                totalTokens: z.number().int().nonnegative().nullable(),
                wallClockDurationMs: z.number().int().nonnegative().nullable(),
              })
              .strict(),
          })
          .strict(),
      )
      .length(3),
    dashboard: z
      .object({
        hardRules: HardRulesSchema,
        hardRulesPassed: z.boolean(),
        targets: z
          .object({
            storyMap: TargetResultSchema,
            aggregateStoryMap: TargetResultSchema,
            correctionCost: TargetResultSchema,
            ripple: TargetResultSchema,
            continuation: TargetResultSchema,
            /** 真人观察是可选项：缺失只记 not_measured。 */
            userObservation: TargetResultSchema,
          })
          .strict(),
        aggregate: z
          .object({
            identityF1: z.number().min(0).max(1).nullable(),
            keyEventRecall: z.number().min(0).max(1).nullable(),
          })
          .strict(),
        userObservation: M1UserObservationSchema.nullable(),
        notMeasured: z.array(z.string()),
      })
      .strict(),
    privacy: z
      .object({
        containsSourceBody: z.literal(false),
        containsRawModelOutput: z.literal(false),
        containsPrivateTitleOrNames: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type M1EvalReport = z.infer<typeof M1EvalReportSchema>;
export type M1StoryMapHuman = z.infer<typeof M1StoryMapHumanSchema>;
export type M1CorrectionCostHuman = z.infer<typeof M1CorrectionCostHumanSchema>;
export type M1RippleHuman = z.infer<typeof M1RippleHumanSchema>;
export type M1ContinuationHuman = z.infer<typeof M1ContinuationHumanSchema>;
export type M1UserObservation = z.infer<typeof M1UserObservationSchema>;

// ── 硬规则（阻塞）──

/**
 * 从人工/自动评分中检查四条硬规则。数据缺失时为 not_measured；
 * 生产路径里同样的规则由领域校验在写入前 fail closed，并由默认 CI 的单元、
 * 合约与 E2E 测试覆盖，这里只是在真实作品评测上再核对一次。
 */
export function evaluateHardRules(input: {
  storyMap: M1StoryMapHuman | null;
  ripple: M1RippleHuman | null;
  continuation: M1ContinuationHuman | null;
}): HardRules {
  const { storyMap, ripple, continuation } = input;
  const rule = (
    measured: boolean,
    violations: string[],
  ): HardRuleResult => ({
    status: !measured ? "not_measured" : violations.length > 0 ? "fail" : "pass",
    violations,
  });

  // 1. 原文 / 分歧前历史不被覆盖
  const overwrite: string[] = [];
  if (ripple && ripple.preDivergenceMutations > 0)
    overwrite.push(`pre_divergence_mutations_${ripple.preDivergenceMutations}`);
  if (continuation && continuation.preDivergenceRewrites > 0)
    overwrite.push(
      `pre_divergence_rewrites_${continuation.preDivergenceRewrites}`,
    );

  // 2. 可溯源：每条证据都能定位到有效原文
  const trace: string[] = [];
  if (storyMap) {
    if (storyMap.evidenceValidityRate < 1)
      trace.push(`evidence_validity_${storyMap.evidenceValidityRate}`);
    if (storyMap.eventsWithoutValidEvidence > 0)
      trace.push(
        `events_without_evidence_${storyMap.eventsWithoutValidEvidence}`,
      );
  }

  // 3. 世界线隔离：被世界线删除的事实不得回流
  const isolation: string[] = [];
  if (continuation && continuation.recoveredDeletedFacts > 0)
    isolation.push(
      `recovered_deleted_facts_${continuation.recoveredDeletedFacts}`,
    );

  // 4. 坏输出必须被拒绝：硬冲突或破坏严格模式锚点的场景不应被采纳
  const badOutput: string[] = [];
  if (continuation) {
    if (continuation.hardConflicts > 0)
      badOutput.push(`hard_conflicts_${continuation.hardConflicts}`);
    if (continuation.strictAnchorViolations > 0)
      badOutput.push(
        `strict_anchor_violations_${continuation.strictAnchorViolations}`,
      );
  }

  return {
    sourceNotOverwritten: rule(Boolean(ripple || continuation), overwrite),
    traceability: rule(Boolean(storyMap), trace),
    worldlineIsolation: rule(Boolean(continuation), isolation),
    badOutputRejected: rule(Boolean(continuation), badOutput),
  };
}

/** 合并多篇作品的硬规则：任一 fail 即 fail；全部未测为 not_measured。 */
export function combineHardRules(all: HardRules[]): HardRules {
  const combine = (id: HardRuleId): HardRuleResult => {
    const results = all.map((rules) => rules[id]);
    const violations = all.flatMap((rules, index) =>
      rules[id].violations.map(
        (violation) => `${["A", "B", "C"][index] ?? index}:${violation}`,
      ),
    );
    const status = results.some((r) => r.status === "fail")
      ? "fail"
      : results.some((r) => r.status === "pass")
        ? "pass"
        : "not_measured";
    return { status, violations };
  };
  return {
    sourceNotOverwritten: combine("sourceNotOverwritten"),
    traceability: combine("traceability"),
    worldlineIsolation: combine("worldlineIsolation"),
    badOutputRejected: combine("badOutputRejected"),
  };
}

export function hardRulesPassed(rules: HardRules): boolean {
  return HARD_RULE_IDS.every((id) => rules[id].status !== "fail");
}

// ── 质量目标（仪表盘，不阻塞；阈值来自 docs/evals.md）──

const STORY_MAP_TARGETS = {
  coreCharacterRecall: 1.0,
  keyEventRecall: 0.85,
  criticalMergeMistakes: 0,
  endingCandidateRecall: 1.0,
  causalEdgeApprovalRate: 0.75,
} as const;

const AGGREGATE_TARGETS = {
  identityF1: 0.9,
  keyEventRecall: 0.9,
} as const;

const CORRECTION_COST_TARGETS = {
  reviewDurationMin: 15,
  materialRevisions: 6,
  manualEventAdditions: 2,
} as const;

const RIPPLE_TARGETS = {
  directImpactApprovalRate: 0.85,
  anchorConsistencyRate: 1.0,
  approvedSuggestionCount: 2,
} as const;

const CONTINUATION_TARGETS = {
  worldlineConsistency: 4,
  narrativeContinuity: 3.5,
} as const;

function target(measured: boolean, misses: string[]): TargetResult {
  return {
    status: !measured ? "not_measured" : misses.length > 0 ? "below_target" : "met",
    misses,
  };
}

export function evaluateStoryMapTargets(
  human: M1StoryMapHuman | null,
): TargetResult {
  if (!human) return target(false, []);
  const misses: string[] = [];
  if (human.coreCharacterRecall < STORY_MAP_TARGETS.coreCharacterRecall)
    misses.push(`core_character_recall_${human.coreCharacterRecall}`);
  if (human.keyEventRecall < STORY_MAP_TARGETS.keyEventRecall)
    misses.push(`key_event_recall_${human.keyEventRecall}`);
  if (human.criticalMergeMistakes > STORY_MAP_TARGETS.criticalMergeMistakes)
    misses.push(`critical_merge_mistakes_${human.criticalMergeMistakes}`);
  if (human.endingCandidateRecall < STORY_MAP_TARGETS.endingCandidateRecall)
    misses.push(`ending_candidate_recall_${human.endingCandidateRecall}`);
  if (human.causalEdgeApprovalRate < STORY_MAP_TARGETS.causalEdgeApprovalRate)
    misses.push(`causal_edge_approval_${human.causalEdgeApprovalRate}`);
  return target(true, misses);
}

export function evaluateAggregateStoryMapTargets(
  storyMaps: (M1StoryMapHuman | null)[],
): TargetResult & { identityF1: number | null; keyEventRecall: number | null } {
  const available = storyMaps.filter((s): s is M1StoryMapHuman => s !== null);
  if (available.length === 0)
    return { ...target(false, []), identityF1: null, keyEventRecall: null };
  // identity F1 的 micro 聚合：用 coreCharacter 口径近似（gold/candidate 匹配）
  const matchedCore = available.reduce((sum, s) => sum + s.coreCharacterMatched, 0);
  const totalCore = available.reduce((sum, s) => sum + s.coreCharacterTotal, 0);
  const identityF1 = totalCore > 0 ? matchedCore / totalCore : null;
  const matchedEvents = available.reduce((sum, s) => sum + s.keyEventMatched, 0);
  const totalEvents = available.reduce((sum, s) => sum + s.keyEventTotal, 0);
  const keyEventRecall = totalEvents > 0 ? matchedEvents / totalEvents : null;
  const misses: string[] = [];
  if (identityF1 !== null && identityF1 < AGGREGATE_TARGETS.identityF1)
    misses.push(`aggregate_identity_f1_${identityF1.toFixed(3)}`);
  if (keyEventRecall !== null && keyEventRecall < AGGREGATE_TARGETS.keyEventRecall)
    misses.push(`aggregate_key_event_recall_${keyEventRecall.toFixed(3)}`);
  return { ...target(true, misses), identityF1, keyEventRecall };
}

export function evaluateCorrectionCostTargets(
  human: M1CorrectionCostHuman | null,
  characterCount: number,
): TargetResult {
  if (!human) return target(false, []);
  // ≤30k 字档：15 分钟 / 6 revisions / 2 新增事件；30k-60k 档 review 25 分钟
  const misses: string[] = [];
  if (characterCount <= 30_000) {
    if (human.reviewDurationMin > CORRECTION_COST_TARGETS.reviewDurationMin)
      misses.push(`review_duration_${human.reviewDurationMin}min`);
    if (human.materialRevisions > CORRECTION_COST_TARGETS.materialRevisions)
      misses.push(`material_revisions_${human.materialRevisions}`);
    if (human.manualEventAdditions > CORRECTION_COST_TARGETS.manualEventAdditions)
      misses.push(`manual_event_additions_${human.manualEventAdditions}`);
  } else if (human.reviewDurationMin > 25) {
    misses.push(`review_duration_${human.reviewDurationMin}min_target_25`);
  }
  return target(true, misses);
}

export function evaluateRippleTargets(
  human: M1RippleHuman | null,
): TargetResult {
  if (!human) return target(false, []);
  const misses: string[] = [];
  if (!human.strictDivergenceEvaluated)
    misses.push("strict_divergence_not_evaluated");
  if (!human.openDivergenceEvaluated)
    misses.push("open_divergence_not_evaluated");
  if (
    human.directImpactApprovalRate !== null &&
    human.directImpactApprovalRate < RIPPLE_TARGETS.directImpactApprovalRate
  )
    misses.push(`direct_impact_approval_${human.directImpactApprovalRate}`);
  if (
    human.anchorConsistencyRate !== null &&
    human.anchorConsistencyRate < RIPPLE_TARGETS.anchorConsistencyRate
  )
    misses.push(`anchor_consistency_${human.anchorConsistencyRate}`);
  if (human.approvedSuggestionCount < RIPPLE_TARGETS.approvedSuggestionCount)
    misses.push(`approved_suggestions_${human.approvedSuggestionCount}/3`);
  if (!human.feedbackResolved) misses.push("feedback_not_resolved");
  return target(true, misses);
}

export function evaluateContinuationTargets(
  human: M1ContinuationHuman | null,
): TargetResult {
  if (!human) return target(false, []);
  const misses: string[] = [];
  if (human.worldlineConsistency < CONTINUATION_TARGETS.worldlineConsistency)
    misses.push(`worldline_consistency_${human.worldlineConsistency}`);
  if (human.narrativeContinuity < CONTINUATION_TARGETS.narrativeContinuity)
    misses.push(`narrative_continuity_${human.narrativeContinuity}`);
  return target(true, misses);
}

/** 真人观察是可选的参考数据：有就展示，没有不影响任何结论。 */
export function evaluateUserObservationTargets(
  observation: M1UserObservation | null,
): TargetResult {
  if (!observation) return target(false, []);
  const misses: string[] = [];
  if (observation.sessionCount < 3)
    misses.push(`sessions_${observation.sessionCount}/3`);
  if (observation.nonDeveloperParticipantCount < 2)
    misses.push(
      `non_developer_participants_${observation.nonDeveloperParticipantCount}/2`,
    );
  const independent = observation.sessions.filter(
    (session) => session.independentCompletion,
  ).length;
  if (independent < 3) misses.push(`independent_completions_${independent}/3`);
  return target(true, misses);
}

/** 把同一块指标的多篇结果合并成一行仪表盘。 */
export function combineTargets(results: TargetResult[]): TargetResult {
  const misses = results.flatMap((result, index) =>
    result.misses.map((miss) => `${["A", "B", "C"][index] ?? index}:${miss}`),
  );
  const measured = results.some((r) => r.status !== "not_measured");
  return target(measured, misses);
}

// ── 脱敏 Markdown 仪表盘 ──

const HARD_RULE_LABELS: Record<HardRuleId, string> = {
  sourceNotOverwritten: "原文与分歧前历史不被覆盖",
  traceability: "证据可溯源",
  worldlineIsolation: "世界线隔离",
  badOutputRejected: "坏输出被拒绝",
};

const HARD_RULE_TEXT = {
  pass: "PASS",
  fail: "**VIOLATED**",
  not_measured: "未测",
} as const;

const TARGET_TEXT = {
  met: "达标",
  below_target: "未达目标",
  not_measured: "未测",
} as const;

function formatTarget(result: TargetResult): string {
  return `${TARGET_TEXT[result.status]}${result.misses.length > 0 ? `（${result.misses.join("、")}）` : ""}`;
}

export function buildM1DashboardMarkdown(report: M1EvalReport): string {
  const { dashboard } = report;
  const lines: string[] = [];
  lines.push(
    `# M1 质量仪表盘（${dashboard.hardRulesPassed ? "硬规则通过" : "硬规则被违反"}，${report.evaluatedAt.slice(0, 10)}）`,
  );
  lines.push("");
  lines.push(`- run-id：${report.runId}`);
  lines.push(`- commit：${report.commitSha.slice(0, 7)}`);
  lines.push("");
  lines.push(
    "> 隐私边界：报告只使用 Story A/B/C 代号、结构计数、比例与状态；不包含私人作品标题、人物名、Event 内容、原文、完整 Prompt、raw model output 或密钥。",
  );
  lines.push(
    "> 质量目标只用于观察趋势，**不阻塞开发或发布**；只有硬规则被违反才需要先修复（见 docs/decisions/0005-eval-dashboard-not-gate.md）。",
  );
  lines.push("");
  lines.push("## 硬规则（阻塞）");
  lines.push("");
  for (const id of HARD_RULE_IDS) {
    const rule = dashboard.hardRules[id];
    lines.push(
      `- ${HARD_RULE_LABELS[id]}：${HARD_RULE_TEXT[rule.status]}${rule.violations.length > 0 ? `（${rule.violations.join("、")}）` : ""}`,
    );
  }
  lines.push("");
  lines.push("## 质量目标（仪表盘，不阻塞）");
  lines.push("");
  lines.push("| 指标 | 状态 |");
  lines.push("| --- | --- |");
  const targetLabels: Record<keyof typeof dashboard.targets, string> = {
    storyMap: "Story Map（单篇）",
    aggregateStoryMap: "Story Map（三篇聚合）",
    correctionCost: "人工修正成本",
    ripple: "Ripple",
    continuation: "Continuation",
    userObservation: "真人观察（可选）",
  };
  for (const key of Object.keys(targetLabels) as (keyof typeof targetLabels)[]) {
    lines.push(`| ${targetLabels[key]} | ${formatTarget(dashboard.targets[key])} |`);
  }
  if (dashboard.notMeasured.length > 0) {
    lines.push("");
    lines.push(`未测数据：${dashboard.notMeasured.join("、")}`);
  }
  lines.push("");
  lines.push("## 逐篇结果");
  lines.push("");
  for (const story of report.stories) {
    lines.push(`### Story ${story.storyClass}`);
    lines.push("");
    lines.push(
      `- benchmark：${story.identity.benchmarkId}（${story.identity.rightsMode}，${story.identity.characterCount} 字符，unseen=${story.identity.unseenByPromptAuthors}）`,
    );
    const violated = HARD_RULE_IDS.filter((id) => story.hardRules[id].status === "fail");
    lines.push(
      `- 硬规则：${violated.length === 0 ? "无违反" : violated.map((id) => `${HARD_RULE_LABELS[id]}（${story.hardRules[id].violations.join("、")}）`).join("；")}`,
    );
    lines.push(`- Story Map：${formatTarget(story.targets.storyMap)}`);
    if (story.storyMap) {
      lines.push(
        `  - 核心人物召回 ${story.storyMap.coreCharacterRecall} / 关键事件召回 ${story.storyMap.keyEventRecall} / Ending 召回 ${story.storyMap.endingCandidateRecall} / 因果边认可 ${story.storyMap.causalEdgeApprovalRate} / 错误 merge ${story.storyMap.criticalMergeMistakes}（评分人：${story.storyMap.reviewer ?? "author"}）`,
      );
    }
    lines.push(
      `- 人工修正成本：${formatTarget(story.targets.correctionCost)}${story.correctionCost ? `（${story.correctionCost.reviewDurationMin} 分钟 / ${story.correctionCost.materialRevisions} revisions / 新增 ${story.correctionCost.manualEventAdditions} 事件）` : ""}`,
    );
    lines.push(`- Ripple：${formatTarget(story.targets.ripple)}`);
    lines.push(
      `- Continuation：${formatTarget(story.targets.continuation)}${story.continuation ? `（worldline ${story.continuation.worldlineConsistency} / narrative ${story.continuation.narrativeContinuity} / 继续读 ${story.continuation.wouldContinueReading ? "yes" : "no"}）` : ""}`,
    );
    lines.push(
      `- Performance：calls ${story.performance.modelCalls ?? "n/a"} / repairs ${story.performance.repairCount ?? "n/a"} / tokens ${story.performance.totalTokens ?? "n/a"} / ${story.performance.wallClockDurationMs != null ? `${Math.round(story.performance.wallClockDurationMs / 1000)}s` : "n/a"}`,
    );
    lines.push("");
  }
  return lines.join("\n");
}
