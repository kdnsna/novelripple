import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DivergenceSchema,
  ImpactPlanSchema,
  SourceSchema,
  StoryMapSchema,
  type EvidenceReference,
} from "../src/domain/schemas";
import {
  extractMarkdownSections,
  normalizeSourceText,
  sha256,
} from "../src/domain/source/normalize-source";
import { assertValidStoryMap } from "../src/domain/invariants/validate-story-map";

const fixtureDirectory = path.join(process.cwd(), "fixtures", "ripple-001");
const sourcePath = path.join(fixtureDirectory, "source.md");
const originalText = await readFile(sourcePath, "utf8");
const normalizedText = normalizeSourceText(originalText);
const sections = extractMarkdownSections(normalizedText);

const source = SourceSchema.parse({
  id: "source_ripple_001",
  projectId: "project_ripple_001",
  title: "潮汐钟停在凌晨四点",
  originalText,
  normalizedText,
  contentHash: sha256(normalizedText),
  sections,
  createdAt: "2026-08-11T00:00:00.000Z",
});

const quotes = {
  returnToPort:
    "渡船靠上祁雾港时，港口上方那座潮汐钟正停在凌晨四点十二分。",
  openDoor:
    "她依次按下左、左、右、左，铜门内部传来一声迟钝的咔哒。",
  findLedger: "红线系着一只蜡布包，包里是一本巴掌大的账簿。",
  alteredTide:
    "事故当夜四点的一行尤其刺眼：黑字“7.84”，红字“6.92”，旁边有一个小小的三角符号。",
  blueForm:
    "表格是蓝色复写纸，标题写着《东堤传感器异常校正表》。事故当夜的最终值正是六点九二米，签字栏有“许川”两个字。",
  splitKey: "两片铜钥匙合在一起，接缝穿过齿纹中央，严丝合缝。",
  handoff:
    "随后，许澄把红色账簿交给周岚。周岚没有说安慰的话，只把文件袋贴身塞进防水背心。",
  interception:
    "她的车被港务站越野车逼停后撞上护栏，司机受了轻伤。",
  openGate:
    "沈砚拉下旁路杆，许澄转动钥匙。齿轮先是纹丝不动，随后发出一声像骨头复位般的巨响。",
  findPages:
    "锤壳里塞着一只密封玻璃管，管内正是被割下的四页，还有一封写给母亲的信。",
  hearing:
    "鉴定确认蓝表上的“许川”并非本人所签。港务站后台日志的旧备份显示，顾闻舟的账户在事故当夜四点零八分覆盖了潮位值，又在五点以后删除修改记录。",
  archive:
    "市档案馆为红账制作了恒温展柜。许澄坚持把原件、数字副本和证据来源说明放在一起，也把顾闻舟提交的维护表和许川的违规记录收入同一案卷。",
  clockMoves: "铜针越过四点十二分，走到四点十三分。",
  leavePort:
    "当天上午，她将回到海州继续文献修复工作。她没有留在祁雾港替所有人守钟，也没有带走红账。",
  brakePin:
    "传动箱的主齿轮没有折断，只是被一枚生锈的制动销卡住。",
  missingPages:
    "账簿最后四页被整齐割走，只留下纸根。",
  lighthouseTruth:
    "事故当夜，东堤外有人违规抽砂。抽砂船切断了灯塔备用电缆，主电源又在四点零五分被港务站远程关闭。灯灭了七分钟。",
} as const;

function evidence(quote: string): EvidenceReference {
  const start = normalizedText.indexOf(quote);
  if (start < 0) throw new Error(`找不到证据原文：${quote}`);
  if (normalizedText.indexOf(quote, start + quote.length) >= 0) {
    throw new Error(`证据原文不唯一：${quote}`);
  }

  const end = start + quote.length;
  const section = sections.find(
    (candidate) => start >= candidate.start && end <= candidate.end,
  );
  if (!section) throw new Error(`证据未落入任何 Section：${quote}`);

  return {
    sourceId: source.id,
    sectionId: section.id,
    start,
    end,
    excerptHash: sha256(quote),
  };
}

