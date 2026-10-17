import {
  ContextManifestSchema,
  type ContextManifest,
  type ContextManifestSection,
  type ContextManifestSectionKind,
} from "@/domain/schemas";

/** 素材段在 Prompt 中的固定顺序，同时也是 manifest 的顺序。 */
export const CONTEXT_SECTION_ORDER: readonly ContextManifestSectionKind[] = [
  "worldline_setup",
  "canon_events",
  "path_summary",
  "canon_evidence",
  "recent_scenes",
  "selected_direction",
  "anchor_reminder",
];

/** 相关事件证据：裁剪时最后丢弃。 */
export const RELATED_EVIDENCE_PRIORITY = 2;
/** 代表片段与人物证据：先于相关事件证据丢弃。 */
export const STYLE_EVIDENCE_PRIORITY = 1;

/**
 * 原著证据条目由调用方提供。
 *
 * 证据如何选取仍由 `selectContinuationContext` 单独负责；组装器只负责
 * 排序、渲染和按预算裁剪，不复制窗口/人物证据的选择逻辑。
 * `priority` 越大越重要；未提供时按 0 处理，同优先级内从末尾开始丢弃。
 */
export type ContextEvidenceItem = {
  id: string;
  text: string;
  priority?: number;
};

export type ContextSceneItem = {
  id: string;
  text: string;
  /** 降级到第 6 步时，用这段摘要替换正文。 */
  summary?: string;
};

export type ContextAssemblerInput = {
  maxChars: number;
  sections: {
    worldlineSetup: string;
    /** 紧凑世界线设定（只含计数与 key），只作为降级阶梯的一级使用。 */
    worldlineSetupCompact?: string;
    /** 紧凑形式移除的字段名，仅用于 manifest，不得包含正文。 */
    worldlineSetupCompactRemoved?: readonly string[];
    canonEvents?: string;
    pathSummary: string;
    /** 与 pathSummary 行对应的场景 id，用于 manifest 的覆盖信息。 */
    pathSummaryCoveredSceneIds?: readonly string[];
    pathSummaryWatermarkSceneId?: string | null;
    canonEvidence: readonly ContextEvidenceItem[];
    recentScenes: readonly ContextSceneItem[];
    selectedDirection: string;
    anchorReminder: string;
  };
};

export type ContextAssemblerResult = {
  prompt: string;
  manifest: ContextManifest;
};

type NormalizedItem = {
  id: string;
  text: string;
  priority: number;
  summary: string;
  /** 调用方原始顺序，回填证据时用来恢复确定性顺序。 */
  order: number;
};

type LiveSections = {
  worldlineSetup: string;
  canonEvents: string;
  pathSummary: string;
  pathSummaryCoveredSceneIds: string[];
  pathSummaryWatermarkSceneId: string | null;
  canonEvidence: NormalizedItem[];
  recentScenes: NormalizedItem[];
  selectedDirection: string;
  anchorReminder: string;
};

/** v1 场景没有可用摘要时，截断正文后追加的固定标记。 */
export const TRUNCATION_MARKER = "（后文已截断）";

/**
 * 确定性分段上下文组装器（纯函数）。
 *
 * 固定顺序：worldline_setup → canon_events → path_summary → canon_evidence
 * → recent_scenes → selected_direction → anchor_reminder。
 * 所有段都渲染为稳定的 XML 风格标签。
 *
 * 超预算时只沿一条固定降级阶梯前进；最终在渲染长度 <= maxChars 的状态中，
 * 选择证据最多、同等证据下降级最少的一个：
 * 1. 完整内容；
 * 2. canon_evidence 按 priority 从低到高、同优先级从末尾整条丢弃；
 * 3. recent_scenes 从最旧开始整条丢弃，但始终保留最新一个场景；
 * 4. path_summary 按整行从开头裁剪（首行省略/压缩提示保留到最后一刻）；
 * 5. 用紧凑 worldline_setup 整体替换（仅当提供且严格更短）；
 * 6. 用最新场景自己的 summary 替换正文（仅当非空且严格更短）；
 * 7. 最新场景没有可用摘要时，在句末边界截断正文并追加 TRUNCATION_MARKER；
 * 8. 仍超过预算则 fail closed，错误消息包含所需长度与 maxChars。
 *
 * 第 5—7 步释放预算后，会按 priority 从高到低把第 2 步丢弃的证据重新放回，
 * 直到下一条放不下；回填只改变证据集合，不越过预算，且按原始顺序渲染。
 * 较早状态已经放得下但仍有证据被丢弃时，会继续尝试紧凑 worldline_setup
 * 以回填证据；摘要替换与 v1 截断仍只在仍超预算时使用。
 *
 * 不会因为“必需段（完整形式）放不下”提前启用紧凑形式：必需段只是预算下限，
 * 紧凑形式只出现在第 5 步。每一级都只删除或严格缩短内容，因此更大的预算
 * 不会得到更靠后的降级状态。
 *
 * worldline_setup、canon_events、selected_direction、anchor_reminder
 * 永不整段裁剪（worldline_setup 只允许整体替换为更紧凑的等价形式）。
 */
