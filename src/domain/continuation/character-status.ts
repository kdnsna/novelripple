import {
  derivePathState,
  mergeCharacterChange,
  type SceneNode,
} from "@/domain/continuation/scene-tree";
import type {
  CharacterStatus,
  Divergence,
  StoryMap,
  WorldlineCharacterStatusOverride,
  WorldlineDelta,
} from "@/domain/schemas";

/** 人物状态的来源；Prompt 与界面共用同一套标签。 */
export type CharacterStatusSource =
  | "source_inference"
  | "impact"
  | "scene"
  | "reader"
  | "default";

export type CharacterStatusHistoryEntry = {
  sourceKind: "divergence" | "scene";
  sceneId: string | null;
  depth: number;
  summary: string;
  /** 该条变化显式携带的状态；未改变状态时缺省。 */
  status?: CharacterStatus;
};

export type DerivedCharacterStatus = {
  characterId: string;
  name: string;
  status: CharacterStatus;
  source: CharacterStatusSource;
  sourceSceneId: string | null;
  /** 来源场景在路径上的深度；分歧点/默认来源为 null。 */
  sourceDepth: number | null;
  summary: string | null;
  history: CharacterStatusHistoryEntry[];
};

export type SourceBaselineStatus = {
  status: "dead";
  source: "source_inference";
  eventId: string;
};

/**
 * 显式死亡句型的动词白名单。
 *
 * 关键词从「句子任意位置出现死亡词」收窄为「姓名 + 有限连接词 + 动词」，
 * 因为自由文本里的死亡词经常属于马、亲属、路人或外国名字的一部分。
 * 这里只放能直接跟在人物姓名后的短动词；`殉` 只以 `殉职/殉国/殉难` 出现，
 * 因而 `殉情未遂` 之类不会命中。主动语态的 `处死` 不收（参与者可能是
 * 行刑者），只保留 `被处死`；`被杀死/被害死` 同样表示参与者是死者。
 */
export const DEATH_VERBS = [
  "死亡",
  "身亡",
  "病故",
  "病逝",
  "病死",
  "去世",
  "逝世",
  "过世",
  "亡故",
  "遇害",
  "遇难",
  "阵亡",
  "战死",
  "殉职",
  "殉国",
  "殉难",
  "被杀",
  "被害",
  "被杀死",
  "被害死",
  "被斩",
  "被处死",
  "牺牲",
  "丧命",
  "毙命",
  "自尽",
  "自缢",
  "溺亡",
  "溺死",
  "死去",
] as const;

/** 姓名与动词之间允许的固定连接词；最多两个，匹配时优先最长词。 */
export const DEATH_CONNECTORS = [
  "已经",
  "当场",
  "不幸",
  "最终",
  "被",
  "已",
  "于",
  "因",
  "终",
  "也",
] as const;

/** 姓名前允许出现的单个短时间副词。 */
export const DEATH_LEADING_ADVERBS = [
  "最终",
  "终于",
  "随后",
  "不久",
  "当夜",
  "次日",
  "最后",
] as const;

/**
 * 姓名（及至多两个连接词）之后、死亡动词之前允许的一个固定原因短语。
 * 只认这些完整短语，匹配时优先最长（如 因伤势过重 先于 因伤）；其它
 * `因+X` 形式一律不匹配，避免把「因伤口感染而死」之类自由文本当成白名单。
 */
export const DEATH_CAUSE_PHRASES = [
  "因伤",
  "因病",
  "因伤势过重",
  "因伤重",
  "因重伤",
  "因病重",
  "因伤不治",
  "因病不治",
] as const;

/**
 * 整句任意位置出现即判 unknown 的否定/不确定措辞。
 * 这里是子串匹配，命中只会让推断更保守。
 */
