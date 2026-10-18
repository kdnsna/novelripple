import {
  StoryMapSchema,
  WorldlineDeltaSchema,
  type StoryMap,
  type WorldlineDelta,
} from "@/domain/schemas";
import { validateAgainstPreDivergenceCanon } from "@/domain/invariants/validate-continuation";

/**
 * Canon 护栏的标注探针（全部为自建短句，不含任何作品原文）。
 *
 * 迷你故事地图：分歧事件是 event_4（夜巡开始）；event_1 / event_3 是分歧前
 * 锁定事件；event_2 被当前路径状态删除；event_5 是分歧后事件。探针只评估
 * strict 策略下的硬拒绝与低置信 warning。
 */
const reference = {
  sourceId: "source_probe",
  sectionId: "section_probe",
  start: 0,
  end: 8,
  excerptHash: `sha256:${"a".repeat(64)}`,
};

export const CANON_GUARD_PROBE_STORY_MAP: StoryMap = StoryMapSchema.parse({
  schemaVersion: 1,
  id: "story_map_canon_guard_probe",
  sourceId: "source_probe",
  version: 1,
  status: "confirmed",
  title: "探针故事",
  logline: "沈砚守住灯塔，也守住自己的选择",
  characters: [
    {
      id: "character_shen",
      name: "沈砚",
      aliases: [],
      role: "protagonist",
      initialState: "负责看管灯塔",
    },
  ],
  events: [
    {
      id: "event_1",
      title: "灯塔熄灭",
      summary: "灯塔在风暴中熄灭",
      sequence: 1,
      participants: ["character_shen"],
      stateChanges: ["港口陷入黑暗"],
      evidenceKind: "fact",
      evidence: [reference],
    },
    {
      id: "event_2",
      title: "渡船停航",
      summary: "夜班渡船停航",
      sequence: 2,
      participants: ["character_shen"],
      stateChanges: ["渡口关闭"],
      evidenceKind: "fact",
      evidence: [reference],
    },
    {
      id: "event_3",
      title: "交出钥匙",
      summary: "沈砚交出灯塔钥匙",
      sequence: 3,
      participants: ["character_shen"],
      stateChanges: ["钥匙易手"],
      evidenceKind: "fact",
      evidence: [reference],
    },
    {
      id: "event_4",
      title: "夜巡开始",
      summary: "夜巡队沿石阶出发",
      sequence: 4,
      participants: ["character_shen"],
      stateChanges: ["夜巡开始"],
      evidenceKind: "fact",
      evidence: [reference],
    },
    {
      id: "event_5",
      title: "封锁码头",
      summary: "码头在清晨被封锁",
      sequence: 5,
      participants: ["character_shen"],
      stateChanges: ["码头关闭"],
      evidenceKind: "fact",
      evidence: [reference],
    },
  ],
  edges: [],
  endingCandidates: [
    {
      id: "ending_probe",
      targetEventId: "event_5",
      requirement: "码头恢复通行",
      evidence: [reference],
    },
  ],
});

export const CANON_GUARD_PROBE_PATH_STATE: WorldlineDelta =
  WorldlineDeltaSchema.parse({
    factsAdded: [],
    factsRemoved: ["event:event_2"],
    characterChanges: [],
    threadsOpened: [],
    threadsClosed: [],
  });

/** 19 条语义上应被拒绝的改写；字面护栏只能覆盖其中一部分。 */
export const CANON_GUARD_SHOULD_REJECT = [
  "灯塔熄灭从未发生。",
  "灯塔熄灭根本没有发生过。",
  "灯塔熄灭是捏造的。",
  "从来没有发生过灯塔熄灭。",
  "并没有灯塔熄灭这回事。",
  "灯塔熄灭其实并未出现。",
  "灯塔熄灭这件事根本不存在。",
  "灯塔熄灭的说法被推翻了。",
  "灯塔熄灭的传闻是假的。",
  "灯塔从未熄灭过。",
  "故事里灯塔熄灭这一设定不再成立。",
  // 反事实/失去义线索只有与否定谓词同分句且在其前面时才豁免。
  "灯塔熄灭从未发生过，如果有人问起就这么说。",
  "假如你还记得，灯塔熄灭根本没有发生过。",
  // 发生/存在类否定的更多口语变体。
  "灯塔熄灭没发生过。",
  "灯塔熄灭这件事压根没发生。",
  "灯塔熄灭未发生过。",
  "灯塔熄灭未曾发生。",
  "灯塔熄灭没有发生过。",
  // 裸「说」不再无条件豁免：叙述者直接断言，不是引述。
  "这么说来，灯塔熄灭从未发生过。",
] as const;

