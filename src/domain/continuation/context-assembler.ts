import {
  ContextManifestSchema,
  type ContextManifest,
  type ContextManifestSection,
  type ContextManifestSectionKind,
} from "@/domain/schemas";

/** 素材段在 Prompt 中的固定顺序，同时也是 manifest 的顺序。 */
export const CONTEXT_SECTION_ORDER: readonly ContextManifestSectionKind[] = [
  "worldline_setup",
  "path_summary",
  "canon_evidence",
  "recent_scenes",
  "selected_direction",
  "anchor_reminder",
];

/**
 * 原著证据条目由调用方提供。
 *
 * 证据如何选取仍由 `selectContinuationContext` 单独负责；组装器只负责
 * 排序、渲染和按预算裁剪，不复制窗口/人物证据的选择逻辑。
 */
export type ContextEvidenceItem = {
  id: string;
  text: string;
};

export type ContextSceneItem = {
  id: string;
  text: string;
};

export type ContextAssemblerInput = {
  maxChars: number;
  sections: {
    worldlineSetup: string;
    pathSummary: string;
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
};

type LiveSections = {
  worldlineSetup: string;
  pathSummary: string;
  canonEvidence: NormalizedItem[];
  recentScenes: NormalizedItem[];
  selectedDirection: string;
  anchorReminder: string;
};

/**
 * 确定性分段上下文组装器（纯函数）。
 *
 * 固定顺序：worldline_setup → path_summary → canon_evidence → recent_scenes
 * → selected_direction → anchor_reminder。所有段都渲染为稳定的 XML 风格标签。
 *
 * 超预算时按优先级从低到高裁剪：
 * 1. canon_evidence 从末尾（最不相关）整条丢弃；
 * 2. recent_scenes 从最旧开始整条丢弃，但始终保留最新一个场景；
 * 3. path_summary 从开头截断。
 *
 * worldline_setup、selected_direction、anchor_reminder 永不裁剪；
 * 它们（或它们加最新场景）本身超过预算时 fail closed，不返回半成品。
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
    pathSummary: input.sections.pathSummary.trim(),
    canonEvidence: normalizeItems(input.sections.canonEvidence),
    recentScenes: normalizeItems(input.sections.recentScenes),
    selectedDirection: input.sections.selectedDirection.trim(),
    anchorReminder: input.sections.anchorReminder.trim(),
  };

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

  let prompt = renderPrompt(live);

  // 1. 原著证据：从末尾开始整条丢弃。
  while (live.canonEvidence.length > 0 && prompt.length > maxChars) {
    const dropped = live.canonEvidence.pop()!;
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

  // 3. 路径摘要：从开头截断，保留最新的尾部。
  if (prompt.length > maxChars && live.pathSummary.length > 0) {
    const excess = prompt.length - maxChars;
    const keepChars = live.pathSummary.length - excess;
    if (keepChars <= 0) {
      live.pathSummary = "";
    } else {
      live.pathSummary = safeTail(live.pathSummary, keepChars);
    }
    pathTrimmed = true;
    prompt = renderPrompt(live);
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
    pathSummary: "",
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

function normalizeItems(
  items: readonly ContextEvidenceItem[],
): NormalizedItem[] {
  return items
    .map((item) => ({ id: item.id, text: item.text.trim() }))
    .filter((item) => item.text.length > 0);
}

/** 按 UTF-16 字符数取尾部；不从一个代理对的低位切起。 */
function safeTail(text: string, keepChars: number): string {
  if (keepChars >= text.length) return text;
  let start = text.length - keepChars;
  const codeUnit = text.charCodeAt(start);
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) start += 1;
  return text.slice(start);
}

function buildManifest(input: {
  maxChars: number;
  prompt: string;
  live: LiveSections;
  evidenceTrimmed: boolean;
  scenesTrimmed: boolean;
  pathTrimmed: boolean;
  droppedEvidenceIds: string[];
  droppedSceneIds: string[];
}): ContextManifest {
  const { live } = input;
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
): ContextManifestSection {
  return { kind, included, chars, trimmed, droppedItemIds };
}