export const DEATH_NEGATION_MARKERS = [
  "并未",
  "没有",
  "没",
  "未曾",
  "未",
  "未遂",
  "不曾",
  "实则",
  "其实",
  "实际上",
  "传言",
  "传闻",
  "据说",
  "据传",
  "谣传",
  "谣言",
  "误传",
  "误报",
  "误以为",
  "以为",
  "疑似",
  "似乎",
  "可能",
  "或许",
  "听说",
  "也许",
  "好像",
  "大概",
  "兴许",
  "似是",
  "仿佛",
  "好似",
  "认错",
  "误认",
  "讹传",
  "更正",
  "消息",
  "一说",
  "不可信",
  "假的",
  "死去活来",
  "假死",
  "诈死",
  "装死",
  "救活",
  "救回",
  "复活",
  "苏醒",
  "醒来",
  "还活着",
  "仍活着",
  "活了下来",
  "生还",
  "幸存",
  "死里逃生",
  "险些",
  "差点",
  "几乎",
  "不死",
  "没死",
  "未死",
] as const;

/** 问号意味着疑问/未确认，整句命中即 unknown。 */
export const DEATH_QUESTION_MARKERS = ["？", "?"] as const;

/**
 * 整句任意位置出现即判 unknown 的假设/梦境/预感等未实现标记。
 * 这里同样是子串匹配，命中只会让推断更保守。
 */
export const DEATH_HYPOTHETICAL_MARKERS = [
  "若",
  "若是",
  "倘若",
  "倘使",
  "假如",
  "如果",
  "要是",
  "万一",
  "假使",
  "假若",
  "即使",
  "即便",
  "哪怕",
  "设若",
  "梦见",
  "梦里",
  "梦中",
  "梦到",
  "做梦",
  "幻想",
  "幻觉",
  "幻象",
  "想象",
  "设想",
  "以为",
  "担心",
  "害怕",
  "生怕",
  "恐怕",
  "预言",
  "预感",
  "诅咒",
] as const;

/**
 * 未来/计划/扮演/推演等「死亡尚未发生」的标记。
 * 这里是子串匹配，命中只会让推断更保守：姓名里带这些字的角色会永远
 * 保持 unknown（优先漏报，也不把活人标死）。
 */
export const DEATH_FUTURE_PLAN_MARKERS = [
  "将",
  "将要",
  "即将",
  "要",
  "想",
  "打算",
  "计划",
  "准备",
  "预定",
  "预计",
  "明日",
  "明天",
  "来年",
  "明年",
  "日后",
  "他日",
  "年后",
  "之后",
  "欲",
  "企图",
  "密谋",
  "图谋",
  "剧本",
  "戏",
  "扮演",
  "演",
  "推演",
  "模拟",
  "说书",
  "谎",
  "骗",
] as const;

/** 夸张/比喻用法；命中即 unknown。 */
export const DEATH_FIGURATIVE_MARKERS = [
  "笑死",
  "气死",
  "累死",
  "怕死",
  "羞死",
  "吓死",
  "烦死",
  "急死",
  "困死",
  "馋死",
] as const;

/** 死亡事件之后、分歧点之前出现即撤销该人物推断的复活/生还标记。 */
export const DEATH_REVIVAL_MARKERS = [
  "复活",
  "救活",
  "救回",
  "死而复生",
  "苏醒",
  "醒来",
  "生还",
  "幸存",
  "还活着",
  "仍活着",
  "活着",
  "归来",
  "重现",
  "现身",
  "未死",
  "没死",
  "假死",
] as const;

/**
 * 从「分歧点之前、有证据的 fact 事件」推断原著人物基线状态。
 *
 * 这是确定性启发式，不调用模型。它不再按关键词猜测，而是只认显式死亡
 * 句型；其余情况一律 unknown（宁可漏报，也不把活人标死）：
 * - 只在 Story Map 已 confirmed 时推断；草稿/候选一律不推断；
 * - 只读 `sequence < 分歧事件.sequence` 的事件，分歧事件自身与之后事件
 *   都不参与；
 * - 只看 `evidenceKind === "fact"` 且 evidence 非空的事件；
 * - 只有事件**恰好一名参与者**时才可能归因：多人事件一律 unknown，即使
 *   stateChange 点名了其中一人。当前 Event Schema 没有结构化的「死者」
 *   字段（`stateChanges` 是自由文本），因此无法可靠地从多人事件中挑出
 *   被推断者；未来若新增该字段，可以在那一分支使用，而不是解析自由文本；
 * - 单一参与者事件中，stateChange 必须整行命中显式句型白名单
 *   （`matchesExplicitDeathShape`）：整行恰好是一个「姓名 + 有限连接词
 *   + 短死亡动词」的分句；整行没有点名参与者或还带有任何前/后分句时
 *   unknown，整行含否定/不确定/比喻/未来计划措辞，或出现不可见格式/
 *   控制符时 unknown；
 * - 若同一句还整词提到**其他**角色，死亡可能属于别人，跳过；
 * - 推断出 dead 后，若死亡事件之后、分歧点之前的事件再次把该人物列为
 *   参与者或整词点名，并出现复活/生还标记，则撤销推断（回到 unknown）。
 *
 * 只返回基线为 dead 的人物；其余人物由调用方默认为 unknown。
 */