const storyMap = StoryMapSchema.parse({
  id: "story_map_ripple_001_v1",
  sourceId: source.id,
  version: 1,
  status: "confirmed",
  title: "潮汐钟停在凌晨四点",
  logline:
    "文献修复师重返故乡，在下一场风暴到来前重建一宗沉船事故被篡改的证据链。",
  characters: [
    {
      id: "char_xucheng",
      name: "许澄",
      aliases: [],
      role: "protagonist",
      initialState:
        "离岛十二年的文献修复师，背负没有回应哥哥最后求助的愧疚，对任何单一清白叙述保持怀疑。",
    },
    {
      id: "char_zhoulan",
      name: "周岚",
      aliases: [],
      role: "supporting",
      initialState:
        "调查记者，主张建立可公开核对的证据链，也是许澄在岛上的旧友。",
    },
    {
      id: "char_guwenzhou",
      name: "顾闻舟",
      aliases: [],
      role: "antagonist",
      initialState:
        "防潮工程负责人，十二年前为维护港口合同篡改潮位、压低警报并参与掩盖证据。",
    },
    {
      id: "char_shenyan",
      name: "沈砚",
      aliases: ["沈叔"],
      role: "supporting",
      initialState:
        "退休守灯人，持有半把机械钥匙和残损无线电录音，因当年的迟疑长期自责。",
    },
    {
      id: "char_xuchuan",
      name: "许川",
      aliases: [],
      role: "deceased",
      initialState:
        "许澄的哥哥，被旧事故报告归为主要过失者；留下分散证据，也曾因威胁而妥协。",
    },
  ],
  events: [
    {
      id: "event_01",
      title: "许澄重返祁雾港",
      summary:
        "许澄带母亲骨灰回到故乡，看见潮汐钟仍停在十二年前沉船事故的四点十二分。",
      sequence: 1,
      participants: ["char_xucheng", "char_zhoulan"],
      stateChanges: ["许澄重新进入白鸥号事故的空间与人际网络"],
      evidenceKind: "fact",
      evidence: [evidence(quotes.returnToPort)],
    },
    {
      id: "event_02",
      title: "铜门被打开",
      summary:
        "许澄用兄妹旧时的敲击节奏打开钟楼检修门，找到被人为卡住的传动箱。",
      sequence: 2,
      participants: ["char_xucheng", "char_zhoulan", "char_xuchuan"],
      stateChanges: ["钟楼隐藏空间与人为制动痕迹被发现"],
      evidenceKind: "fact",
      evidence: [evidence(quotes.openDoor), evidence(quotes.brakePin)],
    },
    {
      id: "event_03",
      title: "红色账簿现身",
      summary:
        "许澄从地板下取出记录人工潮位的红色账簿，并发现最后四页缺失。",
      sequence: 3,
      participants: ["char_xucheng", "char_zhoulan", "char_xuchuan"],
      stateChanges: ["沉船旧案出现一份可物理鉴定的新证据"],
      evidenceKind: "fact",
      evidence: [evidence(quotes.findLedger), evidence(quotes.missingPages)],
    },
    {
      id: "event_04",
      title: "潮位差被识别",
      summary:
        "红账显示事故当夜高水位被下调近一米，电子蓝表可能经过人为覆盖。",
      sequence: 4,
      participants: ["char_xucheng", "char_zhoulan"],
      stateChanges: ["官方报告中潮位数据的可信度下降"],
      evidenceKind: "inference",
      confidence: 0.94,
      evidence: [evidence(quotes.alteredTide)],
    },
    {
      id: "event_05",
      title: "顾闻舟提供蓝表",
      summary:
        "顾闻舟称红字只是传感器校正，并出示带有可疑许川签名的蓝色校正表。",
      sequence: 5,
      participants: ["char_xucheng", "char_zhoulan", "char_guwenzhou", "char_xuchuan"],
      stateChanges: ["调查出现将责任重新指向许川的误导信息"],
      evidenceKind: "fact",
      evidence: [evidence(quotes.blueForm)],
    },
    {
      id: "event_06",
      title: "灯塔证词补全七分钟",
      summary:
        "沈砚合上半把钥匙，证实灯塔被远程断电七分钟，并交出残损无线电录音。",
      sequence: 6,
      participants: ["char_xucheng", "char_zhoulan", "char_shenyan", "char_xuchuan"],
      stateChanges: ["红账、灯塔和机械钥匙形成独立交叉证据"],
      evidenceKind: "fact",
      evidence: [evidence(quotes.splitKey), evidence(quotes.lighthouseTruth)],
    },
    {
      id: "event_07",
      title: "许澄交出红账",
      summary:
        "许澄完成封装与见证记录，把红色账簿交给周岚送往档案馆并建立异地副本。",
      sequence: 7,
      participants: ["char_xucheng", "char_zhoulan"],
      stateChanges: ["原件暂时离开许澄", "证据链增加独立保管人与数字副本"],
      evidenceKind: "fact",
      evidence: [evidence(quotes.handoff)],
    },
    {
      id: "event_08",
      title: "移交途中遭拦截",
      summary:
        "港务站车辆逼停周岚，红账被带回顾闻舟手中，但低分辨率逐页副本已经外传。",
      sequence: 8,
      participants: ["char_zhoulan", "char_guwenzhou"],
      stateChanges: ["顾闻舟重新控制原件", "外部仍保留可辨认数字副本"],
      evidenceKind: "fact",
      evidence: [evidence(quotes.interception)],
    },
    {
      id: "event_09",
      title: "旧东闸在风暴中开启",
      summary:
        "许澄和沈砚依据独立潮标合并钥匙开启旧闸，保住低洼区并迫使顾闻舟承认改数。",
      sequence: 9,
      participants: ["char_xucheng", "char_shenyan", "char_guwenzhou"],
      stateChanges: ["低洼区水位停止上涨", "顾闻舟口头承认降低警报"],
      evidenceKind: "fact",
      evidence: [evidence(quotes.openGate)],
    },
    {
      id: "event_10",
      title: "缺失四页进入证据链",
      summary:
        "钟锤内的玻璃管保存了付款记录与许川的信，解释了数据造假和他的妥协。",
      sequence: 10,
      participants: ["char_xucheng", "char_shenyan", "char_xuchuan", "char_guwenzhou"],
      stateChanges: ["抽砂付款与数据造假获得物证", "许川的行为被还原为复杂事实"],
      evidenceKind: "fact",
      evidence: [evidence(quotes.findPages)],
    },
    {
      id: "event_11",
      title: "听证会重建事故责任",
      summary:
        "签名鉴定、后台日志、红账和付款记录相互印证，旧报告对许川的主要过失结论被撤销。",
      sequence: 11,
      participants: ["char_xucheng", "char_zhoulan", "char_guwenzhou", "char_xuchuan"],
      stateChanges: ["系统性掩盖进入公共记录", "许川不再承担虚假的主要责任"],
      evidenceKind: "fact",
      evidence: [evidence(quotes.hearing)],
    },
    {
      id: "event_12",
      title: "红账归档，潮汐钟继续",
      summary:
        "红账进入公共档案，钟楼被保留；许澄在潮汐钟越过四点十二分后返回海州。",
      sequence: 12,
      participants: ["char_xucheng", "char_zhoulan", "char_shenyan"],
      stateChanges: ["证据由公共机构长期保存", "许澄结束替家人独自守护旧案的状态"],
      evidenceKind: "fact",
      evidence: [
        evidence(quotes.archive),
        evidence(quotes.clockMoves),
        evidence(quotes.leavePort),
      ],
    },
  ],
  edges: [
    {
      id: "edge_01_02",
      sourceEventId: "event_01",
      targetEventId: "event_02",
      type: "enables",
      explanation: "返港和母亲的信让许澄进入钟楼并尝试旧密码。",
      confidence: 0.99,
      evidence: [evidence(quotes.openDoor)],
      confirmed: true,
    },
    {
      id: "edge_02_03",
      sourceEventId: "event_02",
      targetEventId: "event_03",
      type: "causes",
      explanation: "打开检修门和地板藏匿处直接导致红账被发现。",
      confidence: 0.99,
      evidence: [evidence(quotes.findLedger)],
      confirmed: true,
    },
    {
      id: "edge_03_04",
      sourceEventId: "event_03",
      targetEventId: "event_04",
      type: "causes",
      explanation: "红账中的黑红双值让潮位覆盖问题可被识别。",
      confidence: 0.98,
      evidence: [evidence(quotes.alteredTide)],
      confirmed: true,
    },
    {
      id: "edge_03_05",
      sourceEventId: "event_03",
      targetEventId: "event_05",
      type: "causes",
      explanation: "许澄带着红账质询港务站，顾闻舟才出示蓝表解释。",
      confidence: 0.91,
      evidence: [evidence(quotes.blueForm)],
      confirmed: true,
    },
    {
      id: "edge_03_06",
      sourceEventId: "event_03",
      targetEventId: "event_06",
      type: "enables",
      explanation: "红账留言和半把钥匙把调查引向北岬灯塔。",
      confidence: 0.97,
      evidence: [evidence(quotes.splitKey)],
      confirmed: true,
    },
    {
      id: "edge_06_07",
      sourceEventId: "event_06",
      targetEventId: "event_07",
      type: "enables",
      explanation: "独立灯塔证词提高红账可信度，使正式移交成为合理下一步。",
      confidence: 0.86,
      evidence: [evidence(quotes.handoff)],
      confirmed: true,
    },
    {
      id: "edge_07_08",
      sourceEventId: "event_07",
      targetEventId: "event_08",
      type: "causes",
      explanation: "周岚携原件前往档案馆，触发港务站车辆的拦截。",
      confidence: 0.93,
      evidence: [evidence(quotes.interception)],
      confirmed: true,
    },
    {
      id: "edge_06_09",
      sourceEventId: "event_06",
      targetEventId: "event_09",
      type: "enables",
      explanation: "沈砚的半把钥匙和独立潮标使机械开闸成为可能。",
      confidence: 0.99,
      evidence: [evidence(quotes.openGate)],
      confirmed: true,
    },
    {
      id: "edge_02_10",
      sourceEventId: "event_02",
      targetEventId: "event_10",
      type: "foreshadows",
      explanation: "人为制动的潮汐钟暗示钟体仍藏有需要钟重新运转才能定位的证据。",
      confidence: 0.84,
      evidence: [evidence(quotes.brakePin), evidence(quotes.findPages)],
      confirmed: true,
    },
    {
      id: "edge_03_10",
      sourceEventId: "event_03",
      targetEventId: "event_10",
      type: "foreshadows",
      explanation: "红账整齐缺失的四页预告了后续钟锤中的原页。",
      confidence: 0.99,
      evidence: [evidence(quotes.missingPages), evidence(quotes.findPages)],
      confirmed: true,
    },
    {
      id: "edge_10_11",
      sourceEventId: "event_10",
      targetEventId: "event_11",
      type: "enables",
      explanation: "缺失四页和付款记录补全证据链，使听证会能够重建责任。",
      confidence: 0.98,
      evidence: [evidence(quotes.hearing)],
      confirmed: true,
    },
    {
      id: "edge_11_12",
      sourceEventId: "event_11",
      targetEventId: "event_12",
      type: "causes",
      explanation: "公开听证确认材料价值后，红账归档、钟楼保留并恢复运行。",
      confidence: 0.96,
      evidence: [evidence(quotes.archive), evidence(quotes.clockMoves)],
      confirmed: true,
    },
  ],
  endingCandidates: [
    {
      id: "ending_truth_public",
      targetEventId: "event_11",
      requirement: "白鸥号沉船事故的系统性真相最终进入公共记录",
      evidence: [evidence(quotes.hearing)],
    },
    {
      id: "ending_ledger_archived",
      targetEventId: "event_12",
      requirement: "红色账簿原件最终进入市档案馆",
      evidence: [evidence(quotes.archive)],
    },
    {
      id: "ending_clock_moves",
      targetEventId: "event_12",
      requirement: "潮汐钟最终越过四点十二分并恢复运行",
      evidence: [evidence(quotes.clockMoves)],
    },
    {
      id: "ending_xucheng_leaves",
      targetEventId: "event_12",
      requirement: "许澄在完成归档后返回海州，而非留岛守护旧案",
      evidence: [evidence(quotes.leavePort)],
    },
  ],
});

