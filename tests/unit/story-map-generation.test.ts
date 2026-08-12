import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateStoryMap } from "@/domain/invariants/validate-story-map";
import {
  StoryMapLocalExtractionCandidateSchema,
  StoryMapReconciliationCandidateSchema,
  type Source,
  type SourceReference,
  type StoryMapLocalExtractionCandidate,
  type StoryMapReconciliationCandidate,
} from "@/domain/schemas";
import { deriveAnalysisSegments } from "@/domain/source/analysis-segments";
import { sha256 } from "@/domain/source/normalize-source";
import { temporaryEvidenceReferenceId } from "@/domain/source/resolve-story-map-evidence";
import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "@/server/ai/types";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { listProjectGenerationRuns } from "@/server/repositories/generation-run-repository";
import {
  createProject,
  getProjectSource,
  importProjectSource,
} from "@/server/repositories/project-repository";
import { listStoryMapArtifactsForSource } from "@/server/repositories/story-map-artifact-repository";
import { generateStoryMap } from "@/server/story-map/generate-story-map";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";
import {
  buildAnalysisSegmentPacket,
  buildGlobalReconcilePacket,
} from "@/server/story-map/story-map-packets";

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-story-map-generation-"),
  );
  process.env.DB_FILE_NAME = path.join(temporaryDirectory, "test.db");
  closeDatabase();
  migrate(getDatabase(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
});

afterAll(async () => {
  closeDatabase();
  delete process.env.DB_FILE_NAME;
  await rm(temporaryDirectory, { recursive: true });
});

const modelConfig = {
  model: "mock-story-model",
  structuredOutputMode: "json_schema" as const,
};

