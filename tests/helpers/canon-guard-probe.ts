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

/** 11 条语义上应被拒绝的改写；字面护栏只能覆盖其中一部分。 */
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
] as const;

/**
 * 17 条合法续写：回忆、因果、附近出现其他否定词、反事实/失去义、分歧后事件
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
 * 8 条对白/谎言/传闻/怀疑/被转述的句子。
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
  };
}
