import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  RippleSuggestionsModelOutputSchema,
  type RippleSuggestionsModelOutput,
  type StoryMap,
} from "@/domain/schemas";
import { generateStructured } from "@/server/ai/generate-structured";
import type {
  AIProvider,
  ModelConfig,
  StructuredValidationIssue,
} from "@/server/ai/types";
import { createRippleSuggestionsArtifact } from "@/server/repositories/ripple-suggestions-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

const promptVersion = "ripple-suggestions.v3";

export async function generateRippleSuggestions(input: {
  projectId: string;
  storyMapArtifactId: string;
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

  const storyMap = storyMapArtifact.storyMap;
  const template = await readFile(
    path.join(process.cwd(), "prompts", `${promptVersion}.md`),
    "utf8",
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
    }),
    "</suggestion_context>",
  ].join("\n\n");

  const generation = await generateStructured(
    {
      projectId: input.projectId,
      worldlineId: null,
      kind: "ripple_suggestions",
      promptVersion,
      prompt,
      schemaName: "ripple_suggestions",
      schema: RippleSuggestionsModelOutputSchema,
      modelConfig: input.modelConfig,
      validate: (output) => validateSuggestions(output, storyMap),
    },
    input.provider,
  );
  const artifact = createRippleSuggestionsArtifact({
    projectId: input.projectId,
    storyMapArtifact,
    suggestions: generation.value.suggestions,
    generationRunId: generation.generation.runId,
  });
  return { artifact, generation: generation.generation };
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