describe("section-first Story Map generation pipeline", () => {
  it("builds a local body packet and a body-free global packet", async () => {
    const { source, segments, localCandidates } = createSyntheticContext(2);
    const sentinel = "SEGMENT_EVENT_1";
    const localPacket = buildAnalysisSegmentPacket({
      sourceId: source.id,
      normalizedText: source.normalizedText,
      sections: source.sections,
      segment: segments[0]!,
    });
    expect(localPacket).toContain(sentinel);
    expect(localPacket).toContain('"ownership":"core"');

    const reference = sourceReferenceForQuote(
      source,
      source.sections[0]!.id,
      sentinel,
    );
    const globalPacket = buildGlobalReconcilePacket({
      sourceId: source.id,
      sections: source.sections,
      segments,
      candidates: [
        {
          segmentId: segments[0]!.id,
          characters: localCandidates[0]!.characters.map(
            ({ localId, ...character }) => ({ localId, ...character }),
          ),
          events: [
            {
              localId: localCandidates[0]!.events[0]!.localId,
              title: localCandidates[0]!.events[0]!.title,
              summary: localCandidates[0]!.events[0]!.summary,
              sequence: localCandidates[0]!.events[0]!.sequence,
              participants: localCandidates[0]!.events[0]!.participants,
              stateChanges: localCandidates[0]!.events[0]!.stateChanges,
              evidenceKind: localCandidates[0]!.events[0]!.evidenceKind,
              evidenceReferenceIds: [temporaryEvidenceReferenceId(reference)],
            },
          ],
          edges: [],
        },
      ],
      references: [
        { id: temporaryEvidenceReferenceId(reference), reference },
      ],
    });
    expect(globalPacket).not.toContain(sentinel);
    expect(globalPacket).not.toContain("exactQuote");
    expect(globalPacket).toContain("temporary_evidence_references");

    const [localPrompt, globalPrompt] = await Promise.all([
      readFile(path.join(process.cwd(), "prompts/story-map.v3.md"), "utf8"),
      readFile(
        path.join(process.cwd(), "prompts/story-map-reconcile.v3.md"),
        "utf8",
      ),
    ]);
    expect(localPrompt).toContain('"stateChanges": []');
    expect(localPrompt).toContain('"participants": [');
    expect(localPrompt).toContain("exactQuote");
    expect(globalPrompt).toContain("evidenceReferenceIds");
    expect(globalPrompt).toContain("输入不含整部 Source 正文");
  });

  it("uses the same production path for a one-Segment Source", async () => {
    const context = createSyntheticContext(1);
    const persisted = persistSyntheticContext(context);
    const provider = new MockAIProvider([
      JSON.stringify(persisted.localCandidates[0]),
      JSON.stringify(persisted.reconciled),
    ]);
    const sourceBefore = structuredClone(persisted.source);

    const result = await generateStoryMap({
      projectId: persisted.project.id,
      sourceId: persisted.source.id,
      provider,
      modelConfig,
    });

    expect(result.generation.analysisSegmentCount).toBe(1);
    expect(result.generation.extractorRunIds).toHaveLength(1);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.schemaName).toBe("story_map_segment");
    expect(provider.requests[1]?.prompt).not.toContain(
      persisted.source.normalizedText,
    );
    expect(validateStoryMap(result.artifact.storyMap, persisted.source)).toEqual(
      [],
    );
    expect(getProjectSource(persisted.project.id, persisted.source.id)).toEqual(
      sourceBefore,
    );
    const evidence = result.artifact.storyMap.events[0]!.evidence[0]!;
    expect(persisted.source.normalizedText.slice(evidence.start, evidence.end)).toBe(
      "SEGMENT_EVENT_1",
    );
    expect(evidence.excerptHash).toBe(sha256("SEGMENT_EVENT_1"));
  });

  it("reconciles aliases and creates a cross-Segment causal Edge", async () => {
    const context = createSyntheticContext(2);
    const persisted = persistSyntheticContext(context);
    const provider = new MockAIProvider([
      ...persisted.localCandidates.map((candidate) => JSON.stringify(candidate)),
      JSON.stringify(persisted.reconciled),
    ]);

    const result = await generateStoryMap({
      projectId: persisted.project.id,
      sourceId: persisted.source.id,
      provider,
      modelConfig,
    });

    expect(result.generation.analysisSegmentCount).toBe(2);
    expect(result.generation.extractorRunIds).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    expect(result.artifact.storyMap.characters).toHaveLength(1);
    expect(result.artifact.storyMap.edges).toContainEqual(
      expect.objectContaining({
        from: "event_1",
        to: "event_2",
        type: "causes",
      }),
    );
    expect(provider.requests.at(-1)?.prompt).not.toContain(
      persisted.source.normalizedText,
    );

    const runs = listProjectGenerationRuns(persisted.project.id);
    for (const runId of result.generation.extractorRunIds) {
      expect(runs.find((run) => run.id === runId)).toMatchObject({
        kind: expect.stringMatching(/^story_map_extract:analysis_segment:/),
        promptVersion: "story-map.v3",
        status: "succeeded",
      });
    }
    expect(
      runs.find((run) => run.id === result.generation.reconcilerRunId),
    ).toMatchObject({
      kind: "story_map_reconcile",
      promptVersion: "story-map-reconcile.v3",
      status: "succeeded",
    });
  });

  it("never runs more than two Segment calls concurrently", async () => {
    const context = createSyntheticContext(3);
    const persisted = persistSyntheticContext(context);
    const provider = new ConcurrentSyntheticProvider(
      persisted.localCandidates,
      persisted.reconciled,
    );

    const result = await generateStoryMap({
      projectId: persisted.project.id,
      sourceId: persisted.source.id,
      provider,
      modelConfig,
    });

    expect(result.generation.analysisSegmentCount).toBe(3);
    expect(provider.maxActive).toBe(2);
    expect(provider.requests).toHaveLength(4);
  });

  it("repairs one deterministic Reconciler failure and then persists", async () => {
    const context = createSyntheticContext(1);
    const persisted = persistSyntheticContext(context);
    const invalid = structuredClone(persisted.reconciled);
    invalid.events[0]!.participants.push("character_missing");
    const provider = new MockAIProvider([
      JSON.stringify(persisted.localCandidates[0]),
      JSON.stringify(invalid),
      JSON.stringify(persisted.reconciled),
    ]);

    const result = await generateStoryMap({
      projectId: persisted.project.id,
      sourceId: persisted.source.id,
      provider,
      modelConfig,
    });

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.repair?.validationIssues).toEqual(
      expect.arrayContaining([expect.stringContaining("未知人物")]),
    );
    expect(result.artifact.storyMap.sourceId).toBe(persisted.source.id);
  });

  it("retains failed Segment runs and creates no partial Artifact", async () => {
    const context = createSyntheticContext(2);
    const persisted = persistSyntheticContext(context);
    const invalid = structuredClone(persisted.localCandidates[1]!);
    invalid.events[0]!.evidence[0]!.sectionId = "section_missing";
    const provider = new MockAIProvider([
      JSON.stringify(persisted.localCandidates[0]),
      JSON.stringify(invalid),
      JSON.stringify(invalid),
    ]);

    await expect(
      generateStoryMap({
        projectId: persisted.project.id,
        sourceId: persisted.source.id,
        provider,
        modelConfig,
      }),
    ).rejects.toThrow("Structured generation failed schema validation");

    expect(provider.requests).toHaveLength(3);
    expect(
      provider.requests.filter(
        (request) => request.schemaName === "story_map_content",
      ),
    ).toHaveLength(0);
    expect(
      listStoryMapArtifactsForSource(persisted.project.id, persisted.source.id),
    ).toEqual([]);
    expect(listProjectGenerationRuns(persisted.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: expect.stringMatching(/^story_map_extract:/),
          status: "failed",
        }),
      ]),
    );
  });

  it("runs the deterministic public fixture through the unified path", async () => {
    const fixture = await loadRippleFixture();
    const project = createProject({ title: "Configured section-first fixture" });
    const { source } = importProjectSource({
      projectId: project.id,
      fileName: "ripple-001.md",
      bytes: new TextEncoder().encode(fixture.source.originalText),
    });
    const previousProvider = process.env.AI_PROVIDER_NAME;
    const previousModel = process.env.OPENAI_MODEL;
    const previousMode = process.env.OPENAI_STRUCTURED_OUTPUT_MODE;
    process.env.AI_PROVIDER_NAME = "mock";
    process.env.OPENAI_MODEL = "mock-story-model";
    process.env.OPENAI_STRUCTURED_OUTPUT_MODE = "json_schema";

    try {
      const result = await generateConfiguredStoryMap({
        projectId: project.id,
        sourceId: source.id,
      });
      expect(result.generation.analysisSegmentCount).toBe(1);
      expect(result.artifact.storyMap.events).toHaveLength(12);
      expect(validateStoryMap(result.artifact.storyMap, source)).toEqual([]);
      expect(
        listProjectGenerationRuns(project.id).every(
          (run) => run.provider === "mock",
        ),
      ).toBe(true);
    } finally {
      restoreEnvironment("AI_PROVIDER_NAME", previousProvider);
      restoreEnvironment("OPENAI_MODEL", previousModel);
      restoreEnvironment("OPENAI_STRUCTURED_OUTPUT_MODE", previousMode);
    }
  });

  it("creates an immutable revision when the same Source is rerun", async () => {
    const context = createSyntheticContext(1);
    const persisted = persistSyntheticContext(context);
    const outputs = [
      JSON.stringify(persisted.localCandidates[0]),
      JSON.stringify(persisted.reconciled),
      JSON.stringify(persisted.localCandidates[0]),
      JSON.stringify(persisted.reconciled),
    ];
    const provider = new MockAIProvider(outputs);

    const first = await generateStoryMap({
      projectId: persisted.project.id,
      sourceId: persisted.source.id,
      provider,
      modelConfig,
    });
    const second = await generateStoryMap({
      projectId: persisted.project.id,
      sourceId: persisted.source.id,
      provider,
      modelConfig,
    });

    expect(first.artifact.version).toBe(1);
    expect(second.artifact).toMatchObject({
      version: 2,
      kind: "story_map_revision",
      basedOnArtifactId: first.artifact.id,
    });
    expect(listStoryMapArtifactsForSource(persisted.project.id, persisted.source.id)).toHaveLength(2);
  });
});

