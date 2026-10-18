import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  RippleSuggestionsModelOutputSchema,
  type RippleSuggestionsArtifact,
  type RippleSuggestionsModelOutput,
  type StoryMap,
  type StoryMapArtifact,
} from "@/domain/schemas";
import { generateStructured } from "@/server/ai/generate-structured";
import { runWithInFlightLock } from "@/server/ai/in-flight-generation";
import type {
  AIProvider,
  ModelConfig,
  StructuredValidationIssue,
} from "@/server/ai/types";
import { countRippleSuggestionGenerationRunsForStoryMap } from "@/server/repositories/generation-run-repository";
import {
  createRippleSuggestionsArtifact,
  findRippleSuggestionsArtifactByIdempotencyKey,
  getLatestRippleSuggestionsArtifact,
  listRippleSuggestionsBatchesForStoryMap,
  stableRippleSuggestionsArtifactId,
} from "@/server/repositories/ripple-suggestions-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";
import {
  resolveRippleSuggestionMaxBatches,
  rippleSuggestionAttemptLimit,
} from "@/server/ripple/ripple-suggestion-limits";

const promptVersion = "ripple-suggestions.v4";

export async function generateRippleSuggestions(input: {
  projectId: string;
  storyMapArtifactId: string;
  /** 只有显式换批才携带；自动首次加载走既有复用路径。 */
  idempotencyKey?: string | null;
  maxBatches?: number;
  provider: AIProvider;
  modelConfig: ModelConfig;
}) {
  const storyMapArtifact = getStoryMapArtifact(input.storyMapArtifactId);
  if (
    !storyMapArtifact ||
    storyMapArtifact.projectId !== input.projectId ||
    storyMapArtifact.storyMap.status !== "confirmed"
  ) {
    throw new Error("只有 confirmed Story Map 才能生成 Ripple Suggestions");
  }

  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey !== null) {
    return generateRippleSuggestionsBatch({
      input,
      storyMapArtifact,
      idempotencyKey,
    });
  }

  // 自动首次加载：同一 revision 已有任一批次就复用最新批次，不产生模型调用。
  const existing = latestSuggestions(input);
  if (existing) return { artifact: existing, generation: null };

  return runWithInFlightLock(
    `ripple_suggestions:${input.storyMapArtifactId}`,
    async () => {
      const lockedExisting = latestSuggestions(input);
      if (lockedExisting) {
        return { artifact: lockedExisting, generation: null };
      }
      // 与换批共享同一 revision 锁，避免首次加载与换批同时分配批次。
      return runWithInFlightLock(
        `ripple_suggestions_batches:${input.storyMapArtifactId}`,
        async () => {
          const batches = batchesFor(input);
          const latest = batches[batches.length - 1];
          if (latest) return { artifact: latest, generation: null };
          return generateBatch({
            input,
            storyMapArtifact,
            batchIndex: 0,
            refreshOf: null,
            idempotencyKey: null,
            previousBatches: [],
          });
        },
      );
    },
  );
}