export function deriveSourceBaselineStatuses(input: {
  storyMap: StoryMap;
  divergence: Divergence;
}): Map<string, SourceBaselineStatus> {
  const { storyMap, divergence } = input;
  const divergenceEvent = storyMap.events.find(
    (event) => event.id === divergence.eventId,
  );
  if (!divergenceEvent) {
    throw new Error(`分歧事件不在当前 Story Map 中：${divergence.eventId}`);
  }

  const result = new Map<string, SourceBaselineStatus>();
  // 未确认的 Story Map 还可能被改写；宁可全部 unknown，也不把草稿当原著。
  if (storyMap.status !== "confirmed") return result;

  const charactersById = new Map(
    storyMap.characters.map((character) => [character.id, character]),
  );
  const characterNames = storyMap.characters.map((character) => ({
    characterId: character.id,
    names: [character.name, ...character.aliases].filter(
      (name) => name.length > 0,
    ),
  }));
  const preDivergenceEvents = [...storyMap.events]
    .filter((event) => event.sequence < divergenceEvent.sequence)
    .sort((left, right) => left.sequence - right.sequence);
  const events = preDivergenceEvents.filter(
    (event) => event.evidenceKind === "fact" && event.evidence.length > 0,
  );

  for (const event of events) {
    // 多人事件没有结构化归因；任何“谁死了”的猜测都可能把活人标死。
    if (event.participants.length !== 1) continue;
    const [participant] = event.participants;
    const character = charactersById.get(participant);
    if (!character) continue;

    const names = [character.name, ...character.aliases].filter(
      (name) => name.length > 0,
    );
    for (const stateChange of event.stateChanges) {
      if (mentionsOtherCharacter(stateChange, participant)) continue;
      if (!matchesExplicitDeathShape(stateChange, names)) continue;
      result.set(participant, {
        status: "dead",
        source: "source_inference",
        eventId: event.id,
      });
      break;
    }
  }

  // 复活/生还清空：只扫死亡事件之后、分歧点之前的事件，任何 evidenceKind
  // 都可能推翻先前推断；只要该人物是参与者或整词被点名且句中出现标记。
  if (result.size > 0) {
    const eventById = new Map(
      preDivergenceEvents.map((event) => [event.id, event]),
    );
    const namesById = new Map(
      characterNames.map((entry) => [entry.characterId, entry.names]),
    );
    for (const [characterId, inference] of [...result.entries()]) {
      const deathEvent = eventById.get(inference.eventId);
      if (!deathEvent) continue;
      const names = namesById.get(characterId) ?? [];
      const otherNames = characterNames
        .filter((entry) => entry.characterId !== characterId)
        .flatMap((entry) => entry.names);
      const cleared = preDivergenceEvents.some((event) => {
        if (event.sequence <= deathEvent.sequence) return false;
        const targetsCharacter =
          event.participants.includes(characterId) ||
          event.stateChanges.some((stateChange) =>
            names.some((name) =>
              mentionsWholeWord(stateChange, name, otherNames),
            ),
          );
        return (
          targetsCharacter &&
          event.stateChanges.some((stateChange) =>
            hasAnyMarker(stateChange, DEATH_REVIVAL_MARKERS),
          )
        );
      });
      if (cleared) result.delete(characterId);
    }
  }

  /**
   * 歧义守卫：stateChange 若整词提到其他角色，死亡可能不是单一参与者的。
   * 对每个其他角色，用「其余角色」的姓名作为更长姓名边界，避免把
   * 「张三」误当成「张三丰」的命中。
   */
  function mentionsOtherCharacter(
    stateChange: string,
    participant: string,
  ): boolean {
    return characterNames.some((entry) => {
      if (entry.characterId === participant) return false;
      const longerNames = characterNames
        .filter((other) => other.characterId !== entry.characterId)
        .flatMap((other) => other.names);
      return entry.names.some((name) =>
        mentionsWholeWord(stateChange, name, longerNames),
      );
    });
  }

  return result;
}

