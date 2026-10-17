import type { EvidenceUnit } from "@/domain/source/evidence-units";

/**
 * 确定性人名候选统计（不依赖分词库、不调用模型）。
 *
 * 只是给模型的提示：结果可能含误报，最终是否是人物、是否与别人同一身份，
 * 由模型在有证据的事件里决定；身份不确定时不合并。
 *
 * 规则：
 * 1. 常见姓氏 + 1–2 字，出现次数达到阈值；三字形式足够稳定时优先三字名；
 * 2. 「老 / 小 / 阿」+ 单字或 ASCII 字母（如“老顾”“小周”“阿某”“小A”），出现 ≥2 次；
 * 3. 姓氏 + 称谓（如“沈叔”“许先生”）；
 * 4. 对白说话人：姓名后紧跟说/道/问/答/喊/叫等言语动词，或姓名后紧跟「：“」。
 *    说话人命中会提升候选排序，并让姓名形 token 在低频时仍可成为候选；
 * 5. 确定性垃圾过滤：姓氏后紧跟虚词/言语动词（的/了/说/道…）或多数出现后接虚词的
 *    碎片被丢弃；常见“像人名的普通词”进入 STOP_WORDS。
 */
const SINGLE_SURNAMES = [
  ..."王李张刘陈杨黄赵吴周徐孙胡朱郭何林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范廖贾夏韦付邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔汤易常乔赖庞樊兰殷施洪葛岳柳鲁晏柯骆裴詹温席卓蓝凌祁",
];
const SURNAME_SET = new Set(SINGLE_SURNAMES);
const COMPOUND_SURNAMES = ["欧阳", "司马", "诸葛", "上官", "慕容", "东方", "皇甫", "令狐", "公孙", "端木"];
const KINSHIP_TITLES = ["先生", "小姐", "师傅", "老师", "医生", "队长", "主任", "叔", "伯", "姨", "婶", "哥", "姐", "爷", "奶", "嫂"];
const SPEECH_VERBS = ["笑道", "问道", "说道", "答道", "喊道", "说", "道", "问", "答", "喊", "叫"];
const DIALOGUE_COLON = "：“";
/** 候选名后面紧跟这些虚词/言语动词时，多半是“姓氏 + 虚词/动词”的碎片。 */
const FUNCTION_CHARS = new Set([..."的了着过地得说道也都就又和与在把被让给是"]);
/**
 * 比例规则只看“几乎不会跟在真实人名后面”的助词。的 / 说 / 也 / 就 / 在 / 是 等常紧跟真名
 * （所有格、主语 + 副词），不能用来按比例判垃圾。
 */