export function assembleContext(
  input: ContextAssemblerInput,
): ContextAssemblerResult {
  const maxChars = input.maxChars;
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error(`上下文预算必须是正整数：${maxChars}`);
  }

  const live: LiveSections = {
    worldlineSetup: input.sections.worldlineSetup.trim(),
    canonEvents: input.sections.canonEvents?.trim() ?? "",
    pathSummary: input.sections.pathSummary.trim(),
    pathSummaryCoveredSceneIds: [
      ...(input.sections.pathSummaryCoveredSceneIds ?? []),
    ],
    pathSummaryWatermarkSceneId:
      input.sections.pathSummaryWatermarkSceneId ?? null,
    canonEvidence: normalizeEvidence(input.sections.canonEvidence),
    recentScenes: normalizeScenes(input.sections.recentScenes),
    selectedDirection: input.sections.selectedDirection.trim(),
    anchorReminder: input.sections.anchorReminder.trim(),
  };

  let worldlineSetupTrimmed = false;
  let evidenceTrimmed = false;
  let scenesTrimmed = false;
  let pathTrimmed = false;
  const droppedEvidence: NormalizedItem[] = [];
  const backfilledEvidenceIds: string[] = [];
  const droppedSceneIds: string[] = [];
  const summarizedSceneIds: string[] = [];
  const truncatedSceneIds: string[] = [];

  const pathLines = splitLines(live.pathSummary);
  const pathLineSceneIds = mapPathSummaryLineSceneIds(
    pathLines,
    live.pathSummaryCoveredSceneIds,
  );

  const finish = (prompt: string): ContextAssemblerResult => ({
    prompt,
    manifest: buildManifest({
      maxChars,
      prompt,
      live,
      pathLineSceneIds,
      worldlineSetupTrimmed,
      compactedFields: worldlineSetupTrimmed
        ? [...(input.sections.worldlineSetupCompactRemoved ?? [])]
        : [],
      evidenceTrimmed,
      scenesTrimmed,
      pathTrimmed,
      droppedEvidenceIds: droppedEvidence.map((item) => item.id),
      backfilledEvidenceIds,
      droppedSceneIds,
      summarizedSceneIds,
      truncatedSceneIds,
    }),
  });

  let prompt = renderPrompt(live);
  if (prompt.length <= maxChars) return finish(prompt);

  const candidates: Array<{
    result: ContextAssemblerResult;
    evidenceCount: number;
  }> = [];

  /** 记录放得下的降级状态；后续按“证据最多、其次降级最少”选择最终状态。 */
  const record = (): void => {
    if (prompt.length > maxChars) return;
    candidates.push({
      result: structuredClone(finish(prompt)),
      evidenceCount: live.canonEvidence.length,
    });
  };

  /**
   * 后续降级释放预算后回填证据：按 priority 从高到低、同优先级按原始顺序
   * 逐条尝试，只有整条放得下才放回；回填后仍按原始顺序渲染。
   */
  const backfillEvidence = (): void => {
    if (droppedEvidence.length === 0) return;
    const backfillCandidates = [...droppedEvidence].sort(
      (left, right) =>
        right.priority - left.priority || left.order - right.order,
    );
    for (const candidate of backfillCandidates) {
      const index = droppedEvidence.indexOf(candidate);
      if (index < 0) continue;
      const restored = [...live.canonEvidence, candidate].sort(
        (left, right) => left.order - right.order,
      );
      const restoredPrompt = renderPrompt({
        ...live,
        canonEvidence: restored,
      });
      // 只回填优先级最高的连续前缀：下一条放不下就停止，不回填更低的条目。
      if (restoredPrompt.length > maxChars) break;
      live.canonEvidence = restored;
      prompt = restoredPrompt;
      evidenceTrimmed = true;
      droppedEvidence.splice(index, 1);
      backfilledEvidenceIds.push(candidate.id);
    }
  };

  // 2. 原著证据：低优先级先丢，同优先级从末尾整条丢弃。
  while (live.canonEvidence.length > 0 && prompt.length > maxChars) {
    const index = lowestPriorityLastIndex(live.canonEvidence);
    const dropped = live.canonEvidence.splice(index, 1)[0]!;
    droppedEvidence.push(dropped);
    evidenceTrimmed = true;
    prompt = renderPrompt(live);
  }
  record();

  // 3. 最近场景：只在仍超预算时从最旧开始整条丢弃，最新一个永远保留。
  while (prompt.length > maxChars && live.recentScenes.length > 1) {
    const dropped = live.recentScenes.shift()!;
    droppedSceneIds.push(dropped.id);
    scenesTrimmed = true;
    prompt = renderPrompt(live);
    record();
  }

  // 4. 路径摘要：按整行从开头裁剪，不切断任何一行；首行提示最后才丢。
  while (prompt.length > maxChars && pathLines.length > 0) {
    const dropIndex =
      pathLines.length > 1 && isOmissionLine(pathLines[0]!) ? 1 : 0;
    pathLines.splice(dropIndex, 1);
    pathLineSceneIds.splice(dropIndex, 1);
    live.pathSummary = pathLines.join("\n");
    pathTrimmed = true;
    prompt = renderPrompt(live);
    record();
  }

  // 5. 紧凑 worldline_setup：只在阶梯走到这里时使用，且必须严格更短。
  // 已经放得下但有证据被丢时也尝试，让第 5—7 步释放的预算能回填证据。
  const compactSetup = input.sections.worldlineSetupCompact?.trim() ?? "";
  if (
    (prompt.length > maxChars || droppedEvidence.length > 0) &&
    compactSetup.length > 0 &&
    compactSetup.length < live.worldlineSetup.length
  ) {
    live.worldlineSetup = compactSetup;
    worldlineSetupTrimmed = true;
    prompt = renderPrompt(live);
    backfillEvidence();
    record();
  }

  // 6. 最新场景有可用摘要：用摘要替换正文，与“整体丢弃”分开记录。
  let summarySwapped = false;
  if (prompt.length > maxChars && live.recentScenes.length > 0) {
    const index = live.recentScenes.length - 1;
    const newest = live.recentScenes[index]!;
    if (hasUsableSummary(newest)) {
      live.recentScenes[index] = { ...newest, text: newest.summary };
      summarizedSceneIds.push(newest.id);
      summarySwapped = true;
      scenesTrimmed = true;
      prompt = renderPrompt(live);
      backfillEvidence();
      record();
    }
  }

  // 7. 最新场景没有可用摘要（v1）：在句末边界截断，保留标点并标记后文省略。
  if (prompt.length > maxChars && live.recentScenes.length > 0 && !summarySwapped) {
    const index = live.recentScenes.length - 1;
    const newest = live.recentScenes[index]!;
    if (!hasUsableSummary(newest)) {
      const available =
        maxChars - (prompt.length - newest.text.length) - TRUNCATION_MARKER.length;
      const prefix = longestSentencePrefix(newest.text, available);
      if (prefix !== null) {
        live.recentScenes[index] = {
          ...newest,
          text: `${prefix}${TRUNCATION_MARKER}`,
        };
        truncatedSceneIds.push(newest.id);
        scenesTrimmed = true;
        prompt = renderPrompt(live);
        backfillEvidence();
        record();
      }
    }
  }

  // 选择证据最多、同等证据下降级最少的状态；这保证预算增大时已保留的
  // 证据不会因为更早返回一个“放得下但证据更少”的状态而消失。
  const feasible = candidates.filter(
    (candidate) => candidate.result.prompt.length <= maxChars,
  );
  if (feasible.length > 0) {
    let best = feasible[0]!;
    for (const candidate of feasible) {
      if (candidate.evidenceCount > best.evidenceCount) best = candidate;
    }
    return best.result;
  }

  // 8. 所有可用降级都试过仍放不下：fail closed，不返回半成品。
  const mandatoryPrompt = renderMandatoryPrompt(live);
  if (mandatoryPrompt.length > maxChars) {
    throw new Error(
      `必需上下文段超过预算：需要 ${mandatoryPrompt.length} 字符，maxChars=${maxChars}`,
    );
  }
  throw new Error(
    `必需上下文段与最新场景超过预算：需要 ${prompt.length} 字符，maxChars=${maxChars}`,
  );
}