/**
 * 显式死亡句型白名单（整行匹配，不切分句）。
 *
 * 去掉首尾空白后，整个 stateChange 必须**恰好**是一个分句：
 * [可选一个 `DEATH_LEADING_ADVERBS` 时间副词] + 人物姓名/别名（≥2 个码点）
 * + [至多两个 `DEATH_CONNECTORS`] + [可选一个 `DEATH_CAUSE_PHRASES`]
 * + `DEATH_VERBS` 中的动词（或裸「死 / 死」+ 可选「了」）
 * + [可选一个「了」] + [可选的单个「。」/「！」/「!」] + 行尾。
 *
 * 匹配前先做两道规范化：
 * - 整行任意位置出现 Unicode 格式符（`\p{Cf}`：零宽、bidi、BOM、软连字符等）
 *   或除 `\t` / `\n` / `\r` 外的控制符（`\p{Cc}`）时直接 unknown，绝不去除
 *   后再匹配；
 * - 随后对整行（以及姓名/别名）做 NFKC 归一化，再做标记与句型匹配。全角
 *   「！」归一为 ASCII `!`，全角字母等兼容字符与 ASCII 姓名一致。
 *
 * 除末尾这一个终止符外，整行任何位置出现标点、引号、括号、省略号或
 * 空白都判 unknown；因此任何前置/后置分句或句子（「城破，林青战死」
 * 「林青身亡，众人悲痛」「众人不信。林青阵亡」）都不会命中。姓名左边界
 * 是行首（或那个时间副词之后），右边界是连接词/动词，因此「张三丰」
 * 不会命中「张三」，地点名「韩松岭」也不会命中「韩松」。
 * 整行任意位置出现问号、否定/不确定措辞、假设/梦境/预感标记、未来/计划
 * 标记或笑死/气死等比喻时也一律不匹配。
 */
export function matchesExplicitDeathShape(
  stateChange: string,
  names: readonly string[],
): boolean {
  // 不可见字符必须最先拒绝：不能先 strip 再匹配，否则零宽字符会切断标记。
  if (hasForbiddenControlChar(stateChange)) return false;
  const normalized = stateChange.normalize("NFKC");
  if (hasAnyMarker(normalized, DEATH_QUESTION_MARKERS)) return false;
  if (hasAnyMarker(normalized, DEATH_HYPOTHETICAL_MARKERS)) return false;
  if (hasAnyMarker(normalized, DEATH_NEGATION_MARKERS)) return false;
  if (hasAnyMarker(normalized, DEATH_FUTURE_PLAN_MARKERS)) return false;
  if (hasAnyMarker(normalized, DEATH_FIGURATIVE_MARKERS)) return false;
  const usableNames = names
    .map((name) => name.normalize("NFKC"))
    .filter((name) => Array.from(name).length >= 2);
  if (usableNames.length === 0) return false;
  const line = toSingleDeathLine(normalized);
  if (line === null) return false;
  return usableNames.some((name) => matchesDeathLine(line, name));
}

/**
 * `\p{Cf}` 全部拒收；`\p{Cc}` 只放过制表、换行与回车。
 * 只用于拒绝，命中不会放宽任何规则。
 */
const FORBIDDEN_CONTROL_CHAR = /(?:(?![\t\n\r])\p{Cc}|\p{Cf})/u;

function hasForbiddenControlChar(value: string): boolean {
  return FORBIDDEN_CONTROL_CHAR.test(value);
}