async function generateRippleSuggestionsBatch(input: {
  input: {
    projectId: string;
    storyMapArtifactId: string;
    maxBatches?: number;
    provider: AIProvider;
    modelConfig: ModelConfig;
  };
  storyMapArtifact: StoryMapArtifact;
  idempotencyKey: string;
}) {
  // 同一 key 的重试/并发请求直接返回同一 Artifact，不读取 Prompt、不调用模型。
  const existingByKey = findRippleSuggestionsArtifactByIdempotencyKey(
    input.input.projectId,
    input.storyMapArtifact.id,
    input.idempotencyKey,
  );
  if (existingByKey) return { artifact: existingByKey, generation: null };

  const batches = batchesFor(input.input);
  if (batches.length === 0) {
    throw new Error("Ripple Suggestions 还没有首批，不能换一批");
  }
  const nextBatchIndex =
    Math.max(...batches.map((batch) => batch.batchIndex)) + 1;
  const targetArtifactId = stableRippleSuggestionsArtifactId(
    input.storyMapArtifact.id,
    nextBatchIndex,
    input.idempotencyKey,
  );

  return runWithInFlightLock(targetArtifactId, async () => {
    const raced = findRippleSuggestionsArtifactByIdempotencyKey(
      input.input.projectId,
      input.storyMapArtifact.id,
      input.idempotencyKey,
    );
    if (raced) return { artifact: raced, generation: null };

    // 真实并发语义：同一 revision 的 in-flight 锁只执行第一个进入的 task，
    // 其余并发请求（即使幂等键不同）await 同一个 Promise 并收到该批次，
    // 因此一次突发只分配一个 batchIndex、只发生一次模型调用。锁释放后
    // 到达的新键请求才会重新读取已持久化批次，串行分配下一个 batchIndex。
    return runWithInFlightLock(
      `ripple_suggestions_batches:${input.storyMapArtifact.id}`,
      async () => {
        const locked = findRippleSuggestionsArtifactByIdempotencyKey(
          input.input.projectId,
          input.storyMapArtifact.id,
          input.idempotencyKey,
        );
        if (locked) return { artifact: locked, generation: null };

        const currentBatches = batchesFor(input.input);
        if (currentBatches.length === 0) {
          throw new Error("Ripple Suggestions 还没有首批，不能换一批");
        }
        const batchIndex =
          Math.max(
            ...currentBatches.map((batch) => batch.batchIndex),
          ) + 1;
        const refreshOf =
          currentBatches[currentBatches.length - 1]?.id ?? null;
        return generateBatch({
          input: input.input,
          storyMapArtifact: input.storyMapArtifact,
          batchIndex,
          refreshOf,
          idempotencyKey: input.idempotencyKey,
          previousBatches: currentBatches,
        });
      },
    );
  });
}

async function generateBatch(input: {
  input: {
    projectId: string;
    storyMapArtifactId: string;
    maxBatches?: number;
    provider: AIProvider;
    modelConfig: ModelConfig;
  };
  storyMapArtifact: StoryMapArtifact;
  batchIndex: number;
  refreshOf: string | null;
  idempotencyKey: string | null;
  previousBatches: RippleSuggestionsArtifact[];
}) {
  // 批次与尝试上限都在任何 Prompt 读取与模型调用之前检查。
  const maxBatches = resolveRippleSuggestionMaxBatches(input.input.maxBatches);
  if (input.batchIndex >= maxBatches) {
    throw new Error(
      `Ripple Suggestions 已达到本 Story Map revision 的换一批上限（${maxBatches} 批）`,
    );
  }
  // 失败调用不会留下批次 Artifact，只数批次会让失败重试无限调用模型。
  // Generation Run 在首次 provider 调用前创建并保留失败行，因此按 revision
  // 统计 pending / succeeded / failed 尝试，成功与失败共享 2 倍预算。
  const attemptLimit = rippleSuggestionAttemptLimit(maxBatches);
  const attempts = countRippleSuggestionGenerationRunsForStoryMap(
    input.input.projectId,
    input.storyMapArtifact.id,
  );
  if (attempts >= attemptLimit) {
    throw new Error(
      `Ripple Suggestions 生成尝试次数已达本 Story Map revision 的上限（含失败重试，最多 ${attemptLimit} 次，对应换一批上限 ${maxBatches} 批）`,
    );
  }

  const storyMap = input.storyMapArtifact.storyMap;
  const template = await readFile(
    path.join(process.cwd(), "prompts", `${promptVersion}.md`),
    "utf8",
  );
  const previousEventIds = new Set(
    input.previousBatches.flatMap((batch) =>
      batch.suggestions.map((suggestion) => suggestion.eventId),
    ),
  );
  const prompt = [
    template,
    "<suggestion_context>",
    JSON.stringify({
      eligibleEventIds: storyMap.events
        .filter((event) =>
          storyMap.edges.some(
            (edge) =>
              edge.from === event.id &&
              (edge.type === "causes" || edge.type === "enables"),
          ),
        )
        .map((event) => event.id),
      events: storyMap.events.map((event) => ({
        id: event.id,
        sequence: event.sequence,
        title: event.title,
        summary: event.summary,
        participants: event.participants,
      })),
      characters: storyMap.characters.map((character) => ({
        id: character.id,
        role: character.role,
      })),
      causalGraph: storyMap.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        type: edge.type,
      })),
      endingCandidates: storyMap.endingCandidates.map((ending) => ({
        id: ending.id,
        targetEventId: ending.targetEventId,
        requirement: ending.requirement,
      })),
      previousBatches: input.previousBatches.map((batch) => ({
        batchIndex: batch.batchIndex,
        suggestions: batch.suggestions.map((suggestion) => ({
          eventId: suggestion.eventId,
          title:
            storyMap.events.find((event) => event.id === suggestion.eventId)
              ?.title ?? suggestion.eventId,
        })),
      })),
      previouslySuggestedEventIds: [...previousEventIds],
    }),
    "</suggestion_context>",
  ].join("\n\n");

  const generation = await generateStructured(
    {
      projectId: input.input.projectId,
      worldlineId: null,
      storyMapArtifactId: input.storyMapArtifact.id,
      kind: "ripple_suggestions",
      promptVersion,
      prompt,
      schemaName: "ripple_suggestions",
      schema: RippleSuggestionsModelOutputSchema,
      modelConfig: input.input.modelConfig,
      validate: (output) => validateSuggestions(output, storyMap),
    },
    input.input.provider,
  );
  const artifact = createRippleSuggestionsArtifact({
    projectId: input.input.projectId,
    storyMapArtifact: input.storyMapArtifact,
    suggestions: generation.value.suggestions,
    generationRunId: generation.generation.runId,
    batchIndex: input.batchIndex,
    refreshOf: input.refreshOf,
    idempotencyKey: input.idempotencyKey,
  });
  return { artifact, generation: generation.generation };
}