assertValidStoryMap(storyMap, source);

const divergences = zodArray(DivergenceSchema, [
  {
    id: "div_prevent_handoff",
    eventId: "event_07",
    type: "prevent",
    instruction: "许澄没有把红色账簿交给周岚",
  },
  {
    id: "div_destroy_ledger",
    eventId: "event_07",
    type: "alternate_choice",
    instruction: "许澄当场烧毁红色账簿，并拒绝保留任何副本",
  },
  {
    id: "div_trust_gu",
    eventId: "event_07",
    type: "alternate_choice",
    instruction: "许澄把红色账簿交给顾闻舟保管",
  },
]);

const impactPlans = zodArray(ImpactPlanSchema, [
  {
    id: "impact_prevent_handoff_v1",
    storyMapId: storyMap.id,
    divergence: divergences[0],
    anchors: [
      {
        id: "anchor_truth_public",
        targetEventId: "event_11",
        requirement: "白鸥号沉船事故的系统性真相最终进入公共记录",
        strength: "hard",
      },
    ],
    impacts: [
      {
        id: "impact_01",
        horizon: "immediate",
        changeType: "removed",
        summary: "周岚无法建立原件的第三方移交记录",
        explanation:
          "交付不发生，报社车辆、封装见证和异地上传都不会按原路径发生。",
        reasonPath: ["event_07", "event_08"],
        confidence: 0.98,
      },
      {
        id: "impact_02",
        horizon: "immediate",
        changeType: "modified",
        summary: "顾闻舟会把目标从周岚转向仍持有原件的许澄",
        explanation:
          "追踪车辆失去原路径目标，但顾闻舟仍知道红账存在且需要控制原件。",
        reasonPath: ["event_05", "event_07"],
        confidence: 0.82,
      },
      {
        id: "impact_03",
        horizon: "midterm",
        changeType: "modified",
        summary: "风暴中的开闸判断更依赖沈砚的独立潮标",
        explanation:
          "许澄仍持有红账，但缺少周岚的异地副本；机械钥匙与灯塔潮标成为主要交叉证据。",
        reasonPath: ["event_07", "event_06", "event_09"],
        confidence: 0.9,
      },
      {
        id: "impact_04",
        horizon: "ending",
        changeType: "modified",
        summary: "真相仍可公开，但必须改由许澄在风暴后直接提交",
        explanation:
          "钟锤四页、残带、后台日志与原件仍可形成证据链，只是失去周岚在风暴前建立的独立保管路径。",
        reasonPath: ["event_07", "event_09", "event_10", "event_11"],
        confidence: 0.78,
      },
    ],
    characterChanges: [
      "许澄继续独自承担原件保管风险",
      "周岚从证据保管者转为外部调查与见证者",
    ],
    threadChanges: [
      "关闭：周岚移交途中被拦截",
      "开启：顾闻舟如何定位仍持原件的许澄",
      "保留：钟锤缺失四页与公开听证",
    ],
    anchorEvaluations: [
      {
        anchorId: "anchor_truth_public",
        status: "rerouted",
        explanation:
          "公开结局仍与因果相容，但必须通过许澄直接提交原件、钟锤四页和沈砚录音的新路径到达。",
        reasonPath: ["event_07", "event_06", "event_09", "event_10", "event_11"],
      },
    ],
    uncertainties: [
      "顾闻舟是否会在风暴前直接进入钟楼夺取原件",
      "没有异地高清副本时，受潮红字能保留到何种程度",
    ],
    status: "candidate",
  },
  {
    id: "impact_destroy_ledger_v1",
    storyMapId: storyMap.id,
    divergence: divergences[1],
    anchors: [
      {
        id: "anchor_ledger_archived",
        targetEventId: "event_12",
        requirement: "红色账簿原件最终进入市档案馆",
        strength: "hard",
      },
    ],
    impacts: [
      {
        id: "impact_05",
        horizon: "immediate",
        changeType: "removed",
        summary: "红色账簿原件及其材料鉴定价值永久消失",
        explanation: "烧毁是不可逆变化，照片与压痕不能恢复原件本身。",
        reasonPath: ["event_07"],
        confidence: 1,
      },
      {
        id: "impact_06",
        horizon: "midterm",
        changeType: "modified",
        summary: "旧案只能依赖残带、钟锤四页和后台日志重建",
        explanation: "其他证据仍可能证明造假，但潮位连续记录和保管链被削弱。",
        reasonPath: ["event_07", "event_06", "event_10", "event_11"],
        confidence: 0.92,
      },
      {
        id: "impact_07",
        horizon: "ending",
        changeType: "removed",
        summary: "红账原件无法在档案馆公开陈列",
        explanation: "被销毁的同一物理原件不能同时进入档案馆。",
        reasonPath: ["event_07", "event_12"],
        confidence: 1,
      },
    ],
    characterChanges: ["许澄成为原件毁损的直接责任人"],
    threadChanges: ["关闭：红账原件归档", "保留：其他证据能否公开旧案"],
    anchorEvaluations: [
      {
        anchorId: "anchor_ledger_archived",
        status: "incompatible",
        explanation:
          "同一本红色账簿原件被烧毁后，不可能再进入市档案馆；严格模式必须拒绝该组合。",
        reasonPath: ["event_07", "event_12"],
      },
    ],
    uncertainties: ["其余证据是否足以撤销许川的主要过失结论"],
    status: "candidate",
  },
  {
    id: "impact_trust_gu_v1",
    storyMapId: storyMap.id,
    divergence: divergences[2],
    anchors: [],
    impacts: [
      {
        id: "impact_08",
        horizon: "immediate",
        changeType: "removed",
        summary: "周岚无法建立数字副本和公开移交记录",
        explanation: "原件直接进入顾闻舟控制的港务系统。",
        reasonPath: ["event_07"],
        confidence: 0.99,
      },
      {
        id: "impact_09",
        horizon: "midterm",
        changeType: "modified",
        summary: "顾闻舟可以继续以蓝表指导风暴决策",
        explanation: "红账警告和潮位差不再掌握在许澄与周岚手中。",
        reasonPath: ["event_07", "event_09"],
        confidence: 0.87,
      },
      {
        id: "impact_10",
        horizon: "ending",
        changeType: "modified",
        summary: "公开听证不再是隐藏目标，旧案可能长期保持争议",
        explanation: "开放模式允许原著未来被彻底改变，但残带和钟锤四页仍可能触发新的调查路径。",
        reasonPath: ["event_07", "event_10"],
        confidence: 0.7,
      },
    ],
    characterChanges: [
      "许澄暂时选择相信制度负责人而非记者",
      "顾闻舟重新获得关键物证控制权",
    ],
    threadChanges: [
      "关闭：原路径中的车辆拦截",
      "开启：顾闻舟是否销毁或篡改红账",
      "开启：沈砚能否用残带重新说服许澄",
    ],
    anchorEvaluations: [],
    uncertainties: ["顾闻舟会立即销毁原件还是继续伪造保管流程"],
    status: "candidate",
  },
]);

await Promise.all([
  writeJson("expected-story-map.json", storyMap),
  writeJson("divergences.json", divergences),
  writeJson("expected-impacts.json", impactPlans),
]);

console.log(
  `ripple-001 generated: ${storyMap.events.length} events, ${storyMap.edges.length} edges, ${impactPlans.length} impact plans`,
);

function zodArray<T>(schema: { parse: (value: unknown) => T }, values: unknown[]): T[] {
  return values.map((value) => schema.parse(value));
}

async function writeJson(fileName: string, value: unknown): Promise<void> {
  await writeFile(
    path.join(fixtureDirectory, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}