/** 末尾允许的唯一终止符；出现两个或出现在其它位置都算标点。 */
const ALLOWED_TERMINAL_MARKS = ["。", "！", "!"] as const;
/** 行内（终止符之外）不允许出现任何标点或空白。 */
const INNER_PUNCTUATION_OR_SPACE = /[\p{P}\s]/u;

/**
 * 去掉行尾空白与至多一个终止符，并拒绝其余任何标点/空白。
 * 不切分句：任何逗号、句号、冒号、引号、括号、省略号或句内空白都会
 * 让整行不再是单一死亡分句，返回 null（unknown）。
 */
function toSingleDeathLine(text: string): string | null {
  let line = text.trim();
  for (const mark of ALLOWED_TERMINAL_MARKS) {
    if (line.endsWith(mark)) {
      line = line.slice(0, -mark.length);
      break;
    }
  }
  if (line.length === 0) return null;
  if (INNER_PUNCTUATION_OR_SPACE.test(line)) return null;
  return line;
}

function matchesDeathLine(line: string, name: string): boolean {
  let rest = line;
  // 只允许一个前导时间副词，且去掉后必须紧接姓名；否则保持原样。
  for (const adverb of DEATH_LEADING_ADVERBS) {
    if (!rest.startsWith(adverb)) continue;
    const withoutAdverb = rest.slice(adverb.length);
    if (withoutAdverb.startsWith(name)) {
      rest = withoutAdverb;
      break;
    }
  }
  if (!rest.startsWith(name)) return false;

  let tail = rest.slice(name.length);
  for (let count = 0; count < 2; count += 1) {
    // 连接词与动词/原因短语可能重叠（被杀 = 被 + 杀；因伤 = 连接词「因」
    // + 原因「伤」）；若剩余部分已经以死亡动词、裸「死/死了」或合法原因
    // 短语开头，就不要把它的第一个字当连接词吃掉。
    if (tail === "死" || tail === "死了") break;
    if (DEATH_VERBS.some((verb) => tail.startsWith(verb))) break;
    if (longestMatchingPrefix(tail, DEATH_CAUSE_PHRASES)) break;
    const connector = longestMatchingPrefix(tail, DEATH_CONNECTORS);
    if (!connector) break;
    tail = tail.slice(connector.length);
  }
  const causePhrase = longestMatchingPrefix(tail, DEATH_CAUSE_PHRASES);
  if (causePhrase) {
    // 原因短语后必须是现有死亡动词，裸「死/死了」不算。
    return matchesDeathTail(tail.slice(causePhrase.length));
  }
  if (tail === "死" || tail === "死了") return true;
  return matchesDeathTail(tail);
}

/**
 * 动词之后的精确后缀规则：分句必须结束，或只剩一个「了」。
 * 不再接受「于/在」引出的地点/原因/时间短语，因此 `被杀` 不会命中
 * 「被杀手追杀」，`病故` 不会命中「病故的消息」或「病故于城外」，
 * `牺牲` 不会命中「牺牲了休息时间」。
 */
function matchesDeathTail(tail: string): boolean {
  for (const verb of DEATH_VERBS) {
    if (!tail.startsWith(verb)) continue;
    const rest = tail.slice(verb.length);
    if (rest.length === 0 || rest === "了") return true;
  }
  return false;
}

function longestMatchingPrefix(
  text: string,
  candidates: readonly string[],
): string | null {
  let best: string | null = null;
  for (const candidate of candidates) {
    if (!text.startsWith(candidate)) continue;
    if (best === null || candidate.length > best.length) best = candidate;
  }
  return best;
}

function hasAnyMarker(
  value: string,
  markers: readonly string[],
): boolean {
  return markers.some((marker) => value.includes(marker));
}

/**
 * 整词姓名匹配；只用于让死亡推断更保守，命中不会放宽任何规则。
 *
 * - 少于 2 个码点的姓名/别名永不命中（中文单字名歧义过大）；
 * - 命中不得落在 `otherCharacterNames` 中某个更长姓名/别名的内部：
 *   「张三」不算命中「张三丰」（当「张三丰」属于另一个角色时）；
 * - ASCII 姓名要求两侧不是字母/数字：`Li` 不算命中 `Lily`。
 */