function renderPrompt(sections: LiveSections): string {
  const blocks: string[] = [];
  if (sections.worldlineSetup.length > 0) {
    blocks.push(renderStringSection("worldline_setup", sections.worldlineSetup));
  }
  if (sections.canonEvents.length > 0) {
    blocks.push(renderStringSection("canon_events", sections.canonEvents));
  }
  if (sections.pathSummary.length > 0) {
    blocks.push(renderStringSection("path_summary", sections.pathSummary));
  }
  if (sections.canonEvidence.length > 0) {
    blocks.push(renderItemSection("canon_evidence", sections.canonEvidence));
  }
  if (sections.recentScenes.length > 0) {
    blocks.push(renderItemSection("recent_scenes", sections.recentScenes));
  }
  if (sections.selectedDirection.length > 0) {
    blocks.push(
      renderStringSection("selected_direction", sections.selectedDirection),
    );
  }
  if (sections.anchorReminder.length > 0) {
    blocks.push(renderStringSection("anchor_reminder", sections.anchorReminder));
  }
  return blocks.join("\n\n");
}

function renderMandatoryPrompt(sections: LiveSections): string {
  return renderPrompt({
    worldlineSetup: sections.worldlineSetup,
    canonEvents: sections.canonEvents,
    pathSummary: "",
    pathSummaryCoveredSceneIds: [],
    pathSummaryWatermarkSceneId: null,
    canonEvidence: [],
    recentScenes: [],
    selectedDirection: sections.selectedDirection,
    anchorReminder: sections.anchorReminder,
  });
}