/**
 * 19 条合法续写：回忆、因果、附近出现其他否定词、反事实/失去义、分歧后事件
 * 与路径删除。裸 `没有<title>` 不再是硬拒绝。
 */
export const CANON_GUARD_LEGITIMATE = [
  "她想起灯塔熄灭那晚，从此不再靠近海岸。",
  "他始终没有忘记灯塔熄灭时的那声钟响。",
  "她取消了灯塔熄灭后的庆功宴。",
  "灯塔熄灭之后，他再也没有提起那件事。",
  "封锁码头之后，众人各自散去。",
  "封锁码头并没有发生，他们改在第二天集合。",
  "渡船停航从未发生。",
  "灯塔熄灭之后，海面恢复了平静。",
  "每个人都记得灯塔熄灭的那个夜晚。",
  "因为灯塔熄灭，渔民们不再出海。",
  "交出钥匙之后，夜巡开始了。",
  "她不曾忘记渡船停航前的约定。",
  "灯塔熄灭的事，他后来常常提起。",
  "封锁码头那场雨里，没有人再说话。",
  "如果没有灯塔熄灭，两人也不会结仇。",
  "再也没有了灯塔熄灭那晚的热闹。",
  "没有灯塔熄灭那天的任何记录留下来。",
  // 同一分句内的反事实：只产生 warning，不能硬拒绝。
  "要是灯塔熄灭从未发生，她会留在岛上。",
  "若是灯塔熄灭从未发生，港口仍会亮着灯。",
] as const;

/**
 * 37 条对白/谎言/传闻/怀疑/角色断言/愿望/被转述/冒号直接引语，以及逗号
 * 引出的无引号话语、后置引述、整段配对的多句引语与嵌套引语的句子。
 *
 * 这些句子里的“未发生/不存在/是假的”属于角色话语或叙述者的不确定转述，
 * 不是叙述者的直接断言；只允许 warning，必须 0 条硬拒绝。
 */
export const CANON_GUARD_DIALOGUE_LIE = [
  "他说灯塔熄灭从未发生过。",
  "听说灯塔熄灭根本没有发生过。",
  "据传交出钥匙是捏造的。",
  "难道灯塔熄灭从未发生？",
  "也许交出钥匙根本不存在。",
  "“灯塔熄灭从来没有发生过。”她撒谎道。",
  "他骗众人说交出钥匙是假的。",
  "她坚称灯塔熄灭从未发生，没人信。",
  // PR #15：角色断言与愿望框架同样只警告。
  "老渔夫一口咬定灯塔熄灭没发生过。",
  "她咬定交出钥匙从来没有发生过。",
  "他多希望灯塔熄灭从未发生。",
  "但愿交出钥匙从未发生过。",
  "她坚持说灯塔熄灭根本没有发生过。",
  "他矢口否认交出钥匙存在过。",
  // 冒号直接跟在框架动词后引入直接引语：引语直到句末都受框架治理，
  // 引语内逗号不打断。
  "他说：灯塔熄灭从未发生过。",
  "据说：交出钥匙根本没有发生过。",
  "她喊道：别担心，灯塔熄灭从来没有发生过。",
  // PR #15 第 4 轮：逗号引出的无引号角色话语、后置引述与整段配对的多句
  // 引语同样只警告（产品决策 B）。
  "老渔夫坚称，灯塔熄灭从未发生过。",
  "他低声道，交出钥匙根本没有发生过。",
  "老人道，灯塔熄灭从来没有发生过。",
  "他道：灯塔熄灭从未发生过。",
  "他问道：交出钥匙根本没有发生过。",
  "她坚持说，交出钥匙未曾发生。",
  "他一口咬定，灯塔熄灭压根没有发生过。",
  "他告诉我，灯塔熄灭从未发生过。",
  "灯塔熄灭从未发生过，他说。",
  "交出钥匙根本没有发生过，老人低声道。",
  "交出钥匙从来没有发生过，她坚持说。",
  // 引号先在整段文本上配对，多句引语的第二句仍属于引号内容。
  "「灯塔熄灭之后，港口很安静。灯塔熄灭从未发生过。」她低声说。",
  "“交出钥匙之后，他离开了小岛。交出钥匙从来没有发生过。”老人说。",
  // 上一轮作为“框架在前分句”的硬拒绝样本；决策 B 下它是角色转述，移入本集。
  "她坚称，交出钥匙从来没有发生过。",
  // PR #15 第 5 轮：大叫/尖叫/高声道等复合言语动词、`道` 的结构区分、
  // 20 字长定语主语，以及不同风格嵌套引语。
  "船工大叫，灯塔熄灭根本没有发生过。",
  "她尖叫，交出钥匙从未发生过！",
  "他高声道，交出钥匙根本没有发生过。",
  "老人道，灯塔熄灭从未发生过。",
  "那个总在码头边打盹的老更夫坚称，灯塔熄灭从未发生过。",
  "“他低声道：『灯塔熄灭从未发生过。』”",
] as const;