const RATIO_FUNCTION_CHARS = new Set([..."了着过地得"]);
/** 以姓氏字开头、但通常不是人名的常见词。 */
const STOP_WORDS = new Set(
  (
    "王国 张开 黄色 黄昏 周围 周末 周年 周身 何时 何必 何况 林子 罗列 郑重 梁上 谢谢 唐突 许多 许久 许可 曾经 田野 董事 潘多 蒋介 余下 余光 杜绝 叶子 程度 苏醒 丁点 任何 任务 沈默 姚黄 卢比 姜汤 钟声 钟表 钟头 陆续 陆地 范围 夏天 夏日 付出 付款 邹氏 孟浪 熊熊 秦岭 江水 江边 尹氏 雷声 雷雨 侯爵 龙头 史上 陶器 黎明 贺喜 顾不 顾客 顾忌 毛巾 毛病 万一 万分 钱包 严重 严肃 武器 易于 常常 常见 乔装 庞大 兰花 施工 洪水 岳父 柳树 鲁莽 温度 温柔 温和 席位 蓝色 凌晨 时候 高兴 白天 方向 于是 安静 金色 石头 马上 马路 江湖 文件 明白 成功 东西 " +
    // 补充常见“姓氏字开头但不是人名”的词，以及 老/小/阿 开头的普通词。
    "何苦 何处 何等 何其 何尝 何止 何须 何妨 何故 张望 张罗 张嘴 钱财 钱币 钱庄 黄土 黄泉 黄沙 周旋 周转 周岁 周期 周边 周刊 徐徐 徐缓 孙儿 孙女 孙子 孙辈 胡同 胡闹 胡说 胡来 胡须 朱红 朱砂 朱门 林间 林场 林中 林荫 林海 罗盘 罗网 谢幕 谢绝 谢意 谢礼 宋代 宋体 唐诗 唐人 许配 萧条 萧瑟 田地 田间 田埂 田螺 余音 余晖 余温 余波 余地 余生 余年 杜鹃 叶脉 叶片 程序 程式 苏打 丁香 任命 任性 任意 任职 姜片 姜茶 钟点 钟楼 陆军 陆路 汪洋 范例 范畴 范式 夏季 夏夜 夏风 夏雨 付钱 付账 熊掌 秦朝 秦代 江南 江山 江河 江面 江岸 段落 段子 雷电 雷同 雷达 龙眼 龙虾 龙舟 龙卷 史书 史前 史学 陶瓷 陶土 贺礼 贺卡 顾虑 顾问 毛线 毛皮 毛笔 万岁 万物 万能 钱币 严寒 严密 严格 武术 武艺 武力 莫非 莫不 莫大 莫如 孔雀 孔洞 汤水 汤药 汤圆 易碎 常事 常态 常理 常年 乔木 殷红 施肥 施加 施舍 洪流 洪亮 岳母 柳枝 柳叶 骆驼 温暖 温习 席子 席间 蓝天 蓝图 凌乱 凌空 " +
    // “老/小/阿 + 字”的常见普通词，避免昵称规则误报。
    "老师 老人 老家 老是 老实 老娘 老天 老总 老友 老话 老练 老气 老远 老早 老酒 老屋 老城 老街 老者 老伴 老将 老手 老脸 老本 小时 小心 小孩 小姐 小人 小声 小事 小说 小气 小看 小子 小生 小城 小院 小路 小河 小山 小店 小数 小写 小型 小队 小组 阿姨 阿婆 阿公 阿爸 阿妈"
  ).split(/\s+/),
);
const MIN_COUNT = 3;
/** 非姓氏昵称（阿某 / 小某 / 老某 / 小A）只需要出现两次。 */
const NICKNAME_MIN_COUNT = 2;
const MAX_CANDIDATES = 40;

export type NameCandidate = {
  name: string;
  count: number;
  firstUnitId: string;
  /** 作为对白说话人出现的次数；计入排序权重，并让姓名形 token 在低频时仍可成为候选。 */
  speakerCount: number;
};