export function mentionsWholeWord(
  text: string,
  name: string,
  otherCharacterNames: readonly string[] = [],
): boolean {
  if (Array.from(name).length < 2) return false;
  const longerNames = otherCharacterNames.filter(
    (other) =>
      other !== name && Array.from(other).length > Array.from(name).length,
  );
  const requireAsciiBoundary = /^[\x00-\x7f]+$/.test(name);

  let from = 0;
  while (from <= text.length - name.length) {
    const start = text.indexOf(name, from);
    if (start === -1) return false;
    const end = start + name.length;
    const isMatch =
      (!requireAsciiBoundary || hasAsciiBoundaries(text, start, end)) &&
      !longerNames.some((longer) =>
        overlapsOccurrence(text, longer, start, end),
      );
    if (isMatch) return true;
    from = start + 1;
  }
  return false;
}

function hasAsciiBoundaries(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
}

/** longer 是否在 [start, end) 范围内出现，从而覆盖短名命中。 */
function overlapsOccurrence(
  text: string,
  longer: string,
  start: number,
  end: number,
): boolean {
  let from = 0;
  while (from <= text.length - longer.length) {
    const index = text.indexOf(longer, from);
    if (index === -1) return false;
    if (index < end && index + longer.length > start) return true;
    from = index + 1;
  }
  return false;
}

/**
 * 沿当前路径派生人物状态，是 UI 与生成 Prompt 的唯一折叠入口。
 *
 * 折叠顺序：
 * 1. 原著基线（分歧前 fact 事件的死亡推断）；
 * 2. `baseDelta`（Impact Plan 只有 summary，没有 status）；
 * 3. 锚在分歧点的读者覆盖；
 * 4. 路径上的每个场景：先折叠 statePatch（显式非 null status 生效，
 *    null/缺省保留旧值），再应用锚在该场景的读者覆盖。
 *
 * 路径本身仍由 `derivePathState` 校验；断裂、跨世界线或非法补丁都会抛错。
 * 只读取给定路径，兄弟分支的覆盖与状态不会泄漏。
 */
export function derivePathCharacterStatuses(input: {
  storyMap: StoryMap;
  divergence: Divergence;
  baseDelta: WorldlineDelta;
  path: readonly SceneNode[];
  overrides: readonly WorldlineCharacterStatusOverride[];
}): DerivedCharacterStatus[] {
  const { storyMap, divergence, baseDelta, path, overrides } = input;
  // 先完整校验路径与补丁，再派生状态。
  const finalState = derivePathState(baseDelta, path);
  const baseline = deriveSourceBaselineStatuses({ storyMap, divergence });
  const historyByCharacter = collectPathCharacterHistory(baseDelta, path);
  const summaryById = new Map(
    finalState.characterChanges.map((change) => [
      change.characterId,
      change.summary,
    ]),
  );

  type StatusEntry = {
    status: CharacterStatus;
    source: CharacterStatusSource;
    sourceSceneId: string | null;
    sourceDepth: number | null;
  };
  const statusById = new Map<string, StatusEntry>();
  const defaultEntry: StatusEntry = {
    status: "unknown",
    source: "default",
    sourceSceneId: null,
    sourceDepth: null,
  };

  for (const character of storyMap.characters) {
    const baselineStatus = baseline.get(character.id);
    statusById.set(
      character.id,
      baselineStatus
        ? {
            status: baselineStatus.status,
            source: baselineStatus.source,
            sourceSceneId: null,
            sourceDepth: null,
          }
        : defaultEntry,
    );
  }

  for (const change of baseDelta.characterChanges) {
    if (change.status === null || change.status === undefined) continue;
    statusById.set(change.characterId, {
      status: change.status,
      source: "impact",
      sourceSceneId: null,
      sourceDepth: null,
    });
  }

  const overridesByAnchor = indexOverrides(overrides);
  applyOverrides(null, null);

  for (const node of path) {
    for (const change of node.statePatch.characterChanges) {
      if (change.status === null || change.status === undefined) continue;
      statusById.set(change.characterId, {
        status: change.status,
        source: "scene",
        sourceSceneId: node.id,
        sourceDepth: node.depth,
      });
    }
    applyOverrides(node.id, node.depth);
  }

  const charactersById = new Map(
    storyMap.characters.map((character) => [character.id, character]),
  );
  const knownIds = new Set(charactersById.keys());
  const result: DerivedCharacterStatus[] = [];
  const append = (characterId: string, name: string) => {
    const entry = statusById.get(characterId) ?? defaultEntry;
    const history = historyByCharacter.get(characterId) ?? [];
    // 只展示非默认状态或有历史的角色；默认 unknown 且从未出现的人不占列表。
    if (
      entry.status === "unknown" &&
      entry.source === "default" &&
      history.length === 0
    ) {
      return;
    }
    result.push({
      characterId,
      name,
      status: entry.status,
      source: entry.source,
      sourceSceneId: entry.sourceSceneId,
      sourceDepth: entry.sourceDepth,
      summary: summaryById.get(characterId) ?? null,
      history,
    });
  };

  for (const character of storyMap.characters) {
    append(character.id, character.name);
  }
  for (const characterId of historyByCharacter.keys()) {
    if (!knownIds.has(characterId)) append(characterId, characterId);
  }

  return result;

  function applyOverrides(
    anchorSceneId: string | null,
    anchorDepth: number | null,
  ): void {
    for (const override of overridesByAnchor.get(anchorSceneId) ?? []) {
      statusById.set(override.characterId, {
        status: override.status,
        source: "reader",
        sourceSceneId: anchorSceneId,
        sourceDepth: anchorDepth,
      });
    }
  }
}

