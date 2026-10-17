import type { JobProgress, Source } from "@/domain/schemas";
import { MockAIProvider } from "@/server/ai/mock-provider";
import {
  createConfiguredAIProvider,
  readConfiguredAI,
} from "@/server/ai/configured-runtime";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { getProjectSource } from "@/server/repositories/project-repository";
import { buildFixtureStoryMapResponses } from "@/server/story-map/fixture-story-map-responses";
import { generateStoryMap } from "@/server/story-map/generate-story-map";

export async function generateConfiguredStoryMap(input: {
  projectId: string;
  sourceId: string;
  onProgress?: (progress: JobProgress) => void;
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
  return new MockAIProvider(buildFixtureStoryMapResponses(source, fixture.storyMap));
}