/**
 * 框架在第一分句、叙述者否定在第二分句的句子。
 *
 * 第 6 轮后，否定前出现角色主语或推测分句的样本会合法地降级为 warning；
 * 本集只保留“否定前没有任何角色主语/推测分句”的叙述者否定：愿望词但无
 * 主语、传闻分句、分句起点转折词、非引语冒号，以及场景/时间/天气/物品
 * 分句。这些必须继续硬拒绝。
 */
export const CANON_GUARD_FRAME_THEN_NARRATOR = [
  "但愿明天风平浪静，交出钥匙根本没有发生过。",
  "村长怀疑有人偷了船；灯塔熄灭从未发生过。",
  "据说那年很冷；交出钥匙根本没有发生过。",
  "她咬定是风浪的错，可交出钥匙根本没有发生过。",
  "他以为没人知道，但灯塔熄灭从未发生过。",
  "他以为没人知道但灯塔熄灭从未发生过。",
  "他坚称，可灯塔熄灭从未发生过。",
  "结论只有一个：灯塔熄灭从未发生过。",
  // 第 6 轮新增：否定前没有任何角色主语或推测分句的场景/时间/天气/
  // 物品分句、非引语冒号、分号，以及角色分句之后的转折词。
  "夜色渐深，灯塔熄灭从未发生过。",
  "雨点敲着窗，交出钥匙根本没有发生过。",
  "钟声在港口回荡，灯塔熄灭未曾发生。",
  "石阶上积着水，交出钥匙压根没有发生过。",
  "唯一的解释：灯塔熄灭根本没有发生过。",
  "风停了；灯塔熄灭从未发生过。",
  "他点点头，但灯塔熄灭从未发生过。",
  "潮水退去，交出钥匙从未发生过。",
  // 无角色主语的「量词 + 道」分句仍不是“说道”，后面的否定硬拒绝。
  "前面只有一条道，灯塔熄灭从未发生过。",
] as const;

/**
 * 第 6 轮从 should-reject / frame-then-narrator 移出的样本。
 *
 * 否定之前存在带角色主语的叙述分句（「他……」「众人……」）或以逗号结尾的
 * 推测分句（「也许……」「他可能……」），按产品决定属于角色话语/不确定
 * 转述，只 warning。文本保持不变，仅改归类。
 */
