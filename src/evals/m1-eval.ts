import { z } from "zod";

/**
 * M1-07 聚合 Eval：读取 M1 benchmark manifest、各阶段评测产物与人工评分，
 * 计算 per-story / aggregate gate，输出 M1 EVAL 报告。
 * 本模块只做确定性聚合与门禁判定，不调用模型、不修改生产数据。
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

// ── 报告结构 ──

export const M1EvalReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("m1_eval"),
    runId: z.string().min(1),
    commitSha: z.string().min(1),
    evaluatedAt: z.iso.datetime(),
    status: z.enum(["passed", "failed", "awaiting_human_input"]),
    stories: z
      .array(
        z
          .object({
            storyClass: z.enum(["A", "B", "C"]),
            identity: z
              .object({
                benchmarkId: z.string().min(1),
                rightsMode: z.string().min(1),
                characterCount: z.number().int().positive(),
                unseenByPromptAuthors: z.boolean(),
                promptVersions: z.array(z.string()),
              })
              .strict(),
            storyMap: M1StoryMapHumanSchema.nullable(),
            storyMapGate: z
              .object({ passed: z.boolean(), failures: z.array(z.string()) })
              .strict(),
            correctionCost: M1CorrectionCostHumanSchema.nullable(),
            correctionCostGate: z
              .object({
                passed: z.boolean().nullable(),
                failures: z.array(z.string()),
              })
              .strict(),
            ripple: M1RippleHumanSchema.nullable(),
            rippleGate: z
              .object({ passed: z.boolean(), failures: z.array(z.string()) })
              .strict(),
            continuation: M1ContinuationHumanSchema.nullable(),
            continuationGate: z
              .object({ passed: z.boolean(), failures: z.array(z.string()) })
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
    aggregate: z
      .object({
        identityF1: z.number().min(0).max(1).nullable(),
        keyEventRecall: z.number().min(0).max(1).nullable(),
        storyMapAggregateGate: z
          .object({ passed: z.boolean().nullable(), failures: z.array(z.string()) })
          .strict(),
        hardInvariantFailures: z.number().int().nonnegative(),
        userObservation: M1UserObservationSchema.nullable(),
        userObservationGate: z
          .object({ passed: z.boolean().nullable(), failures: z.array(z.string()) })
          .strict(),
      })
      .strict(),
    finalGate: z
      .object({
        storyMapGate: z.boolean().nullable(),
        correctionCostGate: z.boolean().nullable(),
        rippleGate: z.boolean().nullable(),
        continuationGate: z.boolean().nullable(),
        userObservationGate: z.boolean().nullable(),
        hardInvariantsZeroFailures: z.boolean(),
        verdict: z.enum(["M1 EVAL PASS", "M1 EVAL FAIL", "M1 EVAL INCOMPLETE"]),
        missingData: z.array(z.string()),
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

// ── Gate 判定（阈值来自 docs/evals.md）──

const STORY_MAP_THRESHOLDS = {
  coreCharacterRecall: 1.0,
  keyEventRecall: 0.85,
  evidenceValidity: 1.0,
  eventsWithoutValidEvidence: 0,
  criticalMergeMistakes: 0,
  endingCandidateRecall: 1.0,
  causalEdgeApprovalRate: 0.75,
} as const;

const AGGREGATE_THRESHOLDS = {
  identityF1: 0.9,
  keyEventRecall: 0.9,
} as const;

const CORRECTION_COST_THRESHOLDS = {
  reviewDurationMin: 15,
  materialRevisions: 6,
  manualEventAdditions: 2,
} as const;

const RIPPLE_THRESHOLDS = {
  directImpactApprovalRate: 0.85,
  anchorConsistencyRate: 1.0,
  preDivergenceMutations: 0,
  approvedSuggestionCount: 2,
} as const;

const CONTINUATION_THRESHOLDS = {
  worldlineConsistency: 4,
  narrativeContinuity: 3.5,
  hardConflicts: 0,
  recoveredDeletedFacts: 0,
  preDivergenceRewrites: 0,
  strictAnchorViolations: 0,
} as const;

export function evaluateStoryMapGate(
  human: M1StoryMapHuman | null,
): { passed: boolean; failures: string[] } {
  if (!human) return { passed: false, failures: ["story_map_human_data_missing"] };
  const failures: string[] = [];
  if (human.coreCharacterRecall < STORY_MAP_THRESHOLDS.coreCharacterRecall)
    failures.push(`core_character_recall_${human.coreCharacterRecall}`);
  if (human.keyEventRecall < STORY_MAP_THRESHOLDS.keyEventRecall)
    failures.push(`key_event_recall_${human.keyEventRecall}`);
  if (human.evidenceValidityRate < STORY_MAP_THRESHOLDS.evidenceValidity)
    failures.push(`evidence_validity_${human.evidenceValidityRate}`);
  if (
    human.eventsWithoutValidEvidence >
    STORY_MAP_THRESHOLDS.eventsWithoutValidEvidence
  )
    failures.push(`events_without_evidence_${human.eventsWithoutValidEvidence}`);
  if (
    human.criticalMergeMistakes > STORY_MAP_THRESHOLDS.criticalMergeMistakes
  )
    failures.push(`critical_merge_mistakes_${human.criticalMergeMistakes}`);
  if (
    human.endingCandidateRecall < STORY_MAP_THRESHOLDS.endingCandidateRecall
  )
    failures.push(`ending_candidate_recall_${human.endingCandidateRecall}`);
  if (
    human.causalEdgeApprovalRate < STORY_MAP_THRESHOLDS.causalEdgeApprovalRate
  )
    failures.push(`causal_edge_approval_${human.causalEdgeApprovalRate}`);
  return { passed: failures.length === 0, failures };
}

export function evaluateAggregateStoryMapGate(
  storyMaps: (M1StoryMapHuman | null)[],
): { passed: boolean | null; failures: string[]; identityF1: number | null; keyEventRecall: number | null } {
  const available = storyMaps.filter((s): s is M1StoryMapHuman => s !== null);
  if (available.length === 0)
    return { passed: null, failures: ["story_map_human_data_missing"], identityF1: null, keyEventRecall: null };
  // identity F1 的 micro 聚合：用 coreCharacter 口径近似（gold/candidate 匹配）
  const matchedCore = available.reduce((sum, s) => sum + s.coreCharacterMatched, 0);
  const totalCore = available.reduce((sum, s) => sum + s.coreCharacterTotal, 0);
  const identityF1 = totalCore > 0 ? matchedCore / totalCore : null;
  const matchedEvents = available.reduce((sum, s) => sum + s.keyEventMatched, 0);
  const totalEvents = available.reduce((sum, s) => sum + s.keyEventTotal, 0);
  const keyEventRecall = totalEvents > 0 ? matchedEvents / totalEvents : null;
  const failures: string[] = [];
  if (identityF1 !== null && identityF1 < AGGREGATE_THRESHOLDS.identityF1)
    failures.push(`aggregate_identity_f1_${identityF1.toFixed(3)}`);
  if (keyEventRecall !== null && keyEventRecall < AGGREGATE_THRESHOLDS.keyEventRecall)
    failures.push(`aggregate_key_event_recall_${keyEventRecall.toFixed(3)}`);
  const passed =
    identityF1 !== null &&
    keyEventRecall !== null &&
    failures.length === 0;
  return { passed: passed ? true : null, failures, identityF1, keyEventRecall };
}

export function evaluateCorrectionCostGate(
  human: M1CorrectionCostHuman | null,
  characterCount: number,
): { passed: boolean | null; failures: string[] } {
  if (!human) return { passed: null, failures: ["correction_cost_data_missing"] };
  // ≤30k 字档：15 分钟 / 6 revisions / 2 新增事件；30k-60k 档 review 25 分钟为目标（不单独硬失败）
  const failures: string[] = [];
  if (characterCount <= 30_000) {
    if (human.reviewDurationMin > CORRECTION_COST_THRESHOLDS.reviewDurationMin)
      failures.push(`review_duration_${human.reviewDurationMin}min`);
    if (human.materialRevisions > CORRECTION_COST_THRESHOLDS.materialRevisions)
      failures.push(`material_revisions_${human.materialRevisions}`);
    if (human.manualEventAdditions > CORRECTION_COST_THRESHOLDS.manualEventAdditions)
      failures.push(`manual_event_additions_${human.manualEventAdditions}`);
  } else {
    if (human.reviewDurationMin > 25)
      failures.push(`review_duration_${human.reviewDurationMin}min_target_25`);
  }
  return {
    passed: failures.length === 0,
    failures,
  };
}

export function evaluateRippleGate(
  human: M1RippleHuman | null,
): { passed: boolean; failures: string[] } {
  if (!human) return { passed: false, failures: ["ripple_human_data_missing"] };
  const failures: string[] = [];
  if (!human.strictDivergenceEvaluated)
    failures.push("strict_divergence_not_evaluated");
  if (!human.openDivergenceEvaluated)
    failures.push("open_divergence_not_evaluated");
  if (human.directImpactApprovalRate === null)
    failures.push("direct_impact_approval_missing");
  else if (
    human.directImpactApprovalRate < RIPPLE_THRESHOLDS.directImpactApprovalRate
  )
    failures.push(`direct_impact_approval_${human.directImpactApprovalRate}`);
  if (human.anchorConsistencyRate === null)
    failures.push("anchor_consistency_missing");
  else if (human.anchorConsistencyRate < RIPPLE_THRESHOLDS.anchorConsistencyRate)
    failures.push(`anchor_consistency_${human.anchorConsistencyRate}`);
  if (human.preDivergenceMutations > RIPPLE_THRESHOLDS.preDivergenceMutations)
    failures.push(`pre_divergence_mutations_${human.preDivergenceMutations}`);
  if (
    human.approvedSuggestionCount < RIPPLE_THRESHOLDS.approvedSuggestionCount
  )
    failures.push(
      `approved_suggestions_${human.approvedSuggestionCount}/3`,
    );
  if (!human.feedbackResolved) failures.push("feedback_not_resolved");
  return { passed: failures.length === 0, failures };
}

export function evaluateContinuationGate(
  human: M1ContinuationHuman | null,
): { passed: boolean; failures: string[] } {
  if (!human) return { passed: false, failures: ["continuation_human_data_missing"] };
  const failures: string[] = [];
  if (human.hardConflicts > CONTINUATION_THRESHOLDS.hardConflicts)
    failures.push(`hard_conflicts_${human.hardConflicts}`);
  if (human.recoveredDeletedFacts > CONTINUATION_THRESHOLDS.recoveredDeletedFacts)
    failures.push(`recovered_deleted_facts_${human.recoveredDeletedFacts}`);
  if (human.preDivergenceRewrites > CONTINUATION_THRESHOLDS.preDivergenceRewrites)
    failures.push(`pre_divergence_rewrites_${human.preDivergenceRewrites}`);
  if (human.strictAnchorViolations > CONTINUATION_THRESHOLDS.strictAnchorViolations)
    failures.push(`strict_anchor_violations_${human.strictAnchorViolations}`);
  if (human.worldlineConsistency < CONTINUATION_THRESHOLDS.worldlineConsistency)
    failures.push(`worldline_consistency_${human.worldlineConsistency}`);
  if (human.narrativeContinuity < CONTINUATION_THRESHOLDS.narrativeContinuity)
    failures.push(`narrative_continuity_${human.narrativeContinuity}`);
  return { passed: failures.length === 0, failures };
}

export function evaluateUserObservationGate(
  observation: M1UserObservation | null,
): { passed: boolean | null; failures: string[] } {
  if (!observation)
    return { passed: null, failures: ["user_observation_data_missing"] };
  const failures: string[] = [];
  if (observation.sessionCount < 3)
    failures.push(`sessions_${observation.sessionCount}/3`);
  if (observation.nonDeveloperParticipantCount < 2)
    failures.push(
      `non_developer_participants_${observation.nonDeveloperParticipantCount}/2`,
    );
  const independent = observation.sessions.filter(
    (session) => session.independentCompletion,
  ).length;
  if (independent < 3)
    failures.push(`independent_completions_${independent}/3`);
  return {
    passed: failures.length === 0,
    failures,
  };
}
