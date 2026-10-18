import { describe, expect, it } from "vitest";

import { deriveSourceBaselineStatuses } from "@/domain/continuation/character-status";
import { StoryMapSchema } from "@/domain/schemas";

/**
 * 死亡推断的合成探针：全部使用自建短句，不复用任何原著文本。
 * 每个探针各建一张最小 confirmed Story Map，并在探针事件之后放一个分歧事件。
 */

const reference = {
  sourceId: "source_death_probe",
  sectionId: "section_1",
  start: 0,
  end: 8,
  excerptHash: `sha256:${"b".repeat(64)}`,
};

const CHARACTERS = [
  { id: "character_lin", name: "林青", aliases: ["青儿"] },
  { id: "character_han", name: "韩松", aliases: [] },
  { id: "character_alan", name: "艾伦", aliases: [] },
  { id: "character_han_single", name: "韩", aliases: [] },
  { id: "character_shenmo", name: "沈墨", aliases: [] },
] as const;

type ProbeEvent = {
  id: string;
  sequence: number;
  participants: string[];
  stateChanges: string[];
};

type ProbeBaseline = ReturnType<typeof deriveSourceBaselineStatuses>;

type NegativeProbe = {
  label: string;
  baseline: () => ProbeBaseline;
};

type PositiveProbe = {
  label: string;
  characterId: string;
  baseline: () => ProbeBaseline;
};

const divergence = {
  id: "divergence_death_probe",
  eventId: "event_divergence",
  type: "prevent" as const,
  instruction: "自建短句构造的分歧",
};

function probeBaseline(input: {
  events: ProbeEvent[];
  status?: "draft" | "confirmed";
  divergenceEvent?: ProbeEvent;
}): ProbeBaseline {
  const divergenceEvent: ProbeEvent = input.divergenceEvent ?? {
    id: "event_divergence",
    sequence: 100,
    participants: ["character_lin"],
    stateChanges: ["林青改变了选择"],
  };
  const storyMap = StoryMapSchema.parse({
    schemaVersion: 1,
    id: "story_map_death_probe",
    sourceId: "source_death_probe",
    version: 1,
    status: input.status ?? "confirmed",
    title: "死亡句型探针",
    logline: "自建短句构造的人物状态推断测试",
    characters: CHARACTERS.map((character) => ({
      ...character,
      aliases: [...character.aliases],
      role: "supporting",
      initialState: "在场",
    })),
    events: [...input.events, divergenceEvent].map((event) => ({
      id: event.id,
      title: event.id,
      summary: event.id,
      sequence: event.sequence,
      participants: event.participants,
      stateChanges: event.stateChanges,
      evidenceKind: "fact",
      evidence: [reference],
    })),
    edges: [],
    endingCandidates: [
      {
        id: "ending_death_probe",
        targetEventId: divergenceEvent.id,
        requirement: "保留分歧点",
        evidence: [reference],
      },
    ],
  });
  return deriveSourceBaselineStatuses({ storyMap, divergence });
}

function single(
  sentence: string,
  options: { participants?: string[] } = {},
): ProbeBaseline {
  return probeBaseline({
    events: [
      {
        id: "event_probe",
        sequence: 1,
        participants: options.participants ?? ["character_lin"],
        stateChanges: [sentence],
      },
    ],
  });
}