export const CANON_GUARD_RECLASSIFIED_WARN = [
  // 同时从 CANON_GUARD_SHOULD_REJECT 与 FRAME_THEN_NARRATOR 移出：
  // 众人是人称代词主语。
  "众人说完后便散了，灯塔熄灭从未发生过。",
  // 从 CANON_GUARD_FRAME_THEN_NARRATOR 移出：角色主语/推测分句在前。
  "她希望能早点回家，灯塔熄灭从未发生过。",
  "他可能已经忘了，灯塔熄灭从来没有发生过。",
  "也许是她听错了，交出钥匙压根没有发生过。",
  "或许风浪太大，灯塔熄灭未曾发生。",
  "他以为自己听错了，交出钥匙根本没有发生过。",
  "他告诉我风暴要来，灯塔熄灭从未发生过。",
  "他发誓自己没撒谎，交出钥匙从来没有发生过。",
  "她否认见过那盏灯，灯塔熄灭根本没有发生过。",
  "她喊道快点走，交出钥匙从未发生过。",
  "他听说风暴要来了，灯塔熄灭从来没有发生过。",
  "他说起旧年的灯，交出钥匙从来没有发生过。",
  "他骗众人说风浪很大，灯塔熄灭根本没有发生过。",
  "她声称自己看见了光，灯塔熄灭从未发生过。",
  "他解释说风浪太大，交出钥匙根本没有发生过。",
  "他可能记错了，灯塔熄灭从未发生过。",
  "他走上那条道，灯塔熄灭从未发生过。",
] as const;

/**
 * 24 条「角色主语 + 表外语义动词 + ， + 叙述者式否定」探针。
 *
 * 动词刻意不依赖言语动词表（表示/称/透露/承认/警告/嘱咐/提醒/转告/
 * 坦言/补充/解释/回忆/强调/指出/抱怨/安慰/保证/宣布/通知/暗示/叮嘱/
 * 劝/写道/记得…），主语覆盖 Story Map 姓名、人称代词与 老渔夫/船长/
 * 守塔人/村里的孩子们/掌柜的伙计们 等短人物名词。全部必须 0 条硬拒绝。
 */
export const CANON_GUARD_OFF_LIST_VERBS = [
  "沈砚表示，灯塔熄灭从未发生过。",
  "沈砚称，交出钥匙根本没有发生过。",
  "他透露，灯塔熄灭从来没有发生过。",
  "她承认，交出钥匙压根没有发生过。",
  "老渔夫警告，灯塔熄灭未曾发生。",
  "船长嘱咐，交出钥匙并没有发生过。",
  "守塔人提醒，灯塔熄灭从没发生过。",
  "沈砚转告，交出钥匙并未发生。",
  "她坦言，灯塔熄灭不曾发生过。",
  "他补充，交出钥匙从来没有发生过。",
  "船长解释，灯塔熄灭根本没有发生过。",
  "沈砚回忆，交出钥匙没有发生过。",
  "她强调，灯塔熄灭从未发生。",
  "老渔夫指出，交出钥匙根本不存在。",
  "他抱怨，灯塔熄灭其实没有发生过。",
  "村里的孩子们安慰，交出钥匙并没有发生过。",
  "掌柜的伙计们保证，灯塔熄灭从未发生过。",
  "沈砚宣布，交出钥匙未曾发生。",
  "她通知，灯塔熄灭压根没发生。",
  "船长暗示，交出钥匙没有发生过。",
  "他叮嘱，灯塔熄灭根本没有发生过。",
  "老渔夫劝，交出钥匙从来没有发生过。",
  "她写道，灯塔熄灭从未发生过。",
  "沈砚记得，交出钥匙并未发生。",
] as const;

/**
 * 18 条推测框架探针：每个推测词后接逗号，再接否定（主语有无都覆盖）。
 * 推测分句只说明这是人物的估计或叙述者的不确定转述，必须 0 条硬拒绝。
 */
export const CANON_GUARD_SPECULATION = [
  "他估计，灯塔熄灭从未发生过。",
  "大概，交出钥匙根本没有发生过。",
  "似乎，灯塔熄灭从来没有发生过。",
  "恐怕，交出钥匙压根没有发生过。",
  "他以为，灯塔熄灭未曾发生。",
  "她怀疑，交出钥匙并未发生。",
  "他猜想，灯塔熄灭从没发生过。",
  "她猜测，交出钥匙不曾发生过。",
  "兴许，灯塔熄灭根本没有发生过。",
  "也许，交出钥匙没有发生过。",
  "或许，灯塔熄灭没发生过。",
  "可能，交出钥匙未发生过。",
  "想必，灯塔熄灭从来没有发生过。",
  "多半，交出钥匙根本没有发生过。",
  "仿佛，灯塔熄灭从未发生过。",
  "好像，交出钥匙压根没有发生过。",
  "看来，灯塔熄灭未曾发生。",
  "据估计，交出钥匙并未发生。",
] as const;

