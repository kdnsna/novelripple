import type { RippleSuggestionsModelOutput } from "@/domain/schemas";
import {
  createConfiguredAIProvider,
  readConfiguredAI,
} from "@/server/ai/configured-runtime";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { getProjectSource } from "@/server/repositories/project-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";
import { generateRippleSuggestions } from "@/server/ripple/generate-ripple-suggestions";

export async function generateConfiguredRippleSuggestions(input: {
  projectId: string;
  storyMapArtifactId: string;
}) {
  const storyMapArtifact = getStoryMapArtifact(input.storyMapArtifactId);
  if (!storyMapArtifact || storyMapArtifact.projectId !== input.projectId) {
    throw new Error("找不到指定的 Story Map Artifact");
  }
  const source = getProjectSource(input.projectId, storyMapArtifact.sourceId);
  if (!source) throw new Error("找不到 Story Map 对应的 Source");

  const config = readConfiguredAI();
  const mockProvider =
    config.providerName === "mock"
      ? await createFixtureSuggestionsProvider(source.contentHash)
      : undefined;

  return generateRippleSuggestions({
    ...input,
    provider: createConfiguredAIProvider(config, mockProvider),
    modelConfig: config.modelConfig,
  });
}

async function createFixtureSuggestionsProvider(
  sourceHash: string,
): Promise<MockAIProvider> {
  const fixture = await loadRippleFixture();
  if (sourceHash !== fixture.source.contentHash) {
    throw new Error("Mock AI 只接受公开基准故事 ripple-001");
  }
  const output: RippleSuggestionsModelOutput = {
    suggestions: [
      {
        eventId: "event_03",
        divergenceType: "prevent",
        instruction: "让红色账簿没有被发现",
        whyInteresting: "两条后续调查与证据公开路径都必须改道。",
        affectedCharacterIds: ["char_xucheng", "char_zhoulan"],
        anchorRisk: "high",
      },
      {
        eventId: "event_06",
        divergenceType: "choice",
        instruction: "让沈砚拒绝交出灯塔记录",
        whyInteresting: "证据链缺少关键一环，人物必须寻找新的证明方式。",
        affectedCharacterIds: ["char_xucheng", "char_shenyan"],
        anchorRisk: "medium",
      },
      {
        eventId: "event_10",
        divergenceType: "outcome",
        instruction: "让缺失的证据仍未被找到",
        whyInteresting: "听证会与最终结论将失去决定性材料。",
        affectedCharacterIds: ["char_xucheng"],
        anchorRisk: "medium",
      },
    ],
  };
  return new MockAIProvider([JSON.stringify(output)]);
}
