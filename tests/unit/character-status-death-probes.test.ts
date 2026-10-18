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
  // F. 问号与假设/梦境/预感等未实现语境一律 unknown。
  {
    label: "question after death verb",
    baseline: () => single("林青身亡？"),
  },
  {
    label: "ascii question after death verb",
    baseline: () => single("韩松被杀?", { participants: ["character_han"] }),
  },
  {
    label: "question after illness death",
    baseline: () => single("沈墨病故？", { participants: ["character_shenmo"] }),
  },
  {
    label: "ascii question after battle death",
    baseline: () => single("林青战死?"),
  },
  {
    label: "question after killed",
    baseline: () => single("沈墨遇害？", { participants: ["character_shenmo"] }),
  },
  {
    label: "question after clause-final le",
    baseline: () => single("林青病故了？"),
  },
  {
    label: "ascii question after le",
    baseline: () =>
      single("韩松阵亡了?", { participants: ["character_han"] }),
  },
  {
    label: "exclamation and question",
    baseline: () => single("林青被杀！？"),
  },
  {
    label: "ascii question with exclamation",
    baseline: () =>
      single("沈墨身亡！?", { participants: ["character_shenmo"] }),
  },
  {
    label: "question in another clause",
    baseline: () => single("林青被杀，众人惊呼？"),
  },
  {
    label: "question after second-clause death",
    baseline: () => single("城破，林青战死？"),
  },
  {
    label: "hypothetical ruoshi",
    baseline: () => single("若是城破，林青被杀"),
  },
  {
    label: "hypothetical tangruo",
    baseline: () =>
      single("倘若敌军夜袭，沈墨身亡", { participants: ["character_shenmo"] }),
  },
  {
    label: "hypothetical jiaru",
    baseline: () =>
      single("假如粮尽，韩松阵亡", { participants: ["character_han"] }),
  },
  {
    label: "hypothetical ruguo",
    baseline: () =>
      single("如果退路被断，艾伦遇害", { participants: ["character_alan"] }),
  },
  {
    label: "hypothetical yaoshi",
    baseline: () => single("要是城门失守，林青战死"),
  },
  {
    label: "hypothetical wanyi",
    baseline: () =>
      single("万一援军不到，沈墨病故", { participants: ["character_shenmo"] }),
  },
  {
    label: "hypothetical jishi",
    baseline: () => single("即使城破，林青被杀"),
  },
  {
    label: "dreamed death",
    baseline: () => single("梦见林青身亡"),
  },
  {
    label: "in a dream killed",
    baseline: () => single("梦里韩松被杀", { participants: ["character_han"] }),
  },
  {
    label: "in a dream harmed",
    baseline: () =>
      single("梦中沈墨遇害", { participants: ["character_shenmo"] }),
  },
  {
    label: "believed killed",
    baseline: () => single("以为林青被杀"),
  },
  {
    label: "worried death",
    baseline: () =>
      single("担心沈墨身亡", { participants: ["character_shenmo"] }),
  },
  {
    label: "feared harmed",
    baseline: () =>
      single("生怕韩松遇害", { participants: ["character_han"] }),
  },
  {
    label: "predicted illness death",
    baseline: () =>
      single("预言艾伦病故", { participants: ["character_alan"] }),
  },
  // G. 固定原因短语后必须紧接死亡动词，且整体仍受其它守卫约束。
  {
    label: "injury but leaves the battlefield",
    baseline: () => single("林青因伤退出战场"),
  },
  {
    label: "illness leave request",
    baseline: () => single("韩松因病告假", { participants: ["character_han"] }),
  },
  {
    label: "too injured and unconscious",
    baseline: () =>
      single("沈墨因伤势过重昏迷", { participants: ["character_shenmo"] }),
  },
  {
    label: "father dies of illness",
    baseline: () => single("林青之父因病去世"),
  },
  {
    label: "mount injured and collapses",
    baseline: () =>
      single("沈墨的坐骑因伤倒毙", { participants: ["character_shenmo"] }),
  },
  {
    label: "illness but narrowly survives",
    baseline: () => single("林青因病险些丧命"),
  },
  {
    label: "cause shape followed by question mark",
    baseline: () => single("林青因伤身亡？"),
  },
  {
    label: "hypothetical cause death",
    baseline: () =>
      single("倘若援兵未到，韩松因伤身亡", {
        participants: ["character_han"],
      }),
  },
  {
    label: "rumored illness death",
    baseline: () =>
      single("传言沈墨因病去世", { participants: ["character_shenmo"] }),
  },
  {
    label: "love turns to hate",
    baseline: () => single("林青因爱生恨"),
  },
  {
    label: "illness death report is false",
    baseline: () =>
      single("沈墨因病去世的消息不实", {
        participants: ["character_shenmo"],
      }),
  },
  {
    label: "multi-participant cause death",
    baseline: () =>
      probeBaseline({
        events: [
          {
            id: "event_probe",
            sequence: 1,
            participants: ["character_lin", "character_han"],
            stateChanges: ["林青因伤身亡"],
          },
        ],
      }),
  },
  // H. 死亡分句必须是整个 stateChange 的最后一个分句。
  {
    label: "rhetorical tail without question mark",
    baseline: () => single("林青身亡，是吗"),
  },
  {
    label: "tag question tail",
    baseline: () => single("韩松被杀，对吧", { participants: ["character_han"] }),
  },
  {
    label: "negative tag tail",
    baseline: () =>
      single("沈墨病故，不是么", { participants: ["character_shenmo"] }),
  },
  {
    label: "hearsay tail",
    baseline: () => single("林青身亡，听说的"),
  },
  {
    label: "heard-from-elsewhere tail",
    baseline: () =>
      single("沈墨遇害，这是听来的", { participants: ["character_shenmo"] }),
  },
  {
    label: "doubt tail",
    baseline: () => single("韩松阵亡，也许吧", { participants: ["character_han"] }),
  },
  {
    label: "seems-so tail",
    baseline: () => single("林青被杀，好像是"),
  },
  {
    label: "roughly-so tail",
    baseline: () => single("沈墨身亡，大概如此", { participants: ["character_shenmo"] }),
  },
  {
    label: "disbelief tail",
    baseline: () =>
      single("艾伦遇害，倒是没人信", { participants: ["character_alan"] }),
  },
  {
    label: "crowd does not believe it",
    baseline: () => single("林青病故，众人不信"),
  },
  {
    label: "later correction about identity",
    baseline: () =>
      single("韩松被杀，后来发现认错了人", { participants: ["character_han"] }),
  },
  {
    label: "second sentence says another person died",
    baseline: () =>
      single("沈墨身亡。经查死者另有其人", {
        participants: ["character_shenmo"],
      }),
  },
  {
    label: "second sentence hearsay doubt",
    baseline: () => single("林青身亡。听说死者另有其人"),
  },
  {
    label: "second sentence disbelief",
    baseline: () =>
      single("沈墨被杀。众人不信", { participants: ["character_shenmo"] }),
  },
  {
    label: "colon disbelief tail",
    baseline: () => single("林青身亡：众人不信"),
  },
  {
    label: "dash disbelief tail",
    baseline: () =>
      single("韩松被杀——众人不信", { participants: ["character_han"] }),
  },
  {
    label: "trailing bracket after death verb",
    baseline: () => single("韩松被杀］", { participants: ["character_han"] }),
  },
  {
    label: "trailing bracket after terminal punctuation",
    baseline: () =>
      single("沈墨病故。】", { participants: ["character_shenmo"] }),
  },
  // I. 整行白名单：死亡分句之前出现任何前置分句/句子都不再命中。
  // 以下每一类都至少三条，姓名与措辞各不相同。
  // I-1. 转述/传言框架。
  {
    label: "hearsay frame before valid death clause",
    baseline: () => single("有人说，林青战死"),
  },
  {
    label: "letter frame before valid death clause",
    baseline: () =>
      single("信里写着，韩松阵亡", { participants: ["character_han"] }),
  },
  {
    label: "someone insists before valid death clause",
    baseline: () =>
      single("某人坚称沈墨遇害", { participants: ["character_shenmo"] }),
  },
  {
    label: "reported frame before valid death clause",
    baseline: () =>
      single("据报，艾伦病故", { participants: ["character_alan"] }),
  },
  {
    label: "street rumor frame before valid death clause",
    baseline: () => single("坊间盛传，林青身亡"),
  },
  // I-2. 愿望/计划/密谋。
  {
    label: "wish frame before valid death clause",
    baseline: () => single("盼着林青阵亡"),
  },
  {
    label: "plan frame before valid death clause",
    baseline: () =>
      single("按计划，韩松被杀", { participants: ["character_han"] }),
  },
  {
    label: "plot frame before valid death clause",
    baseline: () =>
      single("依照密谋，沈墨遇害", { participants: ["character_shenmo"] }),
  },
  {
    label: "hoped-for death in another clause",
    baseline: () =>
      single("众人希望艾伦战死", { participants: ["character_alan"] }),
  },
  // I-3. 前一句否定/怀疑，后一句才是死亡句。
  {
    label: "doubt sentence before valid death sentence",
    baseline: () => single("无人相信此事。林青阵亡。"),
  },
  {
    label: "undecided sentence before valid death sentence",
    baseline: () =>
      single("尚无定论。韩松身亡", { participants: ["character_han"] }),
  },
  {
    label: "disbelief sentence before valid death sentence",
    baseline: () =>
      single("众人不肯相信。沈墨战死。", { participants: ["character_shenmo"] }),
  },
  // I-4. 梦境/幻觉/占卜等未实现语境。
  {
    label: "illusion realm before valid death clause",
    baseline: () => single("幻境之中，林青身亡"),
  },
  {
    label: "dazed moment before valid death clause",
    baseline: () =>
      single("恍惚间，韩松被杀", { participants: ["character_han"] }),
  },
  {
    label: "divination sign before valid death clause",
    baseline: () =>
      single("卦象显示，沈墨阵亡", { participants: ["character_shenmo"] }),
  },
  {
    label: "divination result before valid death clause",
    baseline: () =>
      single("占卜结果：艾伦遇害", { participants: ["character_alan"] }),
  },
];

