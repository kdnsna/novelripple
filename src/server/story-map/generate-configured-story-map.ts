import {
  StoryMapLocalExtractionCandidateSchema,
  StoryMapReconciliationCandidateSchema,
  type Source,
  type SourceReference,
} from "@/domain/schemas";
import {
  deriveAnalysisSegments,
  type AnalysisSegment,
} from "@/domain/source/analysis-segments";
import { temporaryEvidenceReferenceId } from "@/domain/source/resolve-story-map-evidence";
import { MockAIProvider } from "@/server/ai/mock-provider";
import {
  createConfiguredAIProvider,
  readConfiguredAI,
} from "@/server/ai/configured-runtime";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { getProjectSource } from "@/server/repositories/project-repository";
import { generateStoryMap } from "@/server/story-map/generate-story-map";

export async function generateConfiguredStoryMap(input: {
  projectId: string;
  sourceId: string;
}) {
  const source = getProjectSource(input.projectId, input.sourceId);
  if (!source) throw new Error("找不到指定的 Source");
  const config = readConfiguredAI();
  const mockProvider =
    config.providerName === "mock"
      ? await createFixtureMockProvider(source)
      : undefined;
  const provider = createConfiguredAIProvider(config, mockProvider);

  return generateStoryMap({
    ...input,
    provider,
    modelConfig: config.modelConfig,
  });
}

async function createFixtureMockProvider(source: Source): Promise<MockAIProvider> {
  const fixture = await loadRippleFixture();
  if (source.contentHash !== fixture.source.contentHash) {
    throw new Error("Mock AI 只接受公开基准故事 ripple-001");
  }

  const segments = deriveAnalysisSegments(source);
  const allReferences = uniqueReferences([
    ...fixture.storyMap.events.flatMap((event) => event.evidence),
    ...fixture.storyMap.edges.flatMap((edge) => edge.evidence),
    ...fixture.storyMap.endingCandidates.flatMap(
      (ending) => ending.evidence,
    ),
  ]).map((reference) => ({ ...reference, sourceId: source.id }));
  const localCandidates = segments.map((segment) => {
    const ownedEvents = fixture.storyMap.events.filter((event) =>
      isReferenceInCore(event.evidence[0]!, segment),
    );
    const ownedEventIds = new Set(ownedEvents.map((event) => event.id));
    const ownedReferences = allReferences.filter((reference) =>
      isReferenceInCore(reference, segment),
    );
    if (ownedReferences.length > 0 && ownedEvents.length === 0) {
      throw new Error(`Fixture Segment 缺少承载 Evidence 的 Event：${segment.id}`);
    }

    const eventReferences = new Map(
      ownedEvents.map((event) => [
        event.id,
        event.evidence
          .map((reference) => ({ ...reference, sourceId: source.id }))
          .filter((reference) => isReferenceInContext(reference, segment)),
      ]),
    );
    const firstEvent = ownedEvents[0];
    if (firstEvent) {
      eventReferences.set(
        firstEvent.id,
        uniqueReferences([
          ...(eventReferences.get(firstEvent.id) ?? []),
          ...ownedReferences,
        ]),
      );
    }

    const participantIds = new Set(
      ownedEvents.flatMap((event) => event.participants),
    );
    const characters = fixture.storyMap.characters
      .filter((character) => participantIds.has(character.id))
      .map(({ id, ...character }) => ({ localId: id, ...character }));
    const events = ownedEvents.map((event) => ({
      localId: event.id,
      title: event.title,
      summary: event.summary,
      sequence: event.sequence,
      participants: event.participants,
      stateChanges: event.stateChanges,
      evidenceKind: event.evidenceKind,
      ...(event.confidence === undefined
        ? {}
        : { confidence: event.confidence }),
      evidence: (eventReferences.get(event.id) ?? []).map((reference) =>
        claimForReference(reference, source),
      ),
    }));
    const edges = fixture.storyMap.edges
      .filter(
        (edge) =>
          ownedEventIds.has(edge.from) &&
          ownedEventIds.has(edge.to) &&
          isReferenceInCore(edge.evidence[0]!, segment),
      )
      .map(({ id, evidence, ...edge }) => ({
        localId: id,
        ...edge,
        evidence: evidence
          .map((reference) => ({ ...reference, sourceId: source.id }))
          .filter((reference) => isReferenceInContext(reference, segment))
          .map((reference) => claimForReference(reference, source)),
      }));

    return StoryMapLocalExtractionCandidateSchema.parse({
      characters,
      events,
      edges,
    });
  });

  const withReferenceIds = <T extends { evidence: SourceReference[] }>(
    value: T,
  ) => {
    const { evidence, ...content } = value;
    return {
      ...content,
      evidenceReferenceIds: evidence.map((reference) =>
        temporaryEvidenceReferenceId({ ...reference, sourceId: source.id }),
      ),
    };
  };
  const reconciled = StoryMapReconciliationCandidateSchema.parse({
    title: fixture.storyMap.title,
    logline: fixture.storyMap.logline,
    characters: fixture.storyMap.characters,
    events: fixture.storyMap.events.map(withReferenceIds),
    edges: fixture.storyMap.edges.map(withReferenceIds),
    endingCandidates: fixture.storyMap.endingCandidates.map(withReferenceIds),
  });

  return new MockAIProvider([
    ...localCandidates.map((candidate) => JSON.stringify(candidate)),
    JSON.stringify(reconciled),
  ]);
}

function claimForReference(reference: SourceReference, source: Source) {
  return {
    sectionId: reference.sectionId,
    exactQuote: source.normalizedText.slice(reference.start, reference.end),
  };
}

function isReferenceInCore(
  reference: SourceReference,
  segment: AnalysisSegment,
): boolean {
  return (
    reference.start >= segment.coreStart && reference.end <= segment.coreEnd
  );
}

function isReferenceInContext(
  reference: SourceReference,
  segment: AnalysisSegment,
): boolean {
  return (
    reference.start >= segment.contextStart &&
    reference.end <= segment.contextEnd
  );
}

function uniqueReferences(references: SourceReference[]): SourceReference[] {
  const unique = new Map<string, SourceReference>();
  for (const reference of references) {
    unique.set(
      [reference.sectionId, reference.start, reference.end].join(":"),
      reference,
    );
  }
  return [...unique.values()];
}
