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
  /** 超预算且场景挤不下时，用这段摘要替换正文。 */
  summary?: string;
};

export type ContextAssemblerInput = {
  maxChars: number;
  sections: {
    worldlineSetup: string;
    /** 必需段放不下时的紧凑世界线设定（只含计数与 key）。 */
    worldlineSetupCompact?: string;
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

/**
 * 确定性分段上下文组装器（纯函数）。
 *
 * 固定顺序：worldline_setup → canon_events → path_summary → canon_evidence
 * → recent_scenes → selected_direction → anchor_reminder。
 * 所有段都渲染为稳定的 XML 风格标签。
 *
 * 超预算时的顺序：
 * 1. 必需段放不下：先用 compact worldlineSetup 替换完整 currentState；
 *    仍放不下则 fail closed；
 * 2. canon_evidence 按 priority 从低到高、同优先级从末尾整条丢弃；
 * 3. recent_scenes 从最旧开始整条丢弃，但始终保留最新一个场景；
 * 4. path_summary 按整行从开头裁剪（首行省略提示保留到最后一刻）；
 * 5. 最新场景仍放不下时，用它自己的 summary 替换正文，记入 droppedItemIds；
 * 6. 仍超过预算则 fail closed，不返回半成品。
 *
 * worldline_setup、canon_events、selected_direction、anchor_reminder
 * 永不裁剪（worldline_setup 只允许整体替换为更紧凑的等价形式）。
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
  if (renderMandatoryPrompt(live).length > maxChars) {
    const compact = input.sections.worldlineSetupCompact?.trim() ?? "";
    if (compact.length > 0 && compact.length < live.worldlineSetup.length) {
      live.worldlineSetup = compact;
      worldlineSetupTrimmed = true;
    }
  }
  const mandatoryPrompt = renderMandatoryPrompt(live);
  if (mandatoryPrompt.length > maxChars) {
    throw new Error(
      `必需上下文段超过预算：需要 ${mandatoryPrompt.length} 字符，maxChars=${maxChars}`,
    );
  }

  let evidenceTrimmed = false;
  let scenesTrimmed = false;
  let pathTrimmed = false;
  const droppedEvidenceIds: string[] = [];
  const droppedSceneIds: string[] = [];

  const pathLines = splitLines(live.pathSummary);
  const pathLineSceneIds = mapPathSummaryLineSceneIds(
    pathLines,
    live.pathSummaryCoveredSceneIds,
  );

  let prompt = renderPrompt(live);

  // 1. 原著证据：低优先级先丢，同优先级从末尾整条丢弃。
  while (live.canonEvidence.length > 0 && prompt.length > maxChars) {
    const index = lowestPriorityLastIndex(live.canonEvidence);
    const dropped = live.canonEvidence.splice(index, 1)[0]!;
    droppedEvidenceIds.push(dropped.id);
    evidenceTrimmed = true;
    prompt = renderPrompt(live);
  }

  // 2. 最近场景：从最旧开始整条丢弃，最新一个永远保留。
  while (live.recentScenes.length > 1 && prompt.length > maxChars) {
    const dropped = live.recentScenes.shift()!;
    droppedSceneIds.push(dropped.id);
    scenesTrimmed = true;
    prompt = renderPrompt(live);
  }

  // 3. 路径摘要：按整行从开头裁剪，不切断任何一行；首行省略提示最后才丢。
  while (prompt.length > maxChars && pathLines.length > 0) {
    const dropIndex =
      pathLines.length > 1 && isOmissionLine(pathLines[0]!) ? 1 : 0;
    pathLines.splice(dropIndex, 1);
    pathLineSceneIds.splice(dropIndex, 1);
    live.pathSummary = pathLines.join("\n");
    pathTrimmed = true;
    prompt = renderPrompt(live);
  }

  // 4. 最新场景仍放不下：用摘要替换正文，并记录被替换的条目 id。
  if (prompt.length > maxChars && live.recentScenes.length > 0) {
    const index = live.recentScenes.length - 1;
    const newest = live.recentScenes[index]!;
    const summary = newest.summary;
    if (summary.length > 0 && summary !== newest.text) {
      live.recentScenes[index] = { ...newest, text: summary };
      droppedSceneIds.push(newest.id);
      scenesTrimmed = true;
      prompt = renderPrompt(live);
    }
  }

  // 最新场景与必需段仍然放不下时 fail closed，不偷偷丢掉最新场景。
  if (prompt.length > maxChars) {
    throw new Error(
      `必需上下文段与最新场景超过预算：需要 ${prompt.length} 字符，maxChars=${maxChars}`,
    );
  }

  const manifest = buildManifest({
    maxChars,
    prompt,
    live,
    pathLineSceneIds,
    worldlineSetupTrimmed,
    evidenceTrimmed,
    scenesTrimmed,
    pathTrimmed,
    droppedEvidenceIds,
    droppedSceneIds,
  });

  return { prompt, manifest };
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
    .map((item) => {
      const priority = item.priority ?? 0;
      if (!Number.isInteger(priority)) {
        throw new Error(`证据优先级必须是整数：${item.id}`);
      }
      return {
        id: item.id,
        text: item.text.trim(),
        priority,
        summary: "",
      };
    })
    .filter((item) => item.text.length > 0);
}

function normalizeScenes(items: readonly ContextSceneItem[]): NormalizedItem[] {
  return items
    .map((item) => ({
      id: item.id,
      text: item.text.trim(),
      priority: 0,
      summary: item.summary?.trim() ?? "",
    }))
    .filter((item) => item.text.length > 0);
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
 * 首行可能是 `更早剧情（第 a–b 幕）：...`，它覆盖前 b 个场景；
 * 其余行与剩余场景一一对应。无法安全对齐时不猜测，返回空映射。
 */
function mapPathSummaryLineSceneIds(
  lines: readonly string[],
  coveredSceneIds: readonly string[],
): string[][] {
  if (lines.length === 0) return [];
  if (coveredSceneIds.length === 0) return lines.map(() => []);

  const marker = /^更早剧情（第 \d+–(\d+) 幕）：/u.exec(lines[0] ?? "");
  if (marker) {
    const compressed = Number(marker[1]);
    const remaining = coveredSceneIds.length - compressed;
    if (
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
  evidenceTrimmed: boolean;
  scenesTrimmed: boolean;
  pathTrimmed: boolean;
  droppedEvidenceIds: string[];
  droppedSceneIds: string[];
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

function section(
  kind: ContextManifestSectionKind,
  included: boolean,
  chars: number,
  trimmed: boolean,
  droppedItemIds: string[],
  coverage?: {
    coveredItemIds: string[];
    watermarkId: string | null;
  },
): ContextManifestSection {
  return {
    kind,
    included,
    chars,
    trimmed,
    droppedItemIds,
    ...(coverage ?? {}),
  };
}