function renderStringSection(
  kind: ContextManifestSectionKind,
  text: string,
): string {
  return `<${kind}>\n${text}\n</${kind}>`;
}

function renderItemSection(
  kind: ContextManifestSectionKind,
  items: readonly NormalizedItem[],
): string {
  return `<${kind}>\n${items.map((item) => item.text).join("\n\n")}\n</${kind}>`;
}

function normalizeEvidence(
  items: readonly ContextEvidenceItem[],
): NormalizedItem[] {
  return items
    .map((item, order) => {
      const priority = item.priority ?? 0;
      if (!Number.isInteger(priority)) {
        throw new Error(`证据优先级必须是整数：${item.id}`);
      }
      return {
        id: item.id,
        text: item.text.trim(),
        priority,
        summary: "",
        order,
      };
    })
    .filter((item) => item.text.length > 0);
}

function normalizeScenes(items: readonly ContextSceneItem[]): NormalizedItem[] {
  return items
    .map((item, order) => ({
      id: item.id,
      text: item.text.trim(),
      priority: 0,
      summary: item.summary?.trim() ?? "",
      order,
    }))
    .filter((item) => item.text.length > 0);
}

/** 摘要必须非空且严格短于正文才值得替换。 */
function hasUsableSummary(item: NormalizedItem): boolean {
  return item.summary.length > 0 && item.summary.length < item.text.length;
}

const SENTENCE_TERMINATORS = new Set(["。", "！", "？", "!", "?", "…", "；", ";", "\n"]);

/** 成对引号；ASCII 双引号同时充当开引号与闭引号。ASCII 单引号不算引号（常作撇号，如 don't）。 */
const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  "「": "」",
  "『": "』",
  "“": "”",
  "‘": "’",
  '"': '"',
};
const CLOSING_QUOTES = new Set(["」", "』", "”", "’"]);

type OpenQuote = {
  close: string;
  index: number;
};