type SyntheticContext = ReturnType<typeof createSyntheticContext>;

function createSyntheticContext(segmentCount: number) {
  const paragraphLengths = Array.from({ length: segmentCount * 2 }, () => 4_000);
  if (segmentCount === 1) paragraphLengths.fill(2_500);
  const markers = Array.from(
    { length: segmentCount },
    (_, index) => `SEGMENT_EVENT_${index + 1}`,
  );
  const paragraphs = paragraphLengths.map((length, index) => {
    const marker = index % 2 === 0 ? markers[index / 2]! : `BOUNDARY_${index}`;
    return `${"文".repeat(length - marker.length)}${marker}`;
  });
  const normalizedText = paragraphs.join("\n\n");
  let cursor = 0;
  const sections = paragraphs.map((paragraph, index) => {
    const section = {
      id: `section_${String(index + 1).padStart(2, "0")}`,
      title: `段落 ${index + 1}`,
      start: cursor,
      end: cursor + paragraph.length,
    };
    cursor = section.end + 2;
    return section;
  });
  const source: Source = {
    id: "source_synthetic",
    projectId: "project_synthetic",
    title: "合成分段故事",
    originalText: normalizedText,
    normalizedText,
    contentHash: sha256(normalizedText),
    sections,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
  const segments = deriveAnalysisSegments(source);
  expect(segments).toHaveLength(segmentCount);
  const localCandidates = segments.map((segment, index) =>
    StoryMapLocalExtractionCandidateSchema.parse({
      characters: [
        {
          localId: `hero_${index + 1}`,
          name: index === 0 ? "甲" : "甲先生",
          aliases: index === 0 ? [] : ["甲"],
          role: "protagonist",
          initialState: `阶段 ${index + 1}`,
        },
      ],
      events: [
        {
          localId: `event_${index + 1}`,
          title: `事件 ${index + 1}`,
          summary: `合成事件 ${index + 1}`,
          sequence: 1,
          participants: [`hero_${index + 1}`],
          stateChanges: [`进入阶段 ${index + 1}`],
          evidenceKind: "fact",
          evidence: [
            {
              sectionId: segment.sectionIds[0]!,
              exactQuote: markers[index]!,
            },
          ],
        },
      ],
      edges: [],
    }),
  );
  const referenceIds = segments.map((segment, index) =>
    temporaryEvidenceReferenceId(
      sourceReferenceForQuote(
        source,
        segment.sectionIds[0]!,
        markers[index]!,
      ),
    ),
  );
  const reconciled = StoryMapReconciliationCandidateSchema.parse({
    title: "合成分段故事",
    logline: "一个人物跨越多个阶段。",
    characters: [
      {
        id: "character_hero",
        name: "甲",
        aliases: ["甲先生"],
        role: "protagonist",
        initialState: "阶段 1",
      },
    ],
    events: segments.map((_, index) => ({
      id: `event_${index + 1}`,
      title: `事件 ${index + 1}`,
      summary: `合成事件 ${index + 1}`,
      sequence: index + 1,
      participants: ["character_hero"],
      stateChanges: [`进入阶段 ${index + 1}`],
      evidenceKind: "fact" as const,
      evidenceReferenceIds: [referenceIds[index]!],
    })),
    edges: segments.slice(1).map((_, index) => ({
      id: `edge_${index + 1}`,
      from: `event_${index + 1}`,
      to: `event_${index + 2}`,
      type: "causes" as const,
      explanation: "前一事件导致后一事件",
      confidence: 0.9,
      confirmed: false,
      evidenceReferenceIds: [referenceIds[index + 1]!],
    })),
    endingCandidates: [
      {
        id: "ending_1",
        targetEventId: `event_${segmentCount}`,
        requirement: "最后阶段已经发生",
        evidenceReferenceIds: [referenceIds.at(-1)!],
      },
    ],
  });

  return { source, segments, localCandidates, reconciled };
}

function persistSyntheticContext(context: SyntheticContext) {
  const project = createProject({ title: "Synthetic Story Map generation" });
  const { source } = importProjectSource({
    projectId: project.id,
    fileName: "synthetic.txt",
    bytes: new TextEncoder().encode(context.source.normalizedText),
  });
  const rebound = createSyntheticContext(context.segments.length);
  rebound.source.id = source.id;
  rebound.source.projectId = project.id;
  rebound.reconciled = rebindReconciledReferences(
    rebound.reconciled,
    context.source.id,
    source.id,
  );
  return {
    project,
    source,
    segments: deriveAnalysisSegments(source),
    localCandidates: rebound.localCandidates,
    reconciled: rebound.reconciled,
  };
}

function rebindReconciledReferences(
  candidate: StoryMapReconciliationCandidate,
  previousSourceId: string,
  sourceId: string,
): StoryMapReconciliationCandidate {
  const replace = (ids: string[]) =>
    ids.map((id) => id.replace(`evidence_ref:${previousSourceId}:`, `evidence_ref:${sourceId}:`));
  return StoryMapReconciliationCandidateSchema.parse({
    ...candidate,
    events: candidate.events.map((event) => ({
      ...event,
      evidenceReferenceIds: replace(event.evidenceReferenceIds),
    })),
    edges: candidate.edges.map((edge) => ({
      ...edge,
      evidenceReferenceIds: replace(edge.evidenceReferenceIds),
    })),
    endingCandidates: candidate.endingCandidates.map((ending) => ({
      ...ending,
      evidenceReferenceIds: replace(ending.evidenceReferenceIds),
    })),
  });
}

function sourceReferenceForQuote(
  source: Source,
  sectionId: string,
  quote: string,
): SourceReference {
  const section = source.sections.find((candidate) => candidate.id === sectionId)!;
  const relativeStart = source.normalizedText
    .slice(section.start, section.end)
    .indexOf(quote);
  const start = section.start + relativeStart;
  return {
    sourceId: source.id,
    sectionId,
    start,
    end: start + quote.length,
    excerptHash: sha256(quote),
  };
}

class ConcurrentSyntheticProvider implements AIProvider {
  readonly providerName = "concurrency-mock";
  readonly requests: AIProviderRequest[] = [];
  maxActive = 0;
  #active = 0;
  #localIndex = 0;

  constructor(
    private readonly locals: StoryMapLocalExtractionCandidate[],
    private readonly reconciled: StoryMapReconciliationCandidate,
  ) {}

  async generate(request: AIProviderRequest): Promise<AIProviderResponse> {
    this.requests.push(request);
    if (request.schemaName === "story_map_content") {
      return { rawOutput: JSON.stringify(this.reconciled) };
    }
    const candidate = this.locals[this.#localIndex++]!;
    this.#active += 1;
    this.maxActive = Math.max(this.maxActive, this.#active);
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.#active -= 1;
    return { rawOutput: JSON.stringify(candidate) };
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
