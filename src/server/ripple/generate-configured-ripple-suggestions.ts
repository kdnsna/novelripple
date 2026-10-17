import type { RippleSuggestionsModelOutput } from "@/domain/schemas";
import {
  createConfiguredAIProvider,
  readConfiguredAI,
} from "@/server/ai/configured-runtime";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { getProjectSource } from "@/server/repositories/project-repository";
import { listRippleSuggestionsBatchesForStoryMap } from "@/server/repositories/ripple-suggestions-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";
import { generateRippleSuggestions } from "@/server/ripple/generate-ripple-suggestions";

export async function generateConfiguredRippleSuggestions(input: {
  projectId: string;
  storyMapArtifactId: string;
  idempotencyKey?: string | null;
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
      ? await createFixtureSuggestionsProvider(
          source.contentHash,
          listRippleSuggestionsBatchesForStoryMap(
            input.projectId,
            storyMapArtifact.id,
          ).length,
        )
      : undefined;

  return generateRippleSuggestions({
    ...input,
    provider: createConfiguredAIProvider(config, mockProvider),
    modelConfig: config.modelConfig,
  });
}

/** Mock 输出按批次轮换，方便本地/端到端验证「换一批」而不重复付费调用。 */
const fixtureBatches: RippleSuggestionsModelOutput[] = [
  {
    suggestions: [
      {
        eventId: "event_07",
        divergenceType: "prevent",
        instruction: "许澄没有把红色账簿交给周岚",
        whyInteresting: "证据移交、调查与后续公开路径都必须改道。",
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
  },
  {
    suggestions: [
      {
        eventId: "event_01",
        divergenceType: "prevent",
        instruction: "让许澄在重返祁雾港时被拦下",
        whyInteresting: "入港受阻会推迟铜门、账簿与后续全部调查。",
        affectedCharacterIds: ["char_xucheng", "char_xuchuan"],
        anchorRisk: "high",
      },
      {
        eventId: "event_02",
        divergenceType: "choice",
        instruction: "让铜门在风暴前就被打开",
        whyInteresting: "更早进入会让证据链与人员关系整体提前。",
        affectedCharacterIds: ["char_xucheng", "char_guwenzhou"],
        anchorRisk: "medium",
      },
      {
        eventId: "event_03",
        divergenceType: "outcome",
        instruction: "让红色账簿在现身前被调包",
        whyInteresting: "调查会围绕一份假账簿展开，真证据更难浮出水面。",
        affectedCharacterIds: ["char_xucheng", "char_zhoulan"],
        anchorRisk: "high",
      },
    ],
  },
  {
    suggestions: [
      {
        eventId: "event_06",
        divergenceType: "outcome",
        instruction: "让灯塔记录缺掉关键七分钟",
        whyInteresting: "证词与物证无法互相印证，责任重建会停摆。",
        affectedCharacterIds: ["char_xucheng", "char_shenyan"],
        anchorRisk: "medium",
      },
      {
        eventId: "event_07",
        divergenceType: "choice",
        instruction: "让许澄拒绝交出红色账簿",
        whyInteresting: "拒绝移交会把调查引向个人对抗与新的取证方式。",
        affectedCharacterIds: ["char_xucheng", "char_zhoulan"],
        anchorRisk: "high",
      },
      {
        eventId: "event_10",
        divergenceType: "prevent",
        instruction: "让缺失的四页始终没有进入证据链",
        whyInteresting: "听证会可能只能依据不完整材料给出结论。",
        affectedCharacterIds: ["char_xucheng"],
        anchorRisk: "medium",
      },
    ],
  },
  {
    suggestions: [
      {
        eventId: "event_02",
        divergenceType: "prevent",
        instruction: "让铜门始终没有被打开",
        whyInteresting: "潮标站内部线索无法被发现，调查会转向别处。",
        affectedCharacterIds: ["char_xucheng"],
        anchorRisk: "high",
      },
      {
        eventId: "event_03",
        divergenceType: "choice",
        instruction: "让账簿提前被销毁",
        whyInteresting: "唯一直接证据消失后，人物只能依赖证词与记录。",
        affectedCharacterIds: ["char_zhoulan"],
        anchorRisk: "high",
      },
      {
        eventId: "event_11",
        divergenceType: "outcome",
        instruction: "让听证会提前结束",
        whyInteresting: "责任重建尚未完成，公共记录会留下空白。",
        affectedCharacterIds: ["char_xucheng", "char_shenyan"],
        anchorRisk: "medium",
      },
    ],
  },
  {
    suggestions: [
      {
        eventId: "event_01",
        divergenceType: "choice",
        instruction: "让许澄选择不再回港",
        whyInteresting: "整个调查从一开始就不存在，人物关系会走向另一条路。",
        affectedCharacterIds: ["char_xucheng"],
        anchorRisk: "high",
      },
      {
        eventId: "event_06",
        divergenceType: "prevent",
        instruction: "让灯塔证词始终不完整",
        whyInteresting: "缺少七分钟会让事故责任无法被完整重建。",
        affectedCharacterIds: ["char_shenyan"],
        anchorRisk: "medium",
      },
      {
        eventId: "event_07",
        divergenceType: "outcome",
        instruction: "让红账在移交前被公开",
        whyInteresting: "公开会改变调查节奏，也会让相关人物提前表态。",
        affectedCharacterIds: ["char_xucheng", "char_zhoulan"],
        anchorRisk: "high",
      },
    ],
  },
];

async function createFixtureSuggestionsProvider(
  sourceHash: string,
  persistedBatchCount: number,
): Promise<MockAIProvider> {
  const fixture = await loadRippleFixture();
  if (sourceHash !== fixture.source.contentHash) {
    throw new Error("Mock AI 只接受公开基准故事 ripple-001");
  }
  // 按已持久化批次数轮换输出：换一批时 fixture 也给出不同的事件，
  // 便于端到端验证批次切换；超出预设批次时循环复用合法输出。
  const output =
    fixtureBatches[persistedBatchCount % fixtureBatches.length]!;
  return new MockAIProvider([JSON.stringify(output)]);
}