export function deriveNameCandidates(units: EvidenceUnit[]): NameCandidate[] {
  const counts = new Map<
    string,
    { count: number; firstUnitId: string; followedByFunction: number }
  >();
  const speakerCounts = new Map<string, number>();
  const invalidSpeakerGrams = new Set<string>();
  const bump = (name: string, unitId: string, nextChar?: string) => {
    const entry = counts.get(name);
    if (entry) {
      entry.count += 1;
      if (isRatioFunctionChar(nextChar)) entry.followedByFunction += 1;
    } else {
      counts.set(name, {
        count: 1,
        firstUnitId: unitId,
        followedByFunction: isRatioFunctionChar(nextChar) ? 1 : 0,
      });
    }
  };
  const bumpSpeaker = (name: string, unitId: string) => {
    speakerCounts.set(name, (speakerCounts.get(name) ?? 0) + 1);
    if (!counts.has(name)) {
      counts.set(name, { count: 0, firstUnitId: unitId, followedByFunction: 0 });
    }
  };
  const speakerCountFor = (name: string) => speakerCounts.get(name) ?? 0;
  const surnames = SURNAME_SET;

  for (const unit of units) {
    const text = unit.text;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]!;
      const compound = COMPOUND_SURNAMES.find((value) => text.startsWith(value, index));
      const surnameLength = compound ? 2 : surnames.has(char) ? 1 : 0;
      if (surnameLength > 0) {
        for (const extra of [1, 2]) {
          const gram = text.slice(index, index + surnameLength + extra);
          if (gram.length === surnameLength + extra && isHan(gram)) {
            bump(gram, unit.id, text[index + gram.length]);
          }
        }
      }
      const nicknameChar = text[index + 1] ?? "";
      if (
        "老小阿".includes(char) &&
        (isHan(nicknameChar) || /^[A-Za-z]$/.test(nicknameChar))
      ) {
        const gram = text.slice(index, index + 2);
        if (!STOP_WORDS.has(gram)) bump(`@${gram}`, unit.id, text[index + 2]);
      }
      if (surnames.has(char)) {
        for (const title of KINSHIP_TITLES) {
          if (text.startsWith(title, index + 1)) {
            bump(`@${char}${title}`, unit.id, text[index + 1 + title.length]);
          }
        }
      }
    }

    // 对白说话人：只在姓名形 token 被言语动词或「：“」紧跟时记一次。
    let skipUntil = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (index < skipUntil) continue;
      for (const length of [2, 3]) {
        const token = text.slice(index, index + length);
        if ([...token].length !== length || !isNameShaped(token)) continue;
        if (hasSpeechVerbPrefix(token)) continue;
        const rest = text.slice(index + length);
        const verb = SPEECH_VERBS.find((value) => rest.startsWith(value));
        if (verb) {
          bumpSpeaker(token, unit.id);
          markVerbGrams(text, index, length, verb.length, invalidSpeakerGrams);
          skipUntil = index + length;
          break;
        }
        if (rest.startsWith(DIALOGUE_COLON)) {
          bumpSpeaker(token, unit.id);
          skipUntil = index + length;
          break;
        }
      }
    }
  }

  const candidates: NameCandidate[] = [];
  for (const [key, entry] of counts) {
    const isNicknameKey = key.startsWith("@");
    const name = isNicknameKey ? key.slice(1) : key;
    if (invalidSpeakerGrams.has(key) || invalidSpeakerGrams.has(name)) continue;
    const nickname = isNicknameKey && isNicknameShape(name);
    if (!nickname && !isNameShaped(name)) continue;
    if (isJunkName(name, entry, speakerCountFor(name))) continue;
    if (isNicknameKey) {
      const speakerCount = speakerCountFor(name);
      const minCount = nickname ? NICKNAME_MIN_COUNT : MIN_COUNT;
      if (entry.count < minCount && speakerCount === 0) continue;
      candidates.push({ name, count: entry.count, firstUnitId: entry.firstUnitId, speakerCount });
      continue;
    }
    const isTwoChar = [...key].length === 2 || COMPOUND_SURNAMES.includes(key.slice(0, 2)) && [...key].length === 3;
    if (!isTwoChar) continue;
    // 二字形式：如果某个三字扩展足够稳定（≥70%），改用三字名。
    const best = [...counts.entries()]
      .filter(([other]) => !other.startsWith("@") && other.length === key.length + 1 && other.startsWith(key))
      .filter(([other]) => !invalidSpeakerGrams.has(other) && isNameShaped(other))
      .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))[0];
    const baseScore = entry.count + speakerCountFor(name);
    const bestName = best?.[0];
    const bestScore = best && bestName ? best[1].count + speakerCountFor(bestName) : 0;
    const chosen: NameCandidate =
      best && bestName && bestScore >= baseScore * 0.7
        ? {
            name: bestName,
            count: best[1].count,
            firstUnitId: best[1].firstUnitId,
            speakerCount: speakerCountFor(bestName),
          }
        : { name, count: entry.count, firstUnitId: entry.firstUnitId, speakerCount: speakerCountFor(name) };
    if (chosen.count < MIN_COUNT && chosen.speakerCount === 0) continue;
    if (isJunkName(chosen.name, best && chosen.name === bestName ? best[1] : entry, chosen.speakerCount)) {
      continue;
    }
    candidates.push(chosen);
  }

  const unique = new Map<string, NameCandidate>();
  const score = (candidate: NameCandidate) => candidate.count + candidate.speakerCount;
  for (const candidate of candidates) {
    const existing = unique.get(candidate.name);
    if (!existing || score(existing) < score(candidate)) unique.set(candidate.name, candidate);
  }
  return [...unique.values()]
    .sort(
      (left, right) =>
        score(right) - score(left) ||
        right.speakerCount - left.speakerCount ||
        left.name.localeCompare(right.name),
    )
    .slice(0, MAX_CANDIDATES);
}

