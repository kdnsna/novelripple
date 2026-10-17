import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateStoryMap } from "@/domain/invariants/validate-story-map";
import {
  StoryMapEndingPassCandidateSchema,
  StoryMapExtractionCandidateSchema,
  StoryMapGleaningCandidateSchema,
  StoryMapMergeCandidateSchema,
  StoryMapRosterCandidateSchema,
  StoryMapSchema,
  type Source,
  type StoryMapContentCandidate,
  type StoryMapExtractionCandidate,
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
  type NameCandidate,
} from "@/domain/source/name-candidates";
import { resolveStoryMapContentCandidate } from "@/domain/source/resolve-story-map-evidence";
import {
  applyEndingPass,
  applyMerge,
  applyRoster,
  poolChunkCandidates,
  validateChunkExtraction,
  validateChunkGleaning,
  validateEndingPass,
  validateRoster,
  type ChunkCandidate,
  type StoryMapPool,
} from "@/domain/story-map/assemble-story-map-candidate";
import { generateStructured } from "@/server/ai/generate-structured";
import type {
  AIProvider,
  ModelConfig,
  StructuredValidationIssue,
} from "@/server/ai/types";
import { getProjectSource } from "@/server/repositories/project-repository";
import { createStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

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
  extract: "story-map-chunk.v1",
  glean: "story-map-glean.v1",
  names: "story-map-names.v1",
  endings: "story-map-endings.v1",
  merge: "story-map-merge.v1",
} as const;

/** 结局轮次读取的全书末尾比例（按自然段数）。 */
const ENDING_TAIL_RATIO = 0.2;
const ENDING_TAIL_MIN_UNITS = 3;
/** 同时进行的分块请求数。 */
const CHUNK_CONCURRENCY = 4;

export async function generateStoryMap(input: {
  projectId: string;
  sourceId: string;
  provider: AIProvider;
  modelConfig: ModelConfig;
}) {
  const source = getProjectSource(input.projectId, input.sourceId);
  if (!source) throw new Error("找不到指定的 Source");

  const templates = await loadTemplates();
  const units = deriveEvidenceUnits(source);
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const unitOrder = new Map(units.map((unit, index) => [unit.id, index]));
  const chunks = deriveEvidenceUnitChunks(units);
  const nameHints = deriveNameCandidates(units);
  const structured = <T>(
    stage: {
      kind: string;
      promptVersion: string;
      schemaName: string;
      schema: Parameters<typeof generateStructured<T>>[0]["schema"];
    },
    prompt: string,
    validate: (value: T) => StructuredValidationIssue[],
  ) =>
    generateStructured<T>(
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
      },
      input.provider,
    );

  // 1. 每块抽取
  const chunkContexts = chunks.map((chunk) => {
    const allowed = new Set([...chunk.contextUnitIds, ...chunk.coreUnitIds]);
    const packet = buildChunkPacket(source, chunk, unitsById);
    const coreText = chunk.coreUnitIds.map((id) => unitsById.get(id)!.text).join("\n");
    const hints = nameHints.filter((hint) => coreText.includes(hint.name));
    return { chunk, allowed, packet, hints };
  });
  const extractions = await mapWithConcurrency(chunkContexts, CHUNK_CONCURRENCY, (context) =>
    structured(
      {
        kind: "story_map_extract",
        promptVersion: STORY_MAP_PROMPT_VERSIONS.extract,
        schemaName: "story_map_extraction",
        schema: StoryMapExtractionCandidateSchema,
      },
      [templates.extract, formatNameHints("name_hints", context.hints), context.packet].join("\n\n"),
      (value) => validateChunkExtraction(value, context.allowed),
    ),
  );

  // 2. 每块补抽一轮
  const gleanings = await mapWithConcurrency(chunkContexts, CHUNK_CONCURRENCY, (context, index) => {
    const extraction = extractions[index]!.value;
    return structured(
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
    );
  });

  const chunkCandidates: ChunkCandidate[] = chunks.map((chunk, index) => ({
    chunkIndex: chunk.index,
    extraction: extractions[index]!.value,
    gleaning: gleanings[index]!.value,
  }));
  const pooled = poolChunkCandidates(chunkCandidates, unitOrder);

  // 3. 人名归并
  const roster = await structured(
    {
      kind: "story_map_names",
      promptVersion: STORY_MAP_PROMPT_VERSIONS.names,
      schemaName: "story_map_roster",
      schema: StoryMapRosterCandidateSchema,
    },
    [
      templates.names,
      formatNameHints("name_hints", nameHints),
      "<character_candidates>",
      JSON.stringify(pooled.characters),
      "</character_candidates>",
    ].join("\n\n"),
    (value) => validateRoster(value, pooled),
  );
  const withRoster = applyRoster(pooled, roster.value);

  // 4. 结局 / 人物结局
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

  // 5. 全书合并（Artifact 绑定这一 Run）
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

  const resolved = resolveStoryMapContentCandidate(finalCandidate, source, units);
  if (!resolved.success) {
    throw new Error(
      `已校验的 Story Map Evidence 无法解析：${resolved.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const artifact = createStoryMapArtifact({
    projectId: input.projectId,
    sourceId: source.id,
    content: resolved.content,
    generationRunId: merge.generation.runId,
  });

  return {
    artifact,
    generation: {
      chunkCount: chunks.length,
      extractorRunIds: extractions.map((item) => item.generation.runId),
      gleaningRunIds: gleanings.map((item) => item.generation.runId),
      namesRunId: roster.generation.runId,
      endingsRunId: endingPass.generation.runId,
      reconcilerRunId: merge.generation.runId,
    },
  };
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

function uncoveredHints(
  hints: NameCandidate[],
  extraction: StoryMapExtractionCandidate,
): NameCandidate[] {
  const known = extraction.characters.flatMap((character) => [character.name, ...character.aliases]);
  return hints.filter(
    (hint) => !known.some((name) => name.includes(hint.name) || hint.name.includes(name)),
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