/**
 * 返回不超过 maxLength 的最长句末前缀（保留标点）。
 *
 * 只按句末边界截断，不在句子中间切；句末落在未闭合引号内时跳过，
 * 不把引号切成两半，也不把 `……` 拆成单个省略号。若只有引号内的句末
 * 可选，则在最外层开引号之前截断；完全没有边界时返回 null。
 */
function longestSentencePrefix(
  text: string,
  maxLength: number,
): string | null {
  if (maxLength <= 0) return null;
  const limit = Math.min(text.length, maxLength);
  const openQuotes: OpenQuote[] = [];
  let cut = -1;
  let fallbackOpenIndex = -1;

  for (let index = 0; index < limit; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      if (openQuotes.at(-1)?.close === char) {
        openQuotes.pop();
      } else {
        openQuotes.push({ close: char, index });
      }
      continue;
    }
    if (Object.hasOwn(QUOTE_PAIRS, char)) {
      openQuotes.push({ close: QUOTE_PAIRS[char]!, index });
      continue;
    }
    if (CLOSING_QUOTES.has(char)) {
      if (openQuotes.at(-1)?.close === char) openQuotes.pop();
      continue;
    }
    if (!SENTENCE_TERMINATORS.has(char)) continue;

    if (char === "…") {
      // 第二个 … 已由前一个省略号作为一对处理。
      if (text[index - 1] === "…") continue;
      // 只能截到一对 `……` 之后；只剩半个省略号时不能在这里截断。
      if (text[index + 1] === "…" && index + 2 > limit) continue;
    }

    if (openQuotes.length > 0) {
      if (fallbackOpenIndex < 0) {
        fallbackOpenIndex = openQuotes[0]!.index;
      }
      continue;
    }

    cut = Math.max(
      cut,
      char === "…" && text[index + 1] === "…" ? index + 2 : index + 1,
    );
  }

  if (cut > 0) return text.slice(0, cut);
  if (fallbackOpenIndex >= 0) return text.slice(0, fallbackOpenIndex);
  return null;
}

