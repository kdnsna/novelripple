import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateStoryMap } from "@/domain/invariants/validate-story-map";
import {
  StoryMapContentCandidateSchema,
  StoryMapExtractionCandidateSchema,
  StoryMapSchema,
  type StoryMapContentCandidate,
} from "@/domain/schemas";
import {
  deriveEvidenceUnits,
  type EvidenceUnit,
} from "@/domain/source/evidence-units";
import { resolveStoryMapContentCandidate } from "@/domain/source/resolve-story-map-evidence";
import { generateStructured } from "@/server/ai/generate-structured";
import type {
  AIProvider,
  ModelConfig,
  StructuredValidationIssue,
} from "@/server/ai/types";
import { getProjectSource } from "@/server/repositories/project-repository";
import { createStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

const extractorPromptVersion = "story-map.v2";
const reconcilerPromptVersion = "story-map-reconcile.v2";

export async function generateStoryMap(input: {
  projectId: string;
  sourceId: string;
  provider: AIProvider;
  modelConfig: ModelConfig;
}) {
  const source = getProjectSource(input.projectId, input.sourceId);
  if (!source) throw new Error("找不到指定的 Source");

  const [extractorTemplate, reconcilerTemplate] = await Promise.all([
    loadPrompt(`${extractorPromptVersion}.md`),
    loadPrompt(`${reconcilerPromptVersion}.md`),
  ]);
  const evidenceUnits = deriveEvidenceUnits(source);
  const sourcePacket = buildSourcePacket(source, evidenceUnits);
  const extraction = await generateStructured(
    {
      projectId: input.projectId,
      worldlineId: null,
      kind: "story_map_extract",
      promptVersion: extractorPromptVersion,
      prompt: `${extractorTemplate}\n\n${sourcePacket}`,
      schemaName: "story_map_extraction",
      schema: StoryMapExtractionCandidateSchema,
      modelConfig: input.modelConfig,
    },
    input.provider,
  );
  const reconciliation = await generateStructured(
    {
      projectId: input.projectId,
      worldlineId: null,
      kind: "story_map_reconcile",
      promptVersion: reconcilerPromptVersion,
      prompt: [
        reconcilerTemplate,
        sourcePacket,
        "<extraction_candidate>",
        JSON.stringify(extraction.value),
        "</extraction_candidate>",
      ].join("\n\n"),
      schemaName: "story_map_content",
      schema: StoryMapContentCandidateSchema,
      modelConfig: input.modelConfig,
      validate: (candidate) =>
        validateCandidate(candidate, source, evidenceUnits),
    },
    input.provider,
  );
  const resolved = resolveStoryMapContentCandidate(
    reconciliation.value,
    source,
    evidenceUnits,
  );
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
    generationRunId: reconciliation.generation.runId,
  });

  return {
    artifact,
    generation: {
      extractorRunId: extraction.generation.runId,
      reconcilerRunId: reconciliation.generation.runId,
    },
  };
}

function validateCandidate(
  candidate: StoryMapContentCandidate,
  source: NonNullable<ReturnType<typeof getProjectSource>>,
  evidenceUnits: EvidenceUnit[],
): StructuredValidationIssue[] {
  const resolved = resolveStoryMapContentCandidate(
    candidate,
    source,
    evidenceUnits,
  );
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

function buildSourcePacket(
  source: NonNullable<ReturnType<typeof getProjectSource>>,
  evidenceUnits: EvidenceUnit[],
): string {
  return [
    `<immutable_source id="${source.id}">`,
    `<sections>${JSON.stringify(source.sections)}</sections>`,
    "<evidence_units>",
    JSON.stringify(
      evidenceUnits.map((unit) => ({
        id: unit.id,
        sectionId: unit.sectionId,
        text: unit.text,
      })),
    ),
    "</evidence_units>",
    "</immutable_source>",
  ].join("\n");
}

function loadPrompt(fileName: string): Promise<string> {
  return readFile(path.join(process.cwd(), "prompts", fileName), "utf8");
}
