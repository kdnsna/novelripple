import {
  StoryMapContentCandidateSchema,
  StoryMapExtractionCandidateSchema,
  type Source,
  type SourceReference,
} from "@/domain/schemas";
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

  const toClaim = (reference: SourceReference) => ({
    sectionId: reference.sectionId,
    exactQuote: fixture.source.normalizedText.slice(
      reference.start,
      reference.end,
    ),
  });
  const events = fixture.storyMap.events.map((event) => ({
    ...event,
    evidence: event.evidence.map(toClaim),
  }));
  const edges = fixture.storyMap.edges.map((edge) => ({
    ...edge,
    evidence: edge.evidence.map(toClaim),
  }));
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
    endingCandidates: fixture.storyMap.endingCandidates.map((ending) => ({
      ...ending,
      evidence: ending.evidence.map(toClaim),
    })),
  });

  return new MockAIProvider([
    JSON.stringify(extraction),
    JSON.stringify(reconciled),
  ]);
}