const negativeProbes: NegativeProbe[] = [
  // A. 死亡属于参与者之外的人或物。
  { label: "horse dies", baseline: () => single("林青的马死了") },
  { label: "mount dies", baseline: () => single("林青的坐骑中箭身亡") },
  { label: "father dies", baseline: () => single("林青之父病故") },
  { label: "mother dies", baseline: () => single("林青的母亲遇害") },
  { label: "teacher dies", baseline: () => single("林青的师父去世") },
  {
    label: "servant dies",
    baseline: () => single("仆人阿福替林青挡刀身亡"),
  },
  { label: "bystander dies", baseline: () => single("围观路人突然倒地身亡") },
  { label: "unnamed soldier dies", baseline: () => single("一名无名士兵阵亡") },
  { label: "subordinate dies", baseline: () => single("林青的部下被乱军所杀") },
  // A. 短名落在外国姓名或地名内部。
  {
    label: "foreign name contains short name",
    baseline: () => single("艾伦·坡病故", { participants: ["character_alan"] }),
  },
  {
    label: "foreign name prefixes short name",
    baseline: () => single("卡艾伦遇害", { participants: ["character_alan"] }),
  },
  {
    label: "place name contains short name",
    baseline: () => single("韩松岭上积雪封路", { participants: ["character_han"] }),
  },
  {
    label: "single-char name inside place name",
    baseline: () =>
      single("韩国使者遇害", { participants: ["character_han_single"] }),
  },
  // B. 否定与不确定。
  { label: "并未死亡", baseline: () => single("林青并未死亡") },
  { label: "没有被杀", baseline: () => single("林青没有被杀") },
  { label: "未曾身亡", baseline: () => single("林青未曾身亡") },
  { label: "还没死", baseline: () => single("林青还没死") },
  { label: "尚未死亡", baseline: () => single("林青尚未死亡") },
  {
    label: "hearsay then alive",
    baseline: () => single("据说林青遇害，实则生还"),
  },
  {
    label: "rumor then survived",
    baseline: () => single("传言林青已死，其实他活了下来"),
  },
  { label: "wrongly presumed dead", baseline: () => single("众人误以为林青已死") },
  {
    label: "wrongly presumed killed",
    baseline: () => single("众人误以为林青遇害"),
  },
  { label: "suspected killed", baseline: () => single("林青疑似遇害") },
  { label: "suspected murdered", baseline: () => single("林青疑似被杀") },
  { label: "possibly dead", baseline: () => single("林青可能遇害") },
  { label: "seemingly dead", baseline: () => single("林青似乎身亡") },
  { label: "misreported death", baseline: () => single("林青被误传死亡") },
  { label: "assumed another died", baseline: () => single("林青以为韩松已死") },
  // C. 假死、救活与夸张/比喻。
  { label: "fake death", baseline: () => single("林青假死脱身") },
  { label: "feigned death escape", baseline: () => single("林青诈死逃生") },
  { label: "rescued back", baseline: () => single("林青被救活了") },
  {
    label: "rescued back to the city",
    baseline: () => single("林青被救回城中"),
  },
  { label: "laughed to death", baseline: () => single("林青笑死了") },
  { label: "angered to death", baseline: () => single("林青气死了") },
  { label: "exhausted to death", baseline: () => single("林青累死了") },
  { label: "scared to death", baseline: () => single("林青吓死了") },
  { label: "suicide attempt failed", baseline: () => single("林青殉情未遂") },
  { label: "suicide attempt not achieved", baseline: () => single("林青殉情未果") },
  { label: "gave up", baseline: () => single("林青终于死心了") },
  { label: "refused to give up", baseline: () => single("林青死心不再争辩") },
  { label: "fought to the death", baseline: () => single("林青死战不退") },
  { label: "fought on", baseline: () => single("林青死战到底") },
  { label: "bare death word in noun", baseline: () => single("林青的死讯传来") },
  // 没有点名参与者。
  { label: "unnamed death", baseline: () => single("病故于城外") },
  // 参与者是凶手，不是死者。
  { label: "participant kills enemy", baseline: () => single("林青杀死了敌将") },
  { label: "participant nearly dies", baseline: () => single("林青险些丧命") },
  { label: "participant almost drowns", baseline: () => single("林青差点溺亡") },
  { label: "narrow escape", baseline: () => single("林青死里逃生") },
  {
    label: "another person dies nearby",
    baseline: () => single("敌军将领被杀，林青撤退"),
  },
  // D. 复活/生还清空与事件边界。
  {
    label: "died then revived",
    baseline: () =>
      probeBaseline({
        events: [
          {
            id: "event_probe_death",
            sequence: 1,
            participants: ["character_lin"],
            stateChanges: ["林青被杀"],
          },
          {
            id: "event_probe_revival",
            sequence: 2,
            participants: ["character_lin"],
            stateChanges: ["林青被救活"],
          },
        ],
      }),
  },
  {
    label: "died then shown alive",
    baseline: () =>
      probeBaseline({
        events: [
          {
            id: "event_probe_death",
            sequence: 1,
            participants: ["character_lin"],
            stateChanges: ["林青身亡"],
          },
          {
            id: "event_probe_alive",
            sequence: 2,
            participants: ["character_lin"],
            stateChanges: ["林青还活着"],
          },
        ],
      }),
  },
  {
    label: "death in divergence event",
    baseline: () =>
      probeBaseline({
        events: [],
        divergenceEvent: {
          id: "event_divergence",
          sequence: 100,
          participants: ["character_lin"],
          stateChanges: ["林青死亡"],
        },
      }),
  },
  {
    label: "death after divergence",
    baseline: () =>
      probeBaseline({
        events: [
          {
            id: "event_probe",
            sequence: 150,
            participants: ["character_lin"],
            stateChanges: ["林青病故"],
          },
        ],
      }),
  },
  {
    label: "multi-participant death",
    baseline: () =>
      probeBaseline({
        events: [
          {
            id: "event_probe",
            sequence: 1,
            participants: ["character_lin", "character_han"],
            stateChanges: ["林青被杀，韩松逃走"],
          },
        ],
      }),
  },
  {
    label: "draft story map",
    baseline: () =>
      probeBaseline({
        status: "draft",
        events: [
          {
            id: "event_probe",
            sequence: 1,
            participants: ["character_lin"],
            stateChanges: ["林青被杀"],
          },
        ],
      }),
  },
  // E. 死亡动词后的尾随文本不能是宾语、定语或传闻标记。
  {
    label: "killer pursues participant",
    baseline: () =>
      single("沈墨被杀手追杀", { participants: ["character_shenmo"] }),
  },
  {
    label: "participant executes enemy",
    baseline: () =>
      single("沈墨处死了叛将", { participants: ["character_shenmo"] }),
  },
  {
    label: "bare active execution",
    baseline: () => single("沈墨处死", { participants: ["character_shenmo"] }),
  },
  {
    label: "sacrifices rest time",
    baseline: () =>
      single("沈墨牺牲了休息时间", { participants: ["character_shenmo"] }),
  },
  {
    label: "victim's family arrives",
    baseline: () =>
      single("沈墨被害者家属找上门", { participants: ["character_shenmo"] }),
  },
  {
    label: "death report is fake",
    baseline: () =>
      single("沈墨病故的消息是假的", { participants: ["character_shenmo"] }),
  },
  {
    label: "drowned a cat",
    baseline: () =>
      single("沈墨溺死了一只猫", { participants: ["character_shenmo"] }),
  },
  {
    label: "rumor is not credible",
    baseline: () =>
      single("沈墨遇害一说并不可信", { participants: ["character_shenmo"] }),
  },
  {
    label: "dying and coming back",
    baseline: () =>
      single("沈墨死去活来", { participants: ["character_shenmo"] }),
  },
];