function hasSpeechVerbPrefix(token: string): boolean {
  return SPEECH_VERBS.some((verb) => {
    if (verb.length < 2 || !token.endsWith(verb[0]!)) return false;
    return isNameShaped(token.slice(0, -1));
  });
}

function markVerbGrams(
  text: string,
  index: number,
  tokenLength: number,
  verbLength: number,
  invalid: Set<string>,
): void {
  for (let start = index; start < index + tokenLength; start += 1) {
    const prefixLength = index + tokenLength - start;
    for (let extra = 1; extra <= verbLength; extra += 1) {
      const length = prefixLength + extra;
      if (length < 2 || length > 3) continue;
      invalid.add(text.slice(start, start + length));
    }
  }
}

function isJunkName(
  name: string,
  stats: { count: number; followedByFunction: number },
  speakerCount: number,
): boolean {
  const chars = [...name];
  if (chars.length < 2) return true;
  // “顾的”“顾说”这类姓氏后紧跟虚词/言语动词的二三字碎片。
  if (FUNCTION_CHARS.has(chars[1]!)) return true;
  // 多数出现后面都紧跟虚词/动词时，这个 token 更像词组碎片而不是人名。
  // 对白说话人已被明确识别为人物，保留它，避免把“林舟说”误伤成丢名。
  if (
    speakerCount === 0 &&
    stats.count > 0 &&
    stats.followedByFunction / stats.count >= 0.6
  ) {
    return true;
  }
  return false;
}

function isRatioFunctionChar(char: string | undefined): boolean {
  return char !== undefined && RATIO_FUNCTION_CHARS.has(char);
}

function isNicknameShape(token: string): boolean {
  const chars = [...token];
  if (chars.length !== 2 || !"老小阿".includes(chars[0]!)) return false;
  const second = chars[1]!;
  if (!isHan(second) && !/^[A-Za-z]$/.test(second)) return false;
  return !STOP_WORDS.has(token);
}

/** 群体 / 家族 / 机构名：在确定性安全网和提示词过滤中共用。 */
export function isCollectiveName(value: string): boolean {
  const name = value.trim();
  if (!name) return false;
  if (name.includes("们")) return true;
  if (["众", "众人", "人群", "群众", "看客", "一家", "家人"].some((suffix) => name.endsWith(suffix))) {
    return true;
  }
  const chars = [...name];
  const last = chars.at(-1);
  if (last === "家" || last === "府") {
    return isSurnameToken(name.slice(0, -1));
  }
  return false;
}

function isSurnameToken(value: string): boolean {
  const chars = [...value];
  if (chars.length === 1) return SURNAME_SET.has(chars[0]!);
  return COMPOUND_SURNAMES.includes(value);
}

function isNameShaped(token: string): boolean {
  const chars = [...token];
  if (chars.length < 2 || chars.length > 3 || !isHan(token)) return false;
  if (STOP_WORDS.has(token) || STOP_WORDS.has(token.slice(0, 2))) return false;
  if (COMPOUND_SURNAMES.some((surname) => token.startsWith(surname))) return chars.length === 3;
  if (SURNAME_SET.has(chars[0]!)) return true;
  return chars.length === 2 && "老小阿".includes(chars[0]!) && SURNAME_SET.has(chars[1]!);
}

function isHan(value: string): boolean {
  return /^\p{Script=Han}+$/u.test(value);
}
