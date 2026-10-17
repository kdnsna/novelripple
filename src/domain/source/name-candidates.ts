import type { EvidenceUnit } from "@/domain/source/evidence-units";

/**
 * 确定性人名候选统计（不依赖分词库、不调用模型）。
 *
 * 只是给模型的提示：结果可能含误报，最终是否是人物、是否与别人同一身份，
 * 由模型在有证据的事件里决定；身份不确定时不合并。
 *
 * 规则：
 * 1. 常见姓氏 + 1–2 字，出现次数达到阈值；三字形式足够稳定时优先三字名；
 * 2. 「老 / 小 / 阿」+ 姓氏（如“老顾”“小周”）；
 * 3. 姓氏 + 称谓（如“沈叔”“许先生”）；
 * 4. 对白说话人：姓名后紧跟说/道/问/答/喊/叫等言语动词，或姓名后紧跟「：“」。
 *    说话人命中会提升候选排序；它仍受姓氏/称谓与 STOP_WORDS 过滤，不会单独把任意词变成候选。
 */
const SINGLE_SURNAMES = [
  ..."王李张刘陈杨黄赵吴周徐孙胡朱郭何林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范廖贾夏韦付邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔汤易常乔赖庞樊兰殷施洪葛岳柳鲁晏柯骆裴詹温席卓蓝凌祁",
];
const SURNAME_SET = new Set(SINGLE_SURNAMES);
const COMPOUND_SURNAMES = ["欧阳", "司马", "诸葛", "上官", "慕容", "东方", "皇甫", "令狐", "公孙", "端木"];
const KINSHIP_TITLES = ["先生", "小姐", "师傅", "老师", "医生", "队长", "主任", "叔", "伯", "姨", "婶", "哥", "姐", "爷", "奶", "嫂"];
const SPEECH_VERBS = ["笑道", "问道", "说道", "答道", "喊道", "说", "道", "问", "答", "喊", "叫"];
const DIALOGUE_COLON = "：“";
/** 以姓氏字开头、但通常不是人名的常见词。 */
const STOP_WORDS = new Set(
  "王国 张开 黄色 黄昏 周围 周末 周年 周身 何时 何必 何况 林子 罗列 郑重 梁上 谢谢 唐突 许多 许久 许可 曾经 田野 董事 潘多 蒋介 余下 余光 杜绝 叶子 程度 苏醒 丁点 任何 任务 沈默 姚黄 卢比 姜汤 钟声 钟表 钟头 陆续 陆地 范围 夏天 夏日 付出 付款 邹氏 孟浪 熊熊 秦岭 江水 江边 尹氏 雷声 雷雨 侯爵 龙头 史上 陶器 黎明 贺喜 顾不 顾客 顾忌 毛巾 毛病 万一 万分 钱包 严重 严肃 武器 易于 常常 常见 乔装 庞大 兰花 施工 洪水 岳父 柳树 鲁莽 温度 温柔 温和 席位 蓝色 凌晨 时候 高兴 白天 方向 于是 安静 金色 石头 马上 马路 江湖 文件 明白 成功 东西".split(" "),
);
const MIN_COUNT = 3;
const MAX_CANDIDATES = 40;

export type NameCandidate = {
  name: string;
  count: number;
  firstUnitId: string;
  /** 作为对白说话人出现的次数；计入排序权重，并让姓名形 token 在低频时仍可成为候选。 */
  speakerCount: number;
};

export function deriveNameCandidates(units: EvidenceUnit[]): NameCandidate[] {
  const counts = new Map<string, { count: number; firstUnitId: string }>();
  const speakerCounts = new Map<string, number>();
  const invalidSpeakerGrams = new Set<string>();
  const bump = (name: string, unitId: string) => {
    const entry = counts.get(name);
    if (entry) entry.count += 1;
    else counts.set(name, { count: 1, firstUnitId: unitId });
  };
  const bumpSpeaker = (name: string, unitId: string) => {
    speakerCounts.set(name, (speakerCounts.get(name) ?? 0) + 1);
    if (!counts.has(name)) counts.set(name, { count: 0, firstUnitId: unitId });
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
          if (gram.length === surnameLength + extra && isHan(gram)) bump(gram, unit.id);
        }
      }
      if ("老小阿".includes(char) && surnames.has(text[index + 1] ?? "")) {
        const gram = text.slice(index, index + 2);
        if (!STOP_WORDS.has(gram)) bump(`@${gram}`, unit.id);
      }
      if (surnames.has(char)) {
        for (const title of KINSHIP_TITLES) {
          if (text.startsWith(title, index + 1)) bump(`@${char}${title}`, unit.id);
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
    const name = key.startsWith("@") ? key.slice(1) : key;
    if (invalidSpeakerGrams.has(key) || invalidSpeakerGrams.has(name)) continue;
    if (!isNameShaped(name)) continue;
    if (key.startsWith("@")) {
      const speakerCount = speakerCountFor(name);
      if (entry.count < MIN_COUNT && speakerCount === 0) continue;
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