/**
 * 7 条 fail-closed 引号探针：开引号未闭合、风格混用、跨段孤立开/闭引号、
 * 段首未闭合与撇号误用都不能遮蔽后面的叙述者否定，因此整组必须硬拒绝。
 * 单独的 `’` 按撇号忽略，不会让同一句里的坏引号被漏掉。
 */
export const CANON_GUARD_BROKEN_QUOTE_NARRATOR = [
  // 段落中间一个多余开引号、没有闭合。
  "夜色渐深，“灯塔熄灭从未发生过。",
  // 中英引号混用：“…” 永远等不到对应的 ”，」 是孤立关闭引号。
  "“灯塔熄灭从未发生过。」",
  // 第一段孤立开引号、第二段叙述者否定、第三段孤立闭引号：不能跨段配对。
  "“他离开了码头。\n灯塔熄灭从未发生过。\n她回来了。」",
  // 段首开引号整段没有闭合：按 fail-closed 策略按旁白处理。
  "“灯塔熄灭从未发生过。海面很安静。",
  // 单独的 ’ 是撇号；同一段里的坏开引号仍不覆盖否定。
  "海风’很冷，“灯塔熄灭从未发生过。",
  // 单独的 ‘ 没有闭合，不遮蔽任何内容。
  "海风很冷，‘灯塔熄灭从未发生过。",
  // 只有孤立关闭引号时同样不能遮蔽叙述者否定。
  "灯塔熄灭从未发生过。」",
] as const;

/**
 * 8 条按评审方类别构造的对白探针：谎言、引号对白、传闻、怀疑/疑问、
 * maybe、角色咬定、愿望、转述。全部是自建短句，必须 0 条硬拒绝。
 */
export const CANON_GUARD_REVIEWER_DIALOGUE = [
  "他撒谎说灯塔熄灭从未发生过。", // lie
  "“交出钥匙从来没有发生过。”她低声说。", // quoted dialogue
  "据说灯塔熄灭根本没有发生过。", // hearsay
  "她怀疑交出钥匙从未存在过。", // doubt/question
  "或许灯塔熄灭从来没有发生过。", // maybe
  "老渔夫一口咬定灯塔熄灭没发生过。", // character insists
  "他多希望灯塔熄灭从未发生。", // wish
  "她转述说灯塔熄灭根本没有发生过。", // reported speech
] as const;

/** 数百字中性叙述，逐字提到锁定事件标题但不含否定/改写语义。 */
export const CANON_GUARD_NEUTRAL_PROSE = [
  "灯塔熄灭之后，海面恢复了平静。",
  "渔船在清晨靠岸，渡船停航的消息传到了码头。",
  "交出钥匙的人站在门外，夜巡的队伍沿着石阶走过。",
  "灯塔熄灭后的第三个清晨，沈砚把旧灯罩擦干净。",
  "有人问起渡船停航的原因，码头的老人只是摇头。",
  "交出钥匙的决定写在值班簿上，夜巡的路线没有改变。",
  "封锁码头的清晨下着小雨，众人按原计划出发。",
  "午后阳光落在桅杆上，港口照常忙碌，孩子们在防波堤上追逐。",
  "灯塔熄灭后的故事被写进港志，读者只看到一段平静的记述。",
].join("");