function batchesFor(input: {
  projectId: string;
  storyMapArtifactId: string;
}) {
  return listRippleSuggestionsBatchesForStoryMap(
    input.projectId,
    input.storyMapArtifactId,
  );
}

function latestSuggestions(input: {
  projectId: string;
  storyMapArtifactId: string;
}) {
  return getLatestRippleSuggestionsArtifact(
    input.projectId,
    input.storyMapArtifactId,
  );
}

function validateSuggestions(
  output: RippleSuggestionsModelOutput,
  storyMap: StoryMap,
): StructuredValidationIssue[] {
  const issues: StructuredValidationIssue[] = [];
  const eventsById = new Map(storyMap.events.map((event) => [event.id, event]));
  const characterIds = new Set(
    storyMap.characters.map((character) => character.id),
  );
  const suggestedEventIds = new Set<string>();
  const causalAdjacency = new Map<string, string[]>();
  for (const edge of storyMap.edges) {
    if (edge.type === "foreshadows") continue;
    causalAdjacency.set(edge.from, [
      ...(causalAdjacency.get(edge.from) ?? []),
      edge.to,
    ]);
  }
  const finalSequence = Math.max(...storyMap.events.map((event) => event.sequence));

  output.suggestions.forEach((suggestion, index) => {
    const path = `suggestions.${index}`;
    const event = eventsById.get(suggestion.eventId);
    if (!event) {
      issues.push({ path: `${path}.eventId`, message: "建议引用了未知 Event" });
    } else if (
      event.sequence === finalSequence ||
      !hasDownstreamEvent(event.id, causalAdjacency)
    ) {
      issues.push({
        path: `${path}.eventId`,
        message: "建议 Event 没有可验证的后续因果空间",
      });
    }
    if (suggestedEventIds.has(suggestion.eventId)) {
      issues.push({ path: `${path}.eventId`, message: "不得重复推荐同一 Event" });
    }
    suggestedEventIds.add(suggestion.eventId);

    const seenCharacters = new Set<string>();
    suggestion.affectedCharacterIds.forEach((characterId, characterIndex) => {
      if (!characterIds.has(characterId)) {
        issues.push({
          path: `${path}.affectedCharacterIds.${characterIndex}`,
          message: "建议引用了未知 Character",
        });
      }
      if (seenCharacters.has(characterId)) {
        issues.push({
          path: `${path}.affectedCharacterIds.${characterIndex}`,
          message: "建议包含重复 Character",
        });
      }
      seenCharacters.add(characterId);
    });
  });
  return issues;
}

function hasDownstreamEvent(
  eventId: string,
  adjacency: Map<string, string[]>,
): boolean {
  return (adjacency.get(eventId)?.length ?? 0) > 0;
}