/** 最低优先级中最后一个条目的下标，等价于同优先级从末尾丢弃。 */
function lowestPriorityLastIndex(items: readonly NormalizedItem[]): number {
  let lowest = items[0]!.priority;
  for (const item of items) {
    if (item.priority < lowest) lowest = item.priority;
  }
  let index = 0;
  for (const [current, item] of items.entries()) {
    if (item.priority === lowest) index = current;
  }
  return index;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

function isOmissionLine(line: string): boolean {
  return (
    line.startsWith("更早剧情（第 ") || line.startsWith("（更早的 ")
  );
}

/**
 * 把 pathSummary 的行对齐到场景 id。
 *
 * 首行可能是 `更早剧情（第 a–b 幕）：...`，它只覆盖实际显示的 b-a+1 个
 * 压缩场景（a > 1 时更早的标题已被丢弃）；其余行与剩余场景一一对应。
 * 无法安全对齐时不猜测，返回空映射。
 */
function mapPathSummaryLineSceneIds(
  lines: readonly string[],
  coveredSceneIds: readonly string[],
): string[][] {
  if (lines.length === 0) return [];
  if (coveredSceneIds.length === 0) return lines.map(() => []);

  const marker = /^更早剧情（第 (\d+)–(\d+) 幕）：/u.exec(lines[0] ?? "");
  if (marker) {
    const first = Number(marker[1]);
    const last = Number(marker[2]);
    const compressed = last - first + 1;
    const remaining = coveredSceneIds.length - compressed;
    if (
      first >= 1 &&
      last >= first &&
      compressed > 0 &&
      remaining >= 0 &&
      remaining === lines.length - 1
    ) {
      return [
        coveredSceneIds.slice(0, compressed),
        ...coveredSceneIds.slice(compressed).map((id) => [id]),
      ];
    }
    if (lines.length === 1) return [[...coveredSceneIds]];
  }

  if (coveredSceneIds.length === lines.length) {
    return lines.map((_, index) => [coveredSceneIds[index]!]);
  }
  return lines.map(() => []);
}

function buildManifest(input: {
  maxChars: number;
  prompt: string;
  live: LiveSections;
  pathLineSceneIds: string[][];
  worldlineSetupTrimmed: boolean;
  compactedFields: string[];
  evidenceTrimmed: boolean;
  scenesTrimmed: boolean;
  pathTrimmed: boolean;
  droppedEvidenceIds: string[];
  backfilledEvidenceIds: string[];
  droppedSceneIds: string[];
  summarizedSceneIds: string[];
  truncatedSceneIds: string[];
}): ContextManifest {
  const { live } = input;
  const coveredPathSceneIds = input.pathLineSceneIds
    .flat()
    .filter((id) => id.length > 0);
  const pathWatermark =
    coveredPathSceneIds.length > 0
      ? coveredPathSceneIds[coveredPathSceneIds.length - 1]!
      : live.pathSummaryCoveredSceneIds.length === 0 &&
          live.pathSummary.length > 0
        ? live.pathSummaryWatermarkSceneId
        : null;

  const sections: ContextManifestSection[] = CONTEXT_SECTION_ORDER.map((kind) => {
    switch (kind) {
      case "worldline_setup": {
        const included = live.worldlineSetup.length > 0;
        return section(
          kind,
          included,
          included
            ? renderStringSection(kind, live.worldlineSetup).length
            : 0,
          input.worldlineSetupTrimmed,
          [],
          input.worldlineSetupTrimmed
            ? { compactedFields: input.compactedFields }
            : {},
        );
      }
      case "canon_events": {
        const included = live.canonEvents.length > 0;
        return section(
          kind,
          included,
          included ? renderStringSection(kind, live.canonEvents).length : 0,
          false,
          [],
        );
      }
      case "path_summary": {
        const included = live.pathSummary.length > 0;
        return section(
          kind,
          included,
          included
            ? renderStringSection(kind, live.pathSummary).length
            : 0,
          input.pathTrimmed,
          [],
          {
            coveredItemIds: coveredPathSceneIds,
            watermarkId: pathWatermark,
          },
        );
      }
      case "canon_evidence": {
        const included = live.canonEvidence.length > 0;
        return section(
          kind,
          included,
          included
            ? renderItemSection(kind, live.canonEvidence).length
            : 0,
          input.evidenceTrimmed,
          input.droppedEvidenceIds,
          input.backfilledEvidenceIds.length > 0
            ? { backfilledItemIds: input.backfilledEvidenceIds }
            : undefined,
        );
      }
      case "recent_scenes": {
        const included = live.recentScenes.length > 0;
        return section(
          kind,
          included,
          included
            ? renderItemSection(kind, live.recentScenes).length
            : 0,
          input.scenesTrimmed,
          input.droppedSceneIds,
          {
            ...(input.summarizedSceneIds.length > 0
              ? { summarizedItemIds: input.summarizedSceneIds }
              : {}),
            ...(input.truncatedSceneIds.length > 0
              ? { truncatedItemIds: input.truncatedSceneIds }
              : {}),
          },
        );
      }
      case "selected_direction": {
        const included = live.selectedDirection.length > 0;
        return section(
          kind,
          included,
          included
            ? renderStringSection(kind, live.selectedDirection).length
            : 0,
          false,
          [],
        );
      }
      case "anchor_reminder": {
        const included = live.anchorReminder.length > 0;
        return section(
          kind,
          included,
          included
            ? renderStringSection(kind, live.anchorReminder).length
            : 0,
          false,
          [],
        );
      }
    }
  });

  const totalChars = input.prompt.length;
  return ContextManifestSchema.parse({
    budget: {
      totalChars,
      maxChars: input.maxChars,
      percentageUsed:
        Math.round((totalChars / input.maxChars) * 100 * 10) / 10,
    },
    sections,
  });
}

type SectionExtras = {
  summarizedItemIds?: string[];
  truncatedItemIds?: string[];
  backfilledItemIds?: string[];
  compactedFields?: string[];
  coveredItemIds?: string[];
  watermarkId?: string | null;
};

function section(
  kind: ContextManifestSectionKind,
  included: boolean,
  chars: number,
  trimmed: boolean,
  droppedItemIds: string[],
  extras?: SectionExtras,
): ContextManifestSection {
  return {
    kind,
    included,
    chars,
    trimmed,
    droppedItemIds,
    ...(extras ?? {}),
  };
}