/**
 * 已知漏报：语义上确实是死亡，但显式白名单有意不支持这些写法。
 * 它们必须保持 unknown，但不算 false positive；优先漏报而不是误报。
 */
const knownMisses: NegativeProbe[] = [
  {
    // 语义上确实战死，但整行白名单只接受单一死亡分句，前置的「城破」
    // 让整行不再是白名单形状；优先漏报而不是误报。
    label: "preceding clause before death clause",
    baseline: () => single("城破，林青战死"),
  },
  {
    label: "location phrase before death verb",
    baseline: () => single("林青在乱军中被杀"),
  },
  {
    label: "three or more connectors",
    baseline: () => single("林青最终也已经病故"),
  },
  {
    label: "unnamed death",
    baseline: () => single("病故于城外"),
  },
  {
    label: "unsupported cause phrase",
    baseline: () => single("林青因伤口感染而死"),
  },
  {
    label: "death phrase inside a clause with another subject",
    baseline: () => single("敌军围困，众人只见林青死于乱军之中"),
  },
  {
    label: "supported cause plus unsupported not-cured phrase",
    baseline: () => single("林青因伤重不治身亡"),
  },
  {
    label: "neutral mourning tail",
    baseline: () => single("林青身亡，众人悲痛"),
  },
  {
    label: "neutral burial tail in another clause",
    baseline: () => single("韩松被杀，葬于城外", { participants: ["character_han"] }),
  },
  {
    label: "neutral burial tail in a second sentence",
    baseline: () =>
      single("沈墨病故。三日后下葬", { participants: ["character_shenmo"] }),
  },
  // 语义上确实死亡，但结尾带引号/省略号/ASCII 句点，不属于整行白名单。
  {
    label: "death line ending with closing quote",
    baseline: () => single("林青身亡。」"),
  },
  {
    label: "death line ending with curly quote",
    baseline: () =>
      single("韩松阵亡。”", { participants: ["character_han"] }),
  },
  {
    label: "death line ending with ellipsis",
    baseline: () =>
      single("沈墨病故……", { participants: ["character_shenmo"] }),
  },
  {
    label: "death line ending with ascii period",
    baseline: () =>
      single("艾伦遇害.", { participants: ["character_alan"] }),
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
  {
    label: "died of injuries",
    characterId: "character_lin",
    baseline: () => single("林青因伤身亡"),
  },
  {
    label: "died of illness",
    characterId: "character_han",
    baseline: () => single("韩松因病去世", { participants: ["character_han"] }),
  },
  {
    label: "died of severe injuries",
    characterId: "character_shenmo",
    baseline: () =>
      single("沈墨因伤势过重身亡", { participants: ["character_shenmo"] }),
  },
  {
    label: "finally died of untreated injuries",
    characterId: "character_lin",
    baseline: () => single("林青终因伤不治身亡"),
  },
  {
    label: "already died of illness",
    characterId: "character_shenmo",
    baseline: () =>
      single("沈墨已因病病逝", { participants: ["character_shenmo"] }),
  },
  {
    label: "died of illness in the capital",
    characterId: "character_alan",
    baseline: () =>
      single("艾伦因病逝世于京城", { participants: ["character_alan"] }),
  },
  {
    label: "alias died of illness",
    characterId: "character_lin",
    baseline: () => single("青儿因病亡故"),
  },
  {
    label: "later died of severe injuries",
    characterId: "character_shenmo",
    baseline: () =>
      single("随后沈墨因重伤阵亡", { participants: ["character_shenmo"] }),
  },
  // 边界：行尾空白/换行在匹配前被裁掉，仍是合法单行句型。
  {
    label: "trailing whitespace and newline",
    characterId: "character_lin",
    baseline: () => single("林青被杀  \n"),
  },
  {
    label: "trailing newline after terminal mark",
    characterId: "character_han",
    baseline: () =>
      single("韩松阵亡。\n", { participants: ["character_han"] }),
  },
  {
    label: "ascii exclamation terminal",
    characterId: "character_shenmo",
    baseline: () =>
      single("沈墨病逝!", { participants: ["character_shenmo"] }),
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

    const unexpectedKnownMissLabels = knownMisses
      .filter((probe) => probe.baseline().size > 0)
      .map((probe) => probe.label);

    console.log(
      `death-probes negatives=${negativeProbes.length} falsePositives=${falsePositives} positives=${positiveProbes.length} recall=${recall}/${positiveProbes.length} knownMisses=${knownMisses.length}`,
    );

    expect(falsePositiveLabels).toEqual([]);
    expect(missedPositiveLabels).toEqual([]);
    expect(unexpectedKnownMissLabels).toEqual([]);
  });
});