export type CanonGuardProbeStats = {
  /** 应拒绝样本中被硬拒绝的数量。 */
  caught: number;
  /** 合法续写中被硬拒绝的数量（必须为 0）。 */
  hardFalseRejects: number;
  /** 合法续写中出现 warning 的数量。 */
  warningsOnLegitimate: number;
  /** 中性长文中被硬拒绝的数量（必须为 0）。 */
  neutralHardRejects: number;
  /** 应拒绝样本中出现 warning 的数量。 */
  warningsOnShouldReject: number;
  /** 对白/谎言/传闻样本中被硬拒绝的数量（必须为 0）。 */
  dialogueHardRejects: number;
  /** 对白/谎言/传闻样本中出现 warning 的数量。 */
  dialogueWarnings: number;
  /** 框架在前一分句、叙述者否定在后一分句的样本中被硬拒绝的数量。 */
  frameThenNarratorCaught: number;
  /** fail-closed 引号样本（坏引号不能遮蔽叙述者否定）中被硬拒绝的数量。 */
  brokenQuoteNarratorCaught: number;
  /** 评审方类别对白样本中被硬拒绝的数量（必须为 0）。 */
  reviewerDialogueHardRejects: number;
  /** 评审方类别对白样本中出现 warning 的数量。 */
  reviewerDialogueWarnings: number;
  /** 表外言语动词样本中被硬拒绝的数量（必须为 0）。 */
  offListVerbHardRejects: number;
  /** 表外言语动词样本中出现 warning 的数量。 */
  offListVerbWarnings: number;
  /** 推测框架样本中被硬拒绝的数量（必须为 0）。 */
  speculationHardRejects: number;
  /** 推测框架样本中出现 warning 的数量。 */
  speculationWarnings: number;
  /** 第 6 轮重新归类样本中被硬拒绝的数量（必须为 0）。 */
  reclassifiedHardRejects: number;
  /** 第 6 轮重新归类样本中出现 warning 的数量。 */
  reclassifiedWarnings: number;
};

function evaluate(text: string) {
  return validateAgainstPreDivergenceCanon({
    textFields: [{ field: "probe", text }],
    storyMap: CANON_GUARD_PROBE_STORY_MAP,
    divergenceEventId: "event_4",
    pathState: CANON_GUARD_PROBE_PATH_STATE,
    policy: "strict",
  });
}

export function computeCanonGuardProbeStats(): CanonGuardProbeStats {
  const shouldReject = CANON_GUARD_SHOULD_REJECT.map(evaluate);
  const legitimate = CANON_GUARD_LEGITIMATE.map(evaluate);
  const dialogue = CANON_GUARD_DIALOGUE_LIE.map(evaluate);
  const reviewerDialogue = CANON_GUARD_REVIEWER_DIALOGUE.map(evaluate);
  const frameThenNarrator = CANON_GUARD_FRAME_THEN_NARRATOR.map(evaluate);
  const brokenQuoteNarrator = CANON_GUARD_BROKEN_QUOTE_NARRATOR.map(evaluate);
  const offListVerbs = CANON_GUARD_OFF_LIST_VERBS.map(evaluate);
  const speculation = CANON_GUARD_SPECULATION.map(evaluate);
  const reclassified = CANON_GUARD_RECLASSIFIED_WARN.map(evaluate);
  const neutral = evaluate(CANON_GUARD_NEUTRAL_PROSE);
  return {
    caught: shouldReject.filter((result) => result.issues.length > 0).length,
    hardFalseRejects: legitimate.filter((result) => result.issues.length > 0)
      .length,
    warningsOnLegitimate: legitimate.filter(
      (result) => result.warnings.length > 0,
    ).length,
    neutralHardRejects: neutral.issues.length,
    warningsOnShouldReject: shouldReject.filter(
      (result) => result.warnings.length > 0,
    ).length,
    dialogueHardRejects: dialogue.filter((result) => result.issues.length > 0)
      .length,
    dialogueWarnings: dialogue.filter((result) => result.warnings.length > 0)
      .length,
    frameThenNarratorCaught: frameThenNarrator.filter(
      (result) => result.issues.length > 0,
    ).length,
    brokenQuoteNarratorCaught: brokenQuoteNarrator.filter(
      (result) => result.issues.length > 0,
    ).length,
    reviewerDialogueHardRejects: reviewerDialogue.filter(
      (result) => result.issues.length > 0,
    ).length,
    reviewerDialogueWarnings: reviewerDialogue.filter(
      (result) => result.warnings.length > 0,
    ).length,
    offListVerbHardRejects: offListVerbs.filter(
      (result) => result.issues.length > 0,
    ).length,
    offListVerbWarnings: offListVerbs.filter(
      (result) => result.warnings.length > 0,
    ).length,
    speculationHardRejects: speculation.filter(
      (result) => result.issues.length > 0,
    ).length,
    speculationWarnings: speculation.filter(
      (result) => result.warnings.length > 0,
    ).length,
    reclassifiedHardRejects: reclassified.filter(
      (result) => result.issues.length > 0,
    ).length,
    reclassifiedWarnings: reclassified.filter(
      (result) => result.warnings.length > 0,
    ).length,
  };
}
