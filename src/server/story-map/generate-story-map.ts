import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateStoryMap } from "@/domain/invariants/validate-story-map";
import {
  StoryMapLocalExtractionCandidateSchema,
  StoryMapReconciliationCandidateSchema,
  StoryMapSchema,
  type Source,
  type StoryMapLocalExtractionCandidate,
  type StoryMapReconciliationCandidate,
} from "@/domain/schemas";
import {
  deriveAnalysisSegments,
  type AnalysisSegment,
} from "@/domain/source/analysis-segments";
import {
  dedupeResolvedSegmentCandidates,
  resolveLocalStoryMapCandidate,
  resolveReconciledStoryMapCandidate,
  type TemporaryEvidenceReference,
} from "@/domain/source/resolve-story-map-evidence";
import { generateStructured } from "@/server/ai/generate-structured";
import type {
  AIProvider,
  ModelConfig,
  StructuredValidationIssue,
} from "@/server/ai/types";
import { getProjectSource } from "@/server/repositories/project-repository";
import { createStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";
import {
  buildAnalysisSegmentPacket,
  buildGlobalReconcilePacket,
} from "@/server/story-map/story-map-packets";

const extractorPromptVersion = "story-map.v3";
const reconcilerPromptVersion = "story-map-reconcile.v3";

export async function generateStoryMap(input: {
  projectId: string;
  sourceId: string;
  provider: AIProvider;
  modelConfig: ModelConfig;
}) {
  const source = getProjectSource(input.projectId, input.sourceId);
  if (!source) throw new Error("找不到指定的 Source");

  const segments = deriveAnalysisSegments(source);
  const [extractorTemplate, reconcilerTemplate] = await Promise.all([
    loadPrompt(`${extractorPromptVersion}.md`),
    loadPrompt(`${reconcilerPromptVersion}.md`),
  ]);

  const localResults = await mapInPairs(segments, async (segment) => {
    const extraction = await generateStructured(
      {
        projectId: input.projectId,
        worldlineId: null,
        kind: `story_map_extract:${segment.id}`,
        promptVersion: extractorPromptVersion,
        prompt: [
          extractorTemplate,
          buildAnalysisSegmentPacket({
            sourceId: source.id,
            normalizedText: source.normalizedText,
            sections: source.sections,
            segment,
          }),
        ].join("\n\n"),
        schemaName: "story_map_segment",
        schema: StoryMapLocalExtractionCandidateSchema,
        modelConfig: input.modelConfig,
        validate: (candidate) =>
          validateLocalCandidate(candidate, source, segment),
      },
      input.provider,
    );
    const resolved = resolveLocalStoryMapCandidate({
      local: extraction.value,
      source,
      segment,
    });
    if (!resolved.success) {
      throw new Error(
        `已校验的局部 Story Map Evidence 无法解析：${formatIssues(resolved.issues)}`,
      );
    }
    return { segment, generation: extraction.generation, ...resolved };
  });

  const candidates = dedupeResolvedSegmentCandidates(
    localResults.map((result) => result.candidate),
  );
  const references = mergeTemporaryReferences(
    localResults.flatMap((result) => result.references),
  );
  const reconcilePacket = buildGlobalReconcilePacket({
    sourceId: source.id,
    sections: source.sections,
    segments,
    candidates,
    references,
  });
  const reconciliation = await generateStructured(
    {
      projectId: input.projectId,
      worldlineId: null,
      kind: "story_map_reconcile",
      promptVersion: reconcilerPromptVersion,
      prompt: [reconcilerTemplate, reconcilePacket].join("\n\n"),
      schemaName: "story_map_content",
      schema: StoryMapReconciliationCandidateSchema,
      modelConfig: input.modelConfig,
      validate: (candidate) =>
        validateReconciledCandidate(candidate, source, references),
    },
    input.provider,
  );
  const resolved = resolveReconciledStoryMapCandidate({
    candidate: reconciliation.value,
    source,
    references,
  });
  if (!resolved.success) {
    throw new Error(
      `已校验的 Story Map Evidence 无法解析：${formatIssues(resolved.issues)}`,
    );
  }

  const artifact = createStoryMapArtifact({
    projectId: input.projectId,
    sourceId: source.id,
    content: resolved.content,
    generationRunId: reconciliation.generation.runId,
  });

  return {
    artifact,
    generation: {
      extractorRunIds: localResults.map(
        (result) => result.generation.runId,
      ),
      reconcilerRunId: reconciliation.generation.runId,
      analysisSegmentCount: segments.length,
    },
  };
}

async function mapInPairs<T, R>(
  values: T[],
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < values.length; index += 2) {
    results.push(
      ...(await Promise.all(values.slice(index, index + 2).map(worker))),
    );
  }
  return results;
}

function validateLocalCandidate(
  candidate: StoryMapLocalExtractionCandidate,
  source: Source,
  segment: AnalysisSegment,
): StructuredValidationIssue[] {
  const resolved = resolveLocalStoryMapCandidate({
    local: candidate,
    source,
    segment,
  });
  return resolved.success ? [] : resolved.issues;
}

function validateReconciledCandidate(
  candidate: StoryMapReconciliationCandidate,
  source: Source,
  references: TemporaryEvidenceReference[],
): StructuredValidationIssue[] {
  const resolved = resolveReconciledStoryMapCandidate({
    candidate,
    source,
    references,
  });
  if (!resolved.success) return resolved.issues;

  const storyMap = StoryMapSchema.parse({
    schemaVersion: 1,
    id: "story_map_candidate",
    sourceId: source.id,
    version: 1,
    status: "draft",
    ...resolved.content,
  });
  return validateStoryMap(storyMap, source);
}

function mergeTemporaryReferences(
  references: TemporaryEvidenceReference[],
): TemporaryEvidenceReference[] {
  const merged = new Map<string, TemporaryEvidenceReference>();
  for (const reference of references) {
    const existing = merged.get(reference.id);
    if (
      existing &&
      JSON.stringify(existing.reference) !== JSON.stringify(reference.reference)
    ) {
      throw new Error(`临时 Evidence Reference ID 冲突：${reference.id}`);
    }
    merged.set(reference.id, reference);
  }
  return [...merged.values()];
}

function formatIssues(issues: StructuredValidationIssue[]): string {
  return issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
}

function loadPrompt(fileName: string): Promise<string> {
  return readFile(path.join(process.cwd(), "prompts", fileName), "utf8");
}
