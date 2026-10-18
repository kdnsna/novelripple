import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { z } from "zod";

import { validateStoryMap } from "@/domain/invariants/validate-story-map";
import {
  StoryMapEndingPassCandidateSchema,
  StoryMapExtractionCandidateSchema,
  StoryMapGleaningCandidateSchema,
  StoryMapGenerationSchema,
  StoryMapMergeCandidateSchema,
  StoryMapRosterCandidateSchema,
  StoryMapSchema,
  type JobProgress,
  type Source,
  type StoryMapContentCandidate,
  type StoryMapExtractionCandidate,
  type StoryMapGleaningCandidate,
} from "@/domain/schemas";
import {
  deriveEvidenceUnitChunks,
  type EvidenceUnitChunk,
} from "@/domain/source/evidence-unit-chunks";
import {
  deriveEvidenceUnits,
  type EvidenceUnit,
} from "@/domain/source/evidence-units";
import {
  deriveNameCandidates,
  isCollectiveName,
  type NameCandidate,
} from "@/domain/source/name-candidates";
import { resolveStoryMapContentCandidate } from "@/domain/source/resolve-story-map-evidence";
import {
  applyEndingPass,
  applyMerge,
  applyRoster,
  dropGroupCandidates,
  poolChunkCandidates,
  validateChunkExtraction,
  validateChunkGleaning,
  validateEndingPass,
  validateRoster,
  type ChunkCandidate,
  type StoryMapPool,
} from "@/domain/story-map/assemble-story-map-candidate";
import { generateStructured } from "@/server/ai/generate-structured";
import {
  resolveStoryMapLimits,
  type StoryMapLimits,
} from "@/server/story-map/story-map-limits";
import type {
  AIProvider,
  ModelConfig,
  StructuredValidationIssue,
} from "@/server/ai/types";
import { getProjectSource } from "@/server/repositories/project-repository";
import { createStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";
import {
  listStoryMapChunkCheckpoints,
  saveStoryMapChunkCheckpoint,
  storyMapChunkCheckpointKey,
  sumStoryMapCheckpointModelCalls,
  type StoredStoryMapChunkCheckpoint,
} from "@/server/repositories/story-map-checkpoint-repository";

/**
 * Story Map 分块召回管线（Phase 1）：
 *
 *   确定性分块 + 人名候选
 *   → 每块抽取（story_map_extract）
 *   → 每块「还漏了什么」补抽一轮（story_map_glean）
 *   → 人名归并（story_map_names）
 *   → 结局 / 人物结局（story_map_endings）
 *   → 全书合并（story_map_reconcile，Artifact 绑定这一 Run）
 *
 * 每个阶段都只接受 Unit ID 证据，并在该阶段做引用校验；最终候选再走现有的
 * Evidence 解析 + 领域校验。任一阶段一次 repair 后仍不合法即 fail closed，
 * 不写入 Artifact；Source 只读。
 */
export const STORY_MAP_PROMPT_VERSIONS = {
  extract: "story-map-chunk.v4",
  glean: "story-map-glean.v4",
  names: "story-map-names.v2",
  endings: "story-map-endings.v2",
  merge: "story-map-merge.v4",
} as const;

/** 结局轮次读取的全书末尾比例（按自然段数）。 */
const ENDING_TAIL_RATIO = 0.2;
const ENDING_TAIL_MIN_UNITS = 3;
/** 同时进行的分块请求数。 */
const CHUNK_CONCURRENCY = 4;
/** 达到该分块数时，在模型调用前打印一次规模与成本预警。 */
export const STORY_MAP_WARN_CHUNK_COUNT = 20;

export async function generateStoryMap(input: {
  projectId: string;
  sourceId: string;
  provider: AIProvider;
  modelConfig: ModelConfig;
  limits?: Partial<StoryMapLimits>;
  /**
   * 只观察阶段与计数；默认 no-op。callback 不参与 Prompt、校验或调用次数，
   * 因此开启/关闭进度不会改变任何生成结果。
   */
  onProgress?: (progress: JobProgress) => void;
  /**
   * 同一次逻辑生成的多次 attempt 共享的 run group。缺省时生成一个随机 group，
   * 因此普通调用仍然从零开始；重试必须显式传入上一 attempt 的 group。
   */
  runGroupId?: string;
  /** 同一 run group 中此前 attempt 已消耗的模型调用数；计入上限。 */
  previousModelCalls?: number;
  /** 每次真正发起 provider 调用前触发，用于把本 attempt 的调用数持久化。 */
  onModelCall?: (modelCallsThisAttempt: number) => void;
}) {
  const reportProgress = input.onProgress ?? (() => {});
  const source = getProjectSource(input.projectId, input.sourceId);
  if (!source) throw new Error("找不到指定的 Source");

  const templates = await loadTemplates();
  const limits = resolveStoryMapLimits(input.limits);
  const units = deriveEvidenceUnits(source);
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const unitOrder = new Map(units.map((unit, index) => [unit.id, index]));
  const chunks = deriveEvidenceUnitChunks(units);
  if (chunks.length > limits.maxChunks) {
    throw new Error(
      `Story Map 分块数 ${chunks.length} 超过上限 ${limits.maxChunks}（STORY_MAP_MAX_CHUNKS）；未调用模型`,
    );
  }

  const nameHints = deriveNameCandidates(units);
  // 1. 每块抽取（模型主导人物识别；第一轮不接收任何规则人名提示）
  const chunkContexts = chunks.map((chunk) => {
    const allowed = new Set([...chunk.contextUnitIds, ...chunk.coreUnitIds]);
    const packet = buildChunkPacket(source, chunk, unitsById);
    const coreText = chunk.coreUnitIds.map((id) => unitsById.get(id)!.text).join("\n");
    // 规则候选只用于补抽轮的“可能漏名”提示；群体名不进入提示。
    const hints = nameHints.filter(
      (hint) => coreText.includes(hint.name) && !isCollectiveName(hint.name),
    );
    return { chunk, allowed, packet, hints };
  });

  // 分块检查点：key 覆盖 Source、分块计划、全部 Prompt 版本与模型身份。
  const runGroupId = input.runGroupId ?? `run_${randomUUID()}`;
  const checkpointKeys = chunks.map((chunk) =>
    storyMapChunkCheckpointKey({
      sourceId: source.id,
      sourceContentHash: source.contentHash,
      chunk,
      promptVersions: STORY_MAP_PROMPT_VERSIONS,
      model: input.modelConfig.model,
      providerName: input.provider.providerName,
    }),
  );
  const checkpointByKeyStage = new Map<
    string,
    StoredStoryMapChunkCheckpoint
  >();
  for (const row of listStoryMapChunkCheckpoints({
    projectId: input.projectId,
    runGroupId,
  })) {
    const lookupKey = `${row.checkpointKey}:${row.stage}`;
    // 查询按新行在前；同一 key + stage 只取最新一条。
    if (!checkpointByKeyStage.has(lookupKey)) {
      checkpointByKeyStage.set(lookupKey, row);
    }
  }

  const reusedExtractions = new Map<number, StoryMapExtractionCandidate>();
  const reusedGleanings = new Map<number, StoryMapGleaningCandidate>();
  // 复用检查点时保留产生它的原始 run id；迁移前写入的旧行没有 run id。
  const reusedExtractionRunIds = new Map<number, string | null>();
  const reusedGleaningRunIds = new Map<number, string | null>();
  chunks.forEach((chunk, index) => {
    const context = chunkContexts[index]!;
    const extractionCheckpoint = checkpointByKeyStage.get(
      `${checkpointKeys[index]}:extract`,
    );
    const extraction = parseCheckpointResult(
      extractionCheckpoint,
      StoryMapExtractionCandidateSchema,
      (value) => validateChunkExtraction(value, context.allowed),
    );
    if (!extraction) return;
    reusedExtractions.set(chunk.index, extraction);
    reusedExtractionRunIds.set(
      chunk.index,
      extractionCheckpoint?.generationRunId ?? null,
    );
    const gleaningCheckpoint = checkpointByKeyStage.get(
      `${checkpointKeys[index]}:glean`,
    );
    const gleaning = parseCheckpointResult(
      gleaningCheckpoint,
      StoryMapGleaningCandidateSchema,
      (value) => validateChunkGleaning(value, extraction, context.allowed),
    );
    if (gleaning) {
      reusedGleanings.set(chunk.index, gleaning);
      reusedGleaningRunIds.set(
        chunk.index,
        gleaningCheckpoint?.generationRunId ?? null,
      );
    }
  });
  const reusedExtractionCount = reusedExtractions.size;
  const reusedGleaningCount = reusedGleanings.size;
  const reusedChunks = chunks.filter(
    (chunk) =>
      reusedExtractions.has(chunk.index) && reusedGleanings.has(chunk.index),
  ).length;
  const previousModelCalls =
    input.previousModelCalls ??
    sumStoryMapCheckpointModelCalls({
      projectId: input.projectId,
      runGroupId,
    });
  const estimatedRemainingCalls =
    chunks.length -
    reusedExtractionCount +
    (chunks.length - reusedGleaningCount) +
    3;
  if (previousModelCalls + estimatedRemainingCalls > limits.maxModelCalls) {
    const message =
      previousModelCalls === 0 &&
      reusedExtractionCount === 0 &&
      reusedGleaningCount === 0
        ? `Story Map 预计基础模型调用 ${estimatedRemainingCalls} 次超过上限 ${limits.maxModelCalls}（STORY_MAP_MAX_MODEL_CALLS）；未调用模型`
        : `Story Map 此前已用 ${previousModelCalls} 次模型调用，本次预计至少 ${estimatedRemainingCalls} 次，` +
          `合计超过上限 ${limits.maxModelCalls}（STORY_MAP_MAX_MODEL_CALLS）；未调用模型`;
    throw new Error(message);
  }

  const emitProgress = (progress: JobProgress) => {
    reportProgress(
      reusedChunks > 0 &&
        (progress.stage === "chunking" ||
          progress.stage === "extract" ||
          progress.stage === "glean")
        ? { ...progress, reusedChunks }
        : progress,
    );
  };
  emitProgress({
    stage: "chunking",
    completed: chunks.length,
    total: chunks.length,
  });

  const extractionPrompts = chunkContexts.map((context) =>
    [templates.extract, context.packet].join("\n\n"),
  );
  if (chunks.length >= STORY_MAP_WARN_CHUNK_COUNT) {
    // 粗略下限：按抽取 prompt 长度 × 2 估算本次剩余抽取 + 补抽；不含 names / endings / merge 与模型输出。
    const estimatedInputChars = extractionPrompts.reduce(
      (total, prompt) => total + prompt.length * 2,
      0,
    );
    console.warn(
      `[story-map] 分块数 ${chunks.length}；本次预计基础模型调用 ${estimatedRemainingCalls} 次，最坏 ${estimatedRemainingCalls * 2} 次；` +
        `预计输入约 ${estimatedInputChars} 字符（约 ${estimatedInputChars} tokens，按 prompt 字符粗略估算）`,
    );
  }

  let modelCallsThisAttempt = 0;
  let totalModelCalls = previousModelCalls;
  const countModelAttempt = () => {
    modelCallsThisAttempt += 1;
    totalModelCalls += 1;
    if (totalModelCalls > limits.maxModelCalls) {
      throw new Error(
        `Story Map 模型调用次数超过上限 ${limits.maxModelCalls}（STORY_MAP_MAX_MODEL_CALLS）`,
      );
    }
    // 在 provider 调用前落库；进程随后崩溃也不会漏算这次预算。
    input.onModelCall?.(modelCallsThisAttempt);
  };
  const structured = async <T>(
    stage: {
      kind: string;
      promptVersion: string;
      schemaName: string;
      schema: Parameters<typeof generateStructured<T>>[0]["schema"];
    },
    prompt: string,
    validate: (value: T) => StructuredValidationIssue[],
    signal?: AbortSignal,
  ) => {
    let calls = 0;
    const result = await generateStructured<T>(
      {
        projectId: input.projectId,
        worldlineId: null,
        kind: stage.kind,
        promptVersion: stage.promptVersion,
        prompt,
        schemaName: stage.schemaName,
        schema: stage.schema,
        modelConfig: input.modelConfig,
        validate,
        onAttempt: () => {
          calls += 1;
          countModelAttempt();
        },
        ...(signal ? { signal } : {}),
      },
      input.provider,
    );
    return { ...result, modelCalls: calls };
  };

  emitProgress({
    stage: "extract",
    completed: reusedExtractionCount,
    total: chunks.length,
  });
  let extractionCompleted = reusedExtractionCount;
  // 按分块序号预填：复用分块保留原始 run id，新调用在下方按同一序号覆盖。
  // 数组不能按完成顺序 push，否则并发完成顺序会打乱来源追踪。
  const extractorRunIds: Array<string | null> = chunks.map(
    (chunk) => reusedExtractionRunIds.get(chunk.index) ?? null,
  );
  const extractions = await mapWithConcurrency(chunkContexts, CHUNK_CONCURRENCY, async (context, index, signal) => {
    const reused = reusedExtractions.get(context.chunk.index);
    if (reused) return reused;
    const result = await structured(
      {
        kind: "story_map_extract",
        promptVersion: STORY_MAP_PROMPT_VERSIONS.extract,
        schemaName: "story_map_extraction",
        schema: StoryMapExtractionCandidateSchema,
      },
      extractionPrompts[index]!,
      (value) => validateChunkExtraction(value, context.allowed),
      signal,
    );
    saveStoryMapChunkCheckpoint({
      projectId: input.projectId,
      sourceId: source.id,
      sourceContentHash: source.contentHash,
      runGroupId,
      checkpointKey: checkpointKeys[index]!,
      chunkIndex: context.chunk.index,
      stage: "extract",
      result: result.value,
      modelCalls: result.modelCalls,
      generationRunId: result.generation.runId,
    });
    extractorRunIds[context.chunk.index] = result.generation.runId;
    extractionCompleted += 1;
    emitProgress({ stage: "extract", completed: extractionCompleted, total: chunks.length });
    return result.value;
  });

  // 2. 每块补抽一轮
  emitProgress({
    stage: "glean",
    completed: reusedGleaningCount,
    total: chunks.length,
  });
  let gleaningCompleted = reusedGleaningCount;
  const gleaningRunIds: Array<string | null> = chunks.map(
    (chunk) => reusedGleaningRunIds.get(chunk.index) ?? null,
  );
  const gleanings = await mapWithConcurrency(chunkContexts, CHUNK_CONCURRENCY, async (context, index, signal) => {
    const reused = reusedGleanings.get(context.chunk.index);
    if (reused) return reused;
    const extraction = extractions[index]!;
    const result = await structured(
      {
        kind: "story_map_glean",
        promptVersion: STORY_MAP_PROMPT_VERSIONS.glean,
        schemaName: "story_map_gleaning",
        schema: StoryMapGleaningCandidateSchema,
      },
      [
        templates.glean,
        formatNameHints("uncovered_name_hints", uncoveredHints(context.hints, extraction)),
        context.packet,
        "<previous_extraction>",
        JSON.stringify(extraction),
        "</previous_extraction>",
      ].join("\n\n"),
      (value) => validateChunkGleaning(value, extraction, context.allowed),
      signal,
    );
    saveStoryMapChunkCheckpoint({
      projectId: input.projectId,
      sourceId: source.id,
      sourceContentHash: source.contentHash,
      runGroupId,
      checkpointKey: checkpointKeys[index]!,
      chunkIndex: context.chunk.index,
      stage: "glean",
      result: result.value,
      modelCalls: result.modelCalls,
      generationRunId: result.generation.runId,
    });
    gleaningRunIds[context.chunk.index] = result.generation.runId;
    gleaningCompleted += 1;
    emitProgress({ stage: "glean", completed: gleaningCompleted, total: chunks.length });
    return result.value;
  });

  const chunkCandidates: ChunkCandidate[] = chunks.map((chunk, index) => ({
    chunkIndex: chunk.index,
    extraction: extractions[index]!,
    gleaning: gleanings[index]!,
  }));
  const pooled = poolChunkCandidates(chunkCandidates, unitOrder);
  // 群体 / 家族 / 机构在人名归并前丢弃；只剩群体参与者的事件保留一个群体作为最小例外。
  const individualPool = dropGroupCandidates(pooled);

  // 3. 人名归并（规则候选只作为过滤后的“可能漏名/别名”提示）
  reportProgress({ stage: "names", completed: 0, total: 1 });
  const roster = await structured(
    {
      kind: "story_map_names",
      promptVersion: STORY_MAP_PROMPT_VERSIONS.names,
      schemaName: "story_map_roster",
      schema: StoryMapRosterCandidateSchema,
    },
    [
      templates.names,
      formatNameHints("name_hints", filterRosterHints(nameHints, individualPool.characters)),
      "<character_candidates>",
      JSON.stringify(individualPool.characters),
      "</character_candidates>",
    ].join("\n\n"),
    (value) => validateRoster(value, individualPool),
  );
  const withRoster = applyRoster(individualPool, roster.value);
  reportProgress({ stage: "names", completed: 1, total: 1 });

  // 4. 结局 / 人物结局
  reportProgress({ stage: "endings", completed: 0, total: 1 });
  const tailUnits = units.slice(
    Math.max(0, units.length - Math.max(ENDING_TAIL_MIN_UNITS, Math.ceil(units.length * ENDING_TAIL_RATIO))),
  );
  const endingUnitIds = new Set([
    ...tailUnits.map((unit) => unit.id),
    ...withRoster.events.flatMap((event) => event.evidenceUnitIds),
  ]);
  const endingPass = await structured(
    {
      kind: "story_map_endings",
      promptVersion: STORY_MAP_PROMPT_VERSIONS.endings,
      schemaName: "story_map_endings",
      schema: StoryMapEndingPassCandidateSchema,
    },
    [
      templates.endings,
      buildUnitsPacket("story_ending_text", source, tailUnits),
      "<events>",
      JSON.stringify(compactEvents(withRoster)),
      "</events>",
      "<characters>",
      JSON.stringify(withRoster.characters),
      "</characters>",
    ].join("\n\n"),
    (value) => validateEndingPass(value, withRoster, endingUnitIds),
  );
  const withEndings = applyEndingPass(withRoster, endingPass.value);
  reportProgress({ stage: "endings", completed: 1, total: 1 });

  // 5. 全书合并（Artifact 绑定这一 Run）
  reportProgress({ stage: "merge", completed: 0, total: 1 });
  const totalCoreChars = chunks.reduce(
    (total, chunk) =>
      total +
      chunk.coreUnitIds.reduce((sum, id) => sum + unitsById.get(id)!.text.length, 0),
    0,
  );
  let finalCandidate: StoryMapContentCandidate | undefined;
  const merge = await structured(
    {
      kind: "story_map_reconcile",
      promptVersion: STORY_MAP_PROMPT_VERSIONS.merge,
      schemaName: "story_map_merge",
      schema: StoryMapMergeCandidateSchema,
    },
    [
      templates.merge,
      formatGranularityHint(totalCoreChars),
      "<events>",
      JSON.stringify(compactEvents(withEndings.pool)),
      "</events>",
      "<edges>",
      JSON.stringify(withEndings.pool.edges.map(({ id, from, to, type }) => ({ id, from, to, type }))),
      "</edges>",
      "<characters>",
      JSON.stringify(withEndings.pool.characters.map(({ id, name, aliases }) => ({ id, name, aliases }))),
      "</characters>",
      "<endings>",
      JSON.stringify(withEndings.endings.map(({ id, targetEventId, requirement }) => ({ id, targetEventId, requirement }))),
      "</endings>",
    ].join("\n\n"),
    (value) => {
      const applied = applyMerge(withEndings.pool, withEndings.endings, value);
      if (!applied.success) return applied.issues;
      const issues = validateCandidate(applied.candidate, source, units);
      if (issues.length === 0) finalCandidate = applied.candidate;
      return issues;
    },
  );
  if (!finalCandidate) throw new Error("Story Map 合并结果缺失");
  reportProgress({ stage: "merge", completed: 1, total: 1 });

  const resolved = resolveStoryMapContentCandidate(finalCandidate, source, units);
  if (!resolved.success) {
    throw new Error(
      `已校验的 Story Map Evidence 无法解析：${resolved.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  reportProgress({ stage: "saving", completed: 0, total: 1 });
  const artifact = createStoryMapArtifact({
    projectId: input.projectId,
    sourceId: source.id,
    content: resolved.content,
    generationRunId: merge.generation.runId,
  });
  reportProgress({ stage: "saving", completed: 1, total: 1 });

  const generation = StoryMapGenerationSchema.parse({
    chunkCount: chunks.length,
    reusedChunks,
    // 按分块顺序记录产生该分块抽取/补抽结果的 Run，每个分块占一个位置；
    // 复用检查点时包含原始 run id。迁移前写入、没有 run id 的旧检查点
    // 无法伪造来源，保留 null 占位，保证位置仍对应分块。
    extractorRunIds,
    gleaningRunIds,
    namesRunId: roster.generation.runId,
    endingsRunId: endingPass.generation.runId,
    reconcilerRunId: merge.generation.runId,
  });

  return { artifact, generation };
}

function validateCandidate(
  candidate: StoryMapContentCandidate,
  source: Source,
  evidenceUnits: EvidenceUnit[],
): StructuredValidationIssue[] {
  const resolved = resolveStoryMapContentCandidate(candidate, source, evidenceUnits);
  if (!resolved.success) return resolved.issues;
  const storyMap = StoryMapSchema.safeParse({
    schemaVersion: 1,
    id: "story_map_candidate",
    sourceId: source.id,
    version: 1,
    status: "draft",
    ...resolved.content,
  });
  if (!storyMap.success) {
    return storyMap.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
  }
  return validateStoryMap(storyMap.data, source);
}

function buildChunkPacket(
  source: Source,
  chunk: EvidenceUnitChunk,
  unitsById: Map<string, EvidenceUnit>,
): string {
  const describe = (id: string, ownership: "core" | "context") => {
    const unit = unitsById.get(id)!;
    return { id: unit.id, sectionId: unit.sectionId, ownership, text: unit.text };
  };
  return [
    `<story_chunk id="${chunk.id}" sourceId="${source.id}">`,
    JSON.stringify([
      ...chunk.contextUnitIds.map((id) => describe(id, "context")),
      ...chunk.coreUnitIds.map((id) => describe(id, "core")),
    ]),
    "</story_chunk>",
  ].join("\n");
}

function buildUnitsPacket(tag: string, source: Source, units: EvidenceUnit[]): string {
  return [
    `<${tag} sourceId="${source.id}">`,
    JSON.stringify(units.map((unit) => ({ id: unit.id, sectionId: unit.sectionId, text: unit.text }))),
    `</${tag}>`,
  ].join("\n");
}

function compactEvents(pool: StoryMapPool) {
  return pool.events.map((event, index) => ({
    id: event.id,
    order: index + 1,
    chunk: event.chunkIndex + 1,
    title: event.title,
    summary: event.summary,
    participants: event.participants,
    evidenceUnitIds: event.evidenceUnitIds,
  }));
}

function formatNameHints(tag: string, hints: NameCandidate[]): string {
  return `<${tag}>${JSON.stringify(hints.map(({ name, count }) => ({ name, count })))}</${tag}>`;
}

/** 最终合并轮的事件预算提示：按核心文本字符数给出目标事件范围（下限 3）。 */
function formatGranularityHint(coreTextChars: number): string {
  const lower = Math.max(3, Math.round(coreTextChars / 1000));
  const upper = Math.max(lower, Math.round(coreTextChars / 600));
  return [
    "<granularity_hint>",
    JSON.stringify({ coreTextChars, targetEventRange: [lower, upper] }),
    "</granularity_hint>",
  ].join("\n");
}

/** 人名轮只看到“尚未覆盖、且不像群体”的规则候选，避免把群体名当成别名。 */
function filterRosterHints(
  hints: NameCandidate[],
  characters: { name: string; aliases: string[] }[],
): NameCandidate[] {
  const known = new Set(
    characters.flatMap((character) => [
      character.name.trim(),
      ...character.aliases.map((alias) => alias.trim()),
    ]),
  );
  return hints.filter((hint) => !isCollectiveName(hint.name) && !known.has(hint.name));
}

function uncoveredHints(
  hints: NameCandidate[],
  extraction: StoryMapExtractionCandidate,
): NameCandidate[] {
  const known = extraction.characters.flatMap((character) => [character.name, ...character.aliases]);
  return hints.filter(
    (hint) =>
      !isCollectiveName(hint.name) &&
      !known.some((name) => name.includes(hint.name) || hint.name.includes(name)),
  );
}

/**
 * 检查点只在 schema 与当前分块的 Unit 范围都再次校验通过时才复用；
 * 损坏、旧版或 key 不匹配的行一律忽略并重新生成，不让坏检查点进入 Artifact。
 */
function parseCheckpointResult<T>(
  checkpoint: StoredStoryMapChunkCheckpoint | undefined,
  schema: z.ZodType<T>,
  validate: (value: T) => StructuredValidationIssue[],
): T | null {
  if (!checkpoint) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(checkpoint.resultJson);
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) return null;
  try {
    return validate(result.data).length === 0 ? result.data : null;
  } catch {
    return null;
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const controller = new AbortController();
  let next = 0;
  let failed = false;
  let rejectFailure: (error: unknown) => void = () => {};
  const firstFailure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });

  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index]!, index, controller.signal);
      } catch (error) {
        if (!failed) {
          failed = true;
          controller.abort(error);
          rejectFailure(error);
        }
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  // 第一处失败立即 reject；不再调度新任务，并通过 signal 中止在途请求。
  return Promise.race([Promise.all(workers).then(() => results), firstFailure]);
}

async function loadTemplates() {
  const entries = await Promise.all(
    Object.entries(STORY_MAP_PROMPT_VERSIONS).map(async ([key, version]) => [
      key,
      await readFile(path.join(process.cwd(), "prompts", `${version}.md`), "utf8"),
    ]),
  );
  return Object.fromEntries(entries) as Record<keyof typeof STORY_MAP_PROMPT_VERSIONS, string>;
}