/** 按 baseDelta → 路径场景顺序收集显式人物变化；不含读者覆盖。 */
export function collectPathCharacterHistory(
  baseDelta: WorldlineDelta,
  path: readonly SceneNode[],
): Map<string, CharacterStatusHistoryEntry[]> {
  const historyByCharacter = new Map<string, CharacterStatusHistoryEntry[]>();
  const append = (
    change: {
      characterId: string;
      summary: string;
      status?: CharacterStatus | null;
    },
    sourceKind: "divergence" | "scene",
    sceneId: string | null,
    depth: number,
  ) => {
    const history = historyByCharacter.get(change.characterId) ?? [];
    history.push({
      sourceKind,
      sceneId,
      depth,
      summary: change.summary,
      ...(change.status === null || change.status === undefined
        ? {}
        : { status: change.status }),
    });
    historyByCharacter.set(change.characterId, history);
  };

  for (const change of baseDelta.characterChanges) {
    append(change, "divergence", null, 0);
  }
  for (const node of path) {
    for (const change of node.statePatch.characterChanges) {
      append(change, "scene", node.id, node.depth);
    }
  }
  return historyByCharacter;
}

/**
 * 同一角色同一锚点只有最新一条覆盖生效；不同锚点按路径顺序处理。
 * 返回按 anchor 分组、组内按 (createdAt, id) 升序的覆盖列表。
 */
function indexOverrides(
  overrides: readonly WorldlineCharacterStatusOverride[],
): Map<string | null, WorldlineCharacterStatusOverride[]> {
  const groups = new Map<string | null, WorldlineCharacterStatusOverride[]>();
  for (const override of overrides) {
    const group = groups.get(override.anchorSceneId) ?? [];
    group.push(override);
    groups.set(override.anchorSceneId, group);
  }
  for (const group of groups.values()) {
    group.sort(compareOverrides);
    // 同一角色在同一锚点只保留最新一条，避免依赖后续 set 的覆盖顺序。
    const latestByCharacter = new Map<string, WorldlineCharacterStatusOverride>();
    for (const override of group) {
      latestByCharacter.set(override.characterId, override);
    }
    group.length = 0;
    group.push(...latestByCharacter.values());
    group.sort(compareOverrides);
  }
  return groups;
}

function compareOverrides(
  left: WorldlineCharacterStatusOverride,
  right: WorldlineCharacterStatusOverride,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** 供折叠与测试复用的单条合并规则。 */
export { mergeCharacterChange };
