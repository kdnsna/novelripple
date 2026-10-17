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
 * 3. 姓氏 + 称谓（如“沈叔”“许先生”）。
 */
const SINGLE_SURNAMES = [
  ..."王李张刘陈杨黄赵吴周徐孙胡朱郭何林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范廖贾夏韦付邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔汤易常乔赖庞樊兰殷施洪葛岳柳鲁晏柯骆裴詹温席卓蓝凌祁",
];
const COMPOUND_SURNAMES = ["欧阳", "司马", "诸葛", "上官", "慕容", "东方", "皇甫", "令狐", "公孙", "端木"];
const KINSHIP_TITLES = ["先生", "小姐", "师傅", "老师", "医生", "队长", "主任", "叔", "伯", "姨", "婶", "哥", "姐", "爷", "奶", "嫂"];
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
};

export function deriveNameCandidates(units: EvidenceUnit[]): NameCandidate[] {
  const counts = new Map<string, { count: number; firstUnitId: string }>();
  const bump = (name: string, unitId: string) => {
    const entry = counts.get(name);
    if (entry) entry.count += 1;
    else counts.set(name, { count: 1, firstUnitId: unitId });
  };
  const surnames = new Set(SINGLE_SURNAMES);

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
  }

  const candidates: NameCandidate[] = [];
  for (const [key, entry] of counts) {
    if (entry.count < MIN_COUNT) continue;
    if (key.startsWith("@")) {
      candidates.push({ name: key.slice(1), ...entry });
      continue;
    }
    if (STOP_WORDS.has(key) || STOP_WORDS.has(key.slice(0, 2))) continue;
    const isTwoChar = [...key].length === 2 || COMPOUND_SURNAMES.includes(key.slice(0, 2)) && [...key].length === 3;
    if (!isTwoChar) continue;
    // 二字形式：如果某个三字扩展足够稳定（≥70%），改用三字名。
    const best = [...counts.entries()]
      .filter(([other]) => !other.startsWith("@") && other.length === key.length + 1 && other.startsWith(key))
      .sort((left, right) => right[1].count - left[1].count)[0];
    if (best && best[1].count >= entry.count * 0.7) {
      candidates.push({ name: best[0], count: best[1].count, firstUnitId: best[1].firstUnitId });
    } else {
      candidates.push({ name: key, ...entry });
    }
  }

  const unique = new Map<string, NameCandidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.name);
    if (!existing || existing.count < candidate.count) unique.set(candidate.name, candidate);
  }
  return [...unique.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, MAX_CANDIDATES);
}

function isHan(value: string): boolean {
  return /^\p{Script=Han}+$/u.test(value);
}