const positiveProbes: PositiveProbe[] = [
  {
    label: "killed",
    characterId: "character_lin",
    baseline: () => single("林青被杀"),
  },
  {
    label: "already died of illness",
    characterId: "character_lin",
    baseline: () => single("林青已病故"),
  },
  {
    label: "died in the army",
    characterId: "character_lin",
    baseline: () => single("林青死于乱军之中"),
  },
  {
    label: "battle death",
    characterId: "character_han",
    baseline: () => single("韩松阵亡", { participants: ["character_han"] }),
  },
  {
    label: "died on the spot",
    characterId: "character_alan",
    baseline: () =>
      single("艾伦当场身亡", { participants: ["character_alan"] }),
  },
  {
    label: "finally executed",
    characterId: "character_lin",
    baseline: () => single("林青终被处死"),
  },
  {
    label: "alias killed",
    characterId: "character_lin",
    baseline: () => single("青儿遇害"),
  },
  {
    label: "later suicide",
    characterId: "character_lin",
    baseline: () => single("随后林青自尽"),
  },
  {
    label: "died for the country",
    characterId: "character_lin",
    baseline: () => single("林青殉国"),
  },
  {
    label: "bare death at clause end",
    characterId: "character_lin",
    baseline: () => single("林青死了。"),
  },
  {
    label: "unfortunately killed",
    characterId: "character_lin",
    baseline: () => single("林青不幸遇难"),
  },
  {
    label: "second clause names the participant",
    characterId: "character_lin",
    baseline: () => single("城破，林青战死"),
  },
  {
    label: "leading time adverb",
    characterId: "character_lin",
    baseline: () => single("最终林青溺亡"),
  },
  {
    label: "already died",
    characterId: "character_lin",
    baseline: () => single("林青已经身亡"),
  },
  {
    label: "executed in the market",
    characterId: "character_lin",
    baseline: () => single("林青被斩于市"),
  },
  {
    label: "illness death",
    characterId: "character_lin",
    baseline: () => single("林青病逝"),
  },
  {
    label: "illness death with clause-final 了",
    characterId: "character_lin",
    baseline: () => single("林青病故了"),
  },
  {
    label: "killed with clause-final 了",
    characterId: "character_shenmo",
    baseline: () =>
      single("沈墨被杀了", { participants: ["character_shenmo"] }),
  },
  {
    label: "died of illness outside the city",
    characterId: "character_shenmo",
    baseline: () =>
      single("沈墨病故于城外", { participants: ["character_shenmo"] }),
  },
  {
    label: "died in prison",
    characterId: "character_shenmo",
    baseline: () =>
      single("沈墨身亡于狱中", { participants: ["character_shenmo"] }),
  },
  {
    label: "killed by someone",
    characterId: "character_shenmo",
    baseline: () =>
      single("沈墨被杀死", { participants: ["character_shenmo"] }),
  },
  {
    label: "murdered by someone",
    characterId: "character_shenmo",
    baseline: () =>
      single("沈墨被害死", { participants: ["character_shenmo"] }),
  },
  {
    label: "died of poison",
    characterId: "character_shenmo",
    baseline: () =>
      single("沈墨死于毒酒", { participants: ["character_shenmo"] }),
  },
];

describe("character status death probes", () => {
  it("only infers dead for explicit, bound death shapes", () => {
    const falsePositiveLabels = negativeProbes
      .filter((probe) => probe.baseline().size > 0)
      .map((probe) => probe.label);
    const falsePositives = falsePositiveLabels.length;

    const missedPositiveLabels = positiveProbes
      .filter((probe) => {
        const inference = probe.baseline().get(probe.characterId);
        return (
          inference?.status !== "dead" ||
          inference.source !== "source_inference"
        );
      })
      .map((probe) => probe.label);
    const recall = positiveProbes.length - missedPositiveLabels.length;

    console.log(
      `death-probes negatives=${negativeProbes.length} falsePositives=${falsePositives} positives=${positiveProbes.length} recall=${recall}/${positiveProbes.length}`,
    );

    expect(falsePositiveLabels).toEqual([]);
    expect(missedPositiveLabels).toEqual([]);
  });
});
