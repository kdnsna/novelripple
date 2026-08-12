import {
  StoryMapContentCandidateSchema,
  StoryMapExtractionCandidateSchema,
  type Source,
  type SourceReference,
} from "@/domain/schemas";
import {
  deriveEvidenceUnits,
  type EvidenceUnit,
} from "@/domain/source/evidence-units";
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

  const evidenceUnits = deriveEvidenceUnits(source);
  const withEvidenceUnitIds = <T extends { evidence: SourceReference[] }>(
    value: T,
  ) => {
    const { evidence, ...content } = value;
    return {
      ...content,
      evidenceUnitIds: uniqueUnitIdsForReferences(evidence, evidenceUnits),
    };
  };
  const events = fixture.storyMap.events.map(withEvidenceUnitIds);
  const edges = fixture.storyMap.edges.map(withEvidenceUnitIds);
  const shared = {
    title: fixture.storyMap.title,
    logline: fixture.storyMap.logline,
    characters: fixture.storyMap.characters,
    events,
    edges,
  };
  const extraction = StoryMapExtractionCandidateSchema.parse(shared);
  const reconciled = StoryMapContentCandidateSchema.parse({
    ...shared,
    endingCandidates: fixture.storyMap.endingCandidates.map(
      withEvidenceUnitIds,
    ),
  });

  return new MockAIProvider([
    JSON.stringify(extraction),
    JSON.stringify(reconciled),
  ]);
}

function uniqueUnitIdsForReferences(
  references: SourceReference[],
  units: EvidenceUnit[],
): string[] {
  const unitIds = references.map((reference) => {
    const unit = units.find(
      (candidate) =>
        candidate.sectionId === reference.sectionId &&
        candidate.start <= reference.start &&
        candidate.end >= reference.end,
    );
    if (!unit) throw new Error("Fixture Evidence 缺少对应 Unit");
    return unit.id;
  });
  return [...new Set(unitIds)];
}
