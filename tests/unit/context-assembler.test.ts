import { describe, expect, it } from "vitest";

import {
  assembleContext,
  CONTINUATION_CONTEXT_BUDGET_EXCEEDED_CODE,
  ContinuationContextBudgetError,
  CONTEXT_SECTION_ORDER,
  TRUNCATION_MARKER,
  type ContextAssemblerInput,
  type ContextAssemblerResult,
} from "@/domain/continuation/context-assembler";
import {
  ContextManifestSchema,
  type ContextManifestSectionKind,
} from "@/domain/schemas";

/** 全部为测试构造的短句，不是任何作品原文。 */
const sections: ContextAssemblerInput["sections"] = {
  worldlineSetup: "许澄没有交出红色账簿，故事自由发展。",
  canonEvents:
    '{"events":[{"id":"event_07","title":"许澄交出红账"}],"edges":[],"endingCandidates":[]}',
  pathSummary:
    "第 1 幕：钟楼初见——许澄在钟楼遇到沈砚。\n第 2 幕：雨夜相约——两人约定次日再见。",
  canonEvidence: [
    { id: "evidence_1", text: "许澄把账簿放回抽屉。" },
    { id: "evidence_2", text: "沈砚在门外等了很久。" },
    { id: "evidence_3", text: "顾闻舟提前抵达钟楼。" },
  ],
  recentScenes: [
    { id: "scene_1", text: "第一幕正文：钟楼里没有人。" },
    { id: "scene_2", text: "第二幕正文：雨声盖住了脚步。" },
    { id: "scene_3", text: "第三幕正文：沈砚推门而入。" },
  ],
  selectedDirection: "让沈砚在雨夜说出真相。",
  anchorReminder: "请保留顾闻舟在钟楼出现的结局。",
};

function assemble(maxChars: number): ContextAssemblerResult {
  return assembleContext({ maxChars, sections });
}

function sectionOf(
  result: ContextAssemblerResult,
  kind: ContextManifestSectionKind,
) {
  const found = result.manifest.sections.find((section) => section.kind === kind);
  if (!found) throw new Error(`manifest 缺少段：${kind}`);
  return found;
}

function tryAssemble(
  maxChars: number,
  input: ContextAssemblerInput["sections"],
): ContextAssemblerResult | null {
  try {
    return assembleContext({ maxChars, sections: input });
  } catch {
    return null;
  }
}

/** 只保留最新 v1 场景正文，并按“可用正文字符数”触发句末截断。 */
function truncateProse(
  prose: string,
  available: number,
): ContextAssemblerResult {
  const proseSections: ContextAssemblerInput["sections"] = {
    ...sections,
    worldlineSetup: "设定。",
    canonEvents: "",
    pathSummary: "",
    canonEvidence: [],
    recentScenes: [{ id: "legacy_scene", text: prose }],
    selectedDirection: "",
    anchorReminder: "",
  };
  const full = assembleContext({ maxChars: 100_000, sections: proseSections });
  return assembleContext({
    maxChars:
      available +
      full.prompt.length -
      prose.length +
      TRUNCATION_MARKER.length,
    sections: proseSections,
  });
}

/** 从渲染后的 Prompt 中按稳定标签取出某一段正文；缺失时返回 null。 */
function renderedSection(
  prompt: string,
  kind: ContextManifestSectionKind,
): string | null {
  const opening = `<${kind}>\n`;
  const start = prompt.indexOf(opening);
  if (start < 0) return null;
  const bodyStart = start + opening.length;
  const end = prompt.indexOf(`\n</${kind}>`, bodyStart);
  return end < 0 ? null : prompt.slice(bodyStart, end);
}

/** 解析 path_summary 的整行；段缺失时返回空数组。 */
function renderedLines(
  prompt: string,
  kind: ContextManifestSectionKind,
): string[] {
  const body = renderedSection(prompt, kind);
  return body === null || body.length === 0 ? [] : body.split("\n");
}

/** 解析 canon_evidence / recent_scenes 的条目；段缺失时返回空数组。 */
function renderedItems(
  prompt: string,
  kind: ContextManifestSectionKind,
): string[] {
  const body = renderedSection(prompt, kind);
  return body === null || body.length === 0 ? [] : body.split("\n\n");
}

function isMarkerOnlyText(text: string): boolean {
  return text.split(TRUNCATION_MARKER).join("").trim().length === 0;
}

function isPathOmissionLine(line: string): boolean {
  return line.startsWith("更早剧情（第 ") || line.startsWith("（更早的 ");
}

function isSuffix<T>(previous: readonly T[], next: readonly T[]): boolean {
  if (previous.length > next.length) return false;
  const offset = next.length - previous.length;
  return previous.every((item, index) => item === next[offset + index]);
}

describe("assembleContext", () => {
  it("renders the fixed section order with stable tags", () => {
    const result = assembleContext({
      maxChars: 10_000,
      sections: {
        ...sections,
        settingDeltas: [
          {
            id: "delta_root",
            text: "- 旧灯塔（自分歧点起）：旧灯塔已被封锁。",
            anchorDepth: 0,
            createdAt: "2026-08-11T00:00:00.000Z",
          },
        ],
      },
    });

    const positions = CONTEXT_SECTION_ORDER.map((kind) =>
      result.prompt.indexOf(`<${kind}>`),
    );
    for (const [index, position] of positions.entries()) {
      expect(position).toBeGreaterThanOrEqual(0);
      if (index > 0) expect(position).toBeGreaterThan(positions[index - 1]!);
    }
    expect(result.prompt.startsWith("<worldline_setup>")).toBe(true);
    expect(result.prompt.indexOf("<canon_events>")).toBeLessThan(
      result.prompt.indexOf("<setting_deltas>"),
    );
    expect(result.prompt.indexOf("<setting_deltas>")).toBeLessThan(
      result.prompt.indexOf("<path_summary>"),
    );
    expect(result.prompt.endsWith("</anchor_reminder>")).toBe(true);
    expect(result.manifest.sections.map((section) => section.kind)).toEqual(
      CONTEXT_SECTION_ORDER,
    );
    for (const section of result.manifest.sections) {
      expect(section).toMatchObject({ included: true, trimmed: false });
      expect(section.chars).toBeGreaterThan(0);
      expect(section.droppedItemIds).toEqual([]);
    }
  });

  it("reports a budget whose total equals the prompt length and a rounded percentage", () => {
    const result = assemble(10_000);

    expect(result.manifest.budget.maxChars).toBe(10_000);
    expect(result.manifest.budget.totalChars).toBe(result.prompt.length);
    expect(result.manifest.budget.percentageUsed).toBe(
      Math.round((result.prompt.length / 10_000) * 1000) / 10,
    );
    expect(ContextManifestSchema.safeParse(result.manifest).success).toBe(true);
  });

  it("omits empty sections", () => {
    const result = assembleContext({
      maxChars: 100,
      sections: {
        worldlineSetup: "   ",
        canonEvents: "",
        pathSummary: "",
        canonEvidence: [{ id: "evidence_blank", text: "  " }],
        recentScenes: [],
        selectedDirection: "",
        anchorReminder: "",
      },
    });

    expect(result.prompt).toBe("");
    expect(result.manifest.sections.every((section) => !section.included)).toBe(
      true,
    );
    expect(
      result.manifest.sections.every(
        (section) => section.chars === 0 && section.droppedItemIds.length === 0,
      ),
    ).toBe(true);
  });

  it("drops canon evidence from the end before touching recent scenes", () => {
    const result = assemble(500);

    const canon = sectionOf(result, "canon_evidence");
    expect(canon).toMatchObject({ included: true, trimmed: true });
    expect(canon.droppedItemIds).toEqual(["evidence_3"]);
    expect(result.prompt).not.toContain("顾闻舟提前抵达钟楼");
    expect(result.prompt).toContain("许澄把账簿放回抽屉");
    expect(result.prompt).toContain("沈砚在门外等了很久");

    const scenes = sectionOf(result, "recent_scenes");
    expect(scenes).toMatchObject({ included: true, trimmed: false });
    expect(result.prompt).toContain("第一幕正文：钟楼里没有人");
  });

  it("drops lower-priority evidence first and within a priority from the end", () => {
    const result = assembleContext({
      maxChars: 480,
      sections: {
        ...sections,
        canonEvidence: [
          { id: "related_1", text: "相关证据一", priority: 2 },
          { id: "related_2", text: "相关证据二", priority: 2 },
          { id: "style_1", text: "代表片段", priority: 1 },
          { id: "character_1", text: "人物证据", priority: 1 },
        ],
      },
    });

    const canon = sectionOf(result, "canon_evidence");
    expect(canon.droppedItemIds).toEqual([
      "character_1",
      "style_1",
      "related_2",
    ]);
    expect(result.prompt).toContain("相关证据一");
    expect(result.prompt).not.toContain("相关证据二");
    expect(result.prompt).not.toContain("代表片段");
    expect(result.prompt).not.toContain("人物证据");
  });

  it("drops the oldest recent scenes but always keeps the newest one", () => {
    const result = assemble(420);

    const canon = sectionOf(result, "canon_evidence");
    expect(canon).toMatchObject({ included: false, trimmed: true });
    expect(canon.droppedItemIds).toEqual([
      "evidence_3",
      "evidence_2",
      "evidence_1",
    ]);

    const scenes = sectionOf(result, "recent_scenes");
    expect(scenes).toMatchObject({ included: true, trimmed: true });
    expect(scenes.droppedItemIds).toEqual(["scene_1"]);
    expect(result.prompt).not.toContain("第一幕正文：钟楼里没有人");
    expect(result.prompt).toContain("第二幕正文：雨声盖住了脚步");
    expect(result.prompt).toContain("第三幕正文：沈砚推门而入");
  });

  it("trims path_summary by whole lines from the start and keeps the omission line", () => {
    const pathLines = [
      "更早剧情（第 1–2 幕）：钟楼初见；雨夜相约",
      "第 3 幕：账簿转移——许澄把账簿交给沈砚。",
      "第 4 幕：门外脚步——顾闻舟来到钟楼。",
    ];
    const result = assembleContext({
      maxChars: 420,
      sections: {
        ...sections,
        canonEvidence: [],
        pathSummary: pathLines.join("\n"),
        pathSummaryCoveredSceneIds: ["s1", "s2", "s3", "s4"],
      },
    });

    const path = sectionOf(result, "path_summary");
    expect(path).toMatchObject({ included: true, trimmed: true });
    expect(path.coveredItemIds).toEqual(["s1", "s2", "s4"]);
    expect(path.watermarkId).toBe("s4");
    expect(result.prompt).toContain(pathLines[0]);
    expect(result.prompt).not.toContain(pathLines[1]);
    expect(result.prompt).toContain(pathLines[2]);
    // 不允许把某一行切成半句。
    const rendered = result.prompt
      .split("<path_summary>\n")[1]!
      .split("\n</path_summary>")[0]!;
    for (const line of rendered.split("\n")) {
      expect(pathLines).toContain(line);
    }
  });

  it("aligns a compressed path line with only the scenes it actually shows", () => {
    const result = assembleContext({
      maxChars: 10_000,
      sections: {
        ...sections,
        canonEvidence: [],
        pathSummary:
          "更早剧情（第 2–3 幕）：乙；丙\n第 4 幕：丁——丁的摘要。",
        pathSummaryCoveredSceneIds: ["p2", "p3", "p4"],
        recentScenes: [{ id: "scene_latest", text: "最新场景正文。" }],
      },
    });

    const path = sectionOf(result, "path_summary");
    // 压缩行第 2–3 幕覆盖两个场景，第二行是第 4 幕；被丢弃的更早场景不在覆盖中。
    expect(path.coveredItemIds).toEqual(["p2", "p3", "p4"]);
    expect(path.watermarkId).toBe("p4");
  });

  it("omits the path summary when no whole line fits and clears coverage", () => {
    const result = assembleContext({
      maxChars: 380,
      sections: {
        ...sections,
        canonEvidence: [],
        pathSummary:
          "更早剧情（第 1–2 幕）：钟楼初见；雨夜相约\n第 3 幕：账簿转移——许澄把账簿交给沈砚。\n第 4 幕：门外脚步——顾闻舟来到钟楼。",
        pathSummaryCoveredSceneIds: ["s1", "s2", "s3", "s4"],
      },
    });

    expect(sectionOf(result, "path_summary")).toMatchObject({
      included: false,
      chars: 0,
      trimmed: true,
      coveredItemIds: [],
      watermarkId: null,
    });
    expect(result.prompt).not.toContain("<path_summary>");
    expect(result.prompt).toContain("第三幕正文：沈砚推门而入");
  });

  it("compacts worldline_setup when the mandatory sections overflow", () => {
    const fullSetup = `完整状态：${"事实正文".repeat(60)}`;
    const compactSetup =
      '{"currentState":{"factsAddedCount":1,"factsAddedKeys":["generated:x"]}}';
    const result = assembleContext({
      maxChars: 400,
      sections: {
        ...sections,
        worldlineSetup: fullSetup,
        worldlineSetupCompact: compactSetup,
        canonEvents: '{"events":[]}',
        pathSummary: "",
        canonEvidence: [],
        recentScenes: [
          {
            id: "s1",
            text: "最新场景正文。".repeat(15),
            summary: "最新场景摘要。",
          },
        ],
        selectedDirection: "方向。",
        anchorReminder: "提醒。",
      },
    });

    expect(sectionOf(result, "worldline_setup")).toMatchObject({
      included: true,
      trimmed: true,
    });
    expect(result.prompt).toContain(compactSetup);
    expect(result.prompt).not.toContain("事实正文");
  });

  it("uses compact worldline_setup before replacing the newest prose", () => {
    const fullSetup = `完整状态：${"事实正文".repeat(60)}`;
    const compactSetup =
      '{"currentState":{"factsAddedCount":1,"factsAddedKeys":["generated:x"]}}';
    const newest = {
      id: "s1",
      text: "最新场景正文。".repeat(15),
      summary: "最新场景摘要。",
    };
    const probeSections: ContextAssemblerInput["sections"] = {
      ...sections,
      worldlineSetup: fullSetup,
      canonEvents: '{"events":[]}',
      pathSummary: "",
      canonEvidence: [],
      recentScenes: [newest],
      selectedDirection: "方向。",
      anchorReminder: "提醒。",
    };

    const fullState = assembleContext({
      maxChars: 100_000,
      sections: probeSections,
    });
    const compactState = assembleContext({
      maxChars: 100_000,
      sections: { ...probeSections, worldlineSetup: compactSetup },
    });
    // 取一个介于“完整状态”和“紧凑状态”之间的预算：
    // 完整 worldline_setup 放不下，但紧凑形式能保住最新场景正文。
    const budget = Math.floor(
      (fullState.prompt.length + compactState.prompt.length) / 2,
    );
    expect(fullState.prompt.length).toBeGreaterThan(budget);
    expect(compactState.prompt.length).toBeLessThanOrEqual(budget);

    const result = assembleContext({
      maxChars: budget,
      sections: {
        ...probeSections,
        worldlineSetupCompact: compactSetup,
        worldlineSetupCompactRemoved: [
          "currentState.factsAdded[].statement",
        ],
      },
    });

    const setup = sectionOf(result, "worldline_setup");
    expect(setup).toMatchObject({ included: true, trimmed: true });
    expect(setup.compactedFields).toEqual([
      "currentState.factsAdded[].statement",
    ]);
    expect(result.prompt).toContain(compactSetup);
    expect(result.prompt).not.toContain("事实正文");

    const scenes = sectionOf(result, "recent_scenes");
    expect(scenes).toMatchObject({
      included: true,
      trimmed: false,
      droppedItemIds: [],
    });
    expect(scenes.summarizedItemIds ?? []).toEqual([]);
    expect(scenes.truncatedItemIds ?? []).toEqual([]);
    expect(result.prompt).toContain(newest.text);
    expect(result.prompt).not.toContain(newest.summary);
  });

  it("replaces the newest scene with its summary before failing closed", () => {
    const newest = {
      id: "s1",
      text: "最新场景正文。".repeat(15),
      summary: "最新场景摘要。",
    };
    const baseSections: ContextAssemblerInput["sections"] = {
      ...sections,
      worldlineSetup: `完整状态：${"事实正文".repeat(60)}`,
      canonEvents: '{"events":[]}',
      pathSummary: "",
      canonEvidence: [],
      recentScenes: [newest],
      selectedDirection: "方向。",
      anchorReminder: "提醒。",
    };

    const result = assembleContext({ maxChars: 500, sections: baseSections });
    expect(sectionOf(result, "recent_scenes")).toMatchObject({
      included: true,
      trimmed: true,
      droppedItemIds: [],
      summarizedItemIds: ["s1"],
    });
    expect(result.prompt).toContain(newest.summary);
    expect(result.prompt).not.toContain(newest.text);

    expect(() =>
      assembleContext({
        maxChars: 450,
        sections: {
          ...baseSections,
          recentScenes: [{ id: "s1", text: newest.text }],
        },
      }),
    ).toThrow("必需上下文段与最新场景超过预算");
  });

  it("truncates legacy prose without a summary at a sentence boundary", () => {
    const prose = "第一句。第二句。第三句。第四句。";
    const baseSections: ContextAssemblerInput["sections"] = {
      ...sections,
      worldlineSetup: "设定。",
      canonEvents: "",
      pathSummary: "",
      canonEvidence: [],
      recentScenes: [{ id: "legacy_scene", text: prose }],
      selectedDirection: "",
      anchorReminder: "",
    };
    const full = assembleContext({ maxChars: 100_000, sections: baseSections });
    // 只比完整长度小 3 个字符：必须截断，但第一句加标记仍然放得下。
    const result = assembleContext({
      maxChars: full.prompt.length - 3,
      sections: baseSections,
    });

    expect(result.prompt).toContain("第一句。（后文已截断）");
    expect(result.prompt).not.toContain("第二句");
    const scenes = sectionOf(result, "recent_scenes");
    expect(scenes).toMatchObject({
      included: true,
      trimmed: true,
      droppedItemIds: [],
      truncatedItemIds: ["legacy_scene"],
    });
    expect(scenes.summarizedItemIds ?? []).toEqual([]);
    expect(result.prompt.length).toBeLessThanOrEqual(full.prompt.length - 3);
  });

  it("returns the first fitting ladder state instead of backfilling evidence", () => {
    const newest = { id: "scene_latest", text: "长正文。".repeat(40) };
    const baseSections: ContextAssemblerInput["sections"] = {
      ...sections,
      worldlineSetup: `完整设定：${"事实正文".repeat(40)}`,
      worldlineSetupCompact:
        '{"currentState":{"factsAddedCount":1,"factsAddedKeys":["generated:x"]}}',
      canonEvents: "",
      pathSummary: "",
      canonEvidence: [
        { id: "related_high", text: "高优先级证据。", priority: 3 },
        { id: "style_low", text: "低优先级证据。", priority: 1 },
      ],
      recentScenes: [
        { id: "scene_old", text: "旧正文。".repeat(40) },
        newest,
      ],
      selectedDirection: "",
      anchorReminder: "",
    };
    const withoutEvidence = assembleContext({
      maxChars: 100_000,
      sections: { ...baseSections, canonEvidence: [] },
    });
    const withoutEvidenceOneScene = assembleContext({
      maxChars: 100_000,
      sections: {
        ...baseSections,
        canonEvidence: [],
        recentScenes: [newest],
      },
    });
    // 比“无证据且保留两幕”短一个字符：必须先丢证据、再丢最旧场景才放得下。
    // 紧凑设定虽然还有空间，但它属于更靠后的阶梯状态，不得回填证据。
    const budget = withoutEvidence.prompt.length - 1;
    expect(budget).toBeGreaterThanOrEqual(
      withoutEvidenceOneScene.prompt.length,
    );

    const result = assembleContext({ maxChars: budget, sections: baseSections });

    expect(sectionOf(result, "worldline_setup")).toMatchObject({
      included: true,
      trimmed: false,
    });
    expect(sectionOf(result, "canon_evidence")).toMatchObject({
      included: false,
      droppedItemIds: ["style_low", "related_high"],
    });
    expect(sectionOf(result, "canon_evidence").backfilledItemIds).toBeUndefined();
    expect(sectionOf(result, "recent_scenes").droppedItemIds).toEqual([
      "scene_old",
    ]);
    expect(result.prompt).toContain(newest.text);
    expect(result.prompt).not.toContain("factsAddedKeys");
    expect(result.prompt).not.toContain("高优先级证据");
    expect(result.prompt).not.toContain("低优先级证据");
  });

  it("parses legacy backfilledItemIds but new manifests never write them", () => {
    const legacyManifest = {
      budget: { totalChars: 10, maxChars: 100, percentageUsed: 10 },
      sections: [
        {
          kind: "canon_evidence",
          included: true,
          chars: 10,
          trimmed: true,
          droppedItemIds: [],
          backfilledItemIds: ["evidence_1"],
        },
      ],
    };
    expect(ContextManifestSchema.safeParse(legacyManifest).success).toBe(true);

    const result = assemble(420);
    expect(
      sectionOf(result, "canon_evidence").backfilledItemIds,
    ).toBeUndefined();
  });

  it("does not cut inside an open quotation", () => {
    const prose =
      "第一句。他说：「第二句。」第三句。后面还有很长的一段叙述，足够触发截断。";
    const result = truncateProse(prose, prose.indexOf("。」") + 1);

    expect(result.prompt).toContain("第一句。（后文已截断）");
    expect(result.prompt).not.toContain("第二句");
    expect(sectionOf(result, "recent_scenes").truncatedItemIds).toEqual([
      "legacy_scene",
    ]);
  });

  it("treats ASCII quotes as quotation boundaries", () => {
    const prose =
      '开场。他说"别走。"然后离开。后面还有很长的一段叙述，足够触发截断。';
    const result = truncateProse(prose, prose.indexOf('。"') + 1);

    expect(result.prompt).toContain("开场。（后文已截断）");
    expect(result.prompt).not.toContain("别走");
  });

  it("does not treat an ASCII apostrophe as an open quotation", () => {
    const prose =
      "开场写着 don't panic。随后又是一句。后面还有很长的一段叙述，足够触发截断。";
    const result = truncateProse(prose, prose.indexOf("随后又是一句。") + "随后又是一句。".length);

    expect(result.prompt).toContain("随后又是一句。（后文已截断）");
  });

  it("cuts before the opening quote when only quoted sentence ends fit", () => {
    const prose =
      "他压低声音说：「别走。」然后转身。后面还有很长的一段叙述，足够触发截断。";
    const insideQuote = truncateProse(prose, prose.indexOf("。」") + 1);
    const afterClosingQuote = truncateProse(prose, prose.indexOf("」") + 1);

    expect(insideQuote.prompt).toContain("他压低声音说：（后文已截断）");
    expect(afterClosingQuote.prompt).toContain(
      "他压低声音说：「别走。」（后文已截断）",
    );
    expect(insideQuote.prompt).not.toContain("别走");
    expect(afterClosingQuote.prompt).not.toContain("然后转身");
  });

  it("fails closed for every budget when the whole v1 scene is inside a quotation", () => {
    const proseVariants = [
      // 最外层开引号就在正文开头，且正文始终没有闭合引号。
      "「没有人来过这里。",
      "「没有人来过这里",
      "“只有这一句。",
      "“只有这一句",
      "『风从门缝里进来。",
      "『风从门缝里进来",
      '"门没有锁。',
      '"门没有锁',
    ];

    for (const [variantIndex, prose] of proseVariants.entries()) {
      for (const withOtherSections of [false, true]) {
        const sceneId = `legacy_scene_${variantIndex}`;
        const baseSections: ContextAssemblerInput["sections"] = withOtherSections
          ? {
              ...sections,
              recentScenes: [
                { id: `older_scene_${variantIndex}`, text: "更早的一幕正文。" },
                { id: sceneId, text: prose },
              ],
            }
          : {
              worldlineSetup: "设定。",
              canonEvents: "",
              pathSummary: "",
              canonEvidence: [],
              recentScenes: [{ id: sceneId, text: prose }],
              selectedDirection: "",
              anchorReminder: "",
            };
        const full = assembleContext({ maxChars: 1_000_000, sections: baseSections });

        for (let budget = 1; budget <= full.prompt.length; budget += 1) {
          let result: ContextAssemblerResult | null = null;
          try {
            result = assembleContext({ maxChars: budget, sections: baseSections });
          } catch (error) {
            // 只有 fail closed 是允许的失败；不能把其它异常当成预期结果。
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toMatch(
              /必需上下文段(?:与最新场景)?超过预算/,
            );
            continue;
          }

          const assembled = result as ContextAssemblerResult;
          expect(assembled.prompt.length).toBeLessThanOrEqual(budget);
          // 预算足够时必须保留完整正文，不能替换成截断标记。
          expect(assembled.prompt).toContain(prose);
          expect(
            sectionOf(assembled, "recent_scenes").truncatedItemIds ?? [],
          ).not.toContain(sceneId);

          const sceneBodies = renderedItems(assembled.prompt, "recent_scenes");
          expect(sceneBodies[sceneBodies.length - 1]).toBe(prose);
          for (const body of sceneBodies) {
            expect(isMarkerOnlyText(body)).toBe(false);
          }
        }
      }
    }
  });

  it("cuts after closing quotes that follow a sentence terminator", () => {
    const suffix = "后面还有很长的一段叙述，足够触发截断。";
    const cases = [
      { prose: `他说：“走吧。”然后离开。${suffix}`, end: "”", tail: "然后离开" },
      { prose: `他喊道：「快走！」然后转身。${suffix}`, end: "」", tail: "然后转身" },
      { prose: `她问：「真的吗？」随后沉默。${suffix}`, end: "」", tail: "随后沉默" },
      { prose: `他说：「等等……」然后停下。${suffix}`, end: "」", tail: "然后停下" },
      {
        prose: `他说：「她低声说：『走吧。』」然后离开。${suffix}`,
        end: "』」",
        tail: "然后离开",
      },
    ];
    for (const { prose, end, tail } of cases) {
      const prefix = prose.slice(0, prose.indexOf(end) + end.length);
      const result = truncateProse(prose, prefix.length);

      expect(result.prompt).toContain(`${prefix}${TRUNCATION_MARKER}`);
      expect(result.prompt).not.toContain(tail);
      expect(sectionOf(result, "recent_scenes").truncatedItemIds).toEqual([
        "legacy_scene",
      ]);
    }
  });

  it("never splits an ellipsis pair at the truncation boundary", () => {
    const prose =
      "第一句。他停顿……然后离开。后面还有很长的一段叙述，足够触发截断。";
    const firstEllipsis = prose.indexOf("…");
    const halfPair = truncateProse(prose, firstEllipsis + 1);
    const wholePair = truncateProse(prose, firstEllipsis + 2);

    expect(halfPair.prompt).toContain("第一句。（后文已截断）");
    expect(halfPair.prompt).not.toContain("停顿");
    expect(wholePair.prompt).toContain("第一句。他停顿……（后文已截断）");
  });

  it("fails closed when legacy prose has no sentence boundary to truncate", () => {
    const prose = "没有句号的遗言";
    const baseSections: ContextAssemblerInput["sections"] = {
      ...sections,
      worldlineSetup: "设定。",
      canonEvents: "",
      pathSummary: "",
      canonEvidence: [],
      recentScenes: [{ id: "legacy_scene", text: prose }],
      selectedDirection: "",
      anchorReminder: "",
    };
    const full = assembleContext({ maxChars: 100_000, sections: baseSections });

    expect(() =>
      assembleContext({
        maxChars: full.prompt.length - 1,
        sections: baseSections,
      }),
    ).toThrow(
      /必需上下文段与最新场景超过预算：需要 \d+ 字符，maxChars=\d+/,
    );
  });

  it("fails closed when the mandatory sections alone exceed the budget", () => {
    expect(() => assemble(150)).toThrow("必需上下文段超过预算");
  });

  it("throws a typed budget error carrying needed and max chars", () => {
    let thrown: unknown;
    try {
      assemble(100);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContinuationContextBudgetError);
    const budgetError = thrown as ContinuationContextBudgetError;
    expect(budgetError.code).toBe(
      CONTINUATION_CONTEXT_BUDGET_EXCEEDED_CODE,
    );
    expect(budgetError.maxChars).toBe(100);
    expect(budgetError.neededChars).toBeGreaterThan(100);
    expect(budgetError.message).toContain("必需上下文段超过预算");
  });

  it("fails closed instead of dropping the mandatory sections or the newest scene", () => {
    expect(() => assemble(320)).toThrow("必需上下文段与最新场景超过预算");
  });

  it("rejects an invalid budget", () => {
    expect(() => assemble(0)).toThrow("上下文预算必须是正整数");
    expect(() => assemble(1.5)).toThrow("上下文预算必须是正整数");
  });

  it("keeps every section out of the manifest text", () => {
    const result = assemble(420);
    const serialized = JSON.stringify(result.manifest);
    const allTexts = [
      sections.worldlineSetup,
      sections.canonEvents!,
      sections.pathSummary,
      sections.selectedDirection,
      sections.anchorReminder,
      ...sections.canonEvidence.map((item) => item.text),
      ...sections.recentScenes.map((item) => item.text),
    ];

    for (const text of allTexts) {
      expect(serialized).not.toContain(text);
    }
    // 只允许出现条目 id 与计数。
    expect(serialized).toContain("scene_1");
    expect(Object.keys(result.manifest).sort()).toEqual(["budget", "sections"]);
    const baseKeys = [
      "chars",
      "droppedItemIds",
      "included",
      "kind",
      "trimmed",
    ];
    for (const section of result.manifest.sections) {
      expect(Object.keys(section).sort()).toEqual(
        section.kind === "path_summary"
          ? [...baseKeys, "coveredItemIds", "watermarkId"].sort()
          : baseKeys,
      );
    }
  });

  it("is deterministic for the same input", () => {
    const first = assemble(420);
    const second = assemble(420);

    expect(second).toEqual(first);
    expect(second.prompt).toBe(first.prompt);
  });

  it("always respects the budget across several property-style budgets", () => {
    const budgets = [380, 400, 420, 440, 460, 480, 500, 600, 1_200];

    for (const budget of budgets) {
      const result = assemble(budget);

      expect(result.prompt.length).toBeLessThanOrEqual(budget);
      expect(result.manifest.budget.totalChars).toBe(result.prompt.length);
      expect(result.manifest.budget.maxChars).toBe(budget);
      expect(result.manifest.budget.percentageUsed).toBe(
        Math.round((result.prompt.length / budget) * 1000) / 10,
      );
      expect(result.manifest.sections.map((section) => section.kind)).toEqual(
        CONTEXT_SECTION_ORDER,
      );

      for (const kind of [
        "worldline_setup",
        "canon_events",
        "selected_direction",
        "anchor_reminder",
      ] as const) {
        expect(sectionOf(result, kind)).toMatchObject({
          included: true,
          trimmed: false,
        });
      }
      expect(sectionOf(result, "recent_scenes").included).toBe(true);
      expect(result.prompt).toContain(sections.recentScenes[2]!.text);

      for (const section of result.manifest.sections) {
        expect(section.chars).toBeGreaterThanOrEqual(0);
        if (!section.included) expect(section.chars).toBe(0);
      }
      expect(ContextManifestSchema.safeParse(result.manifest).success).toBe(
        true,
      );
    }
  });

  it("degrades monotonically as the budget grows", () => {
    const monotonicSections: ContextAssemblerInput["sections"] = {
      worldlineSetup: `完整世界线设定：${"事实正文".repeat(40)}`,
      worldlineSetupCompact:
        '{"currentState":{"factsAddedCount":2,"factsAddedKeys":["generated:a","generated:b"]}}',
      worldlineSetupCompactRemoved: [
        "currentState.factsAdded[].statement",
        "currentState.characterChanges[].summary",
      ],
      canonEvents:
        '{"events":[{"id":"event_01"},{"id":"event_02"}],"edges":[],"endingCandidates":[]}',
      pathSummary: [
        "更早剧情（第 1–3 幕）：甲；乙；丙",
        "第 4 幕：丁——丁的摘要。",
        "第 5 幕：戊——戊的摘要。",
      ].join("\n"),
      pathSummaryCoveredSceneIds: ["p1", "p2", "p3", "p4", "p5"],
      canonEvidence: [
        { id: "related_1", text: "相关证据一。", priority: 2 },
        { id: "related_2", text: "相关证据二。", priority: 2 },
        { id: "style_1", text: "代表片段。", priority: 1 },
        { id: "style_2", text: "人物证据。", priority: 1 },
        { id: "default_1", text: "默认证据。", priority: 0 },
      ],
      recentScenes: [
        {
          id: "scene_1",
          text: "第一幕正文。".repeat(6),
          summary: "第一幕摘要。",
        },
        {
          id: "scene_2",
          text: "第二幕正文。".repeat(6),
          summary: "第二幕摘要。",
        },
      ],
      selectedDirection: "让沈砚在雨夜说出真相。",
      anchorReminder: "请保留顾闻舟在钟楼出现的结局。",
    };
    const full = assembleContext({
      maxChars: 100_000,
      sections: monotonicSections,
    });

    // 一次成功之后，所有更大的预算都必须成功。
    let firstSuccess: number | null = null;
    for (let budget = 1; budget <= full.prompt.length + 50; budget += 1) {
      const result = tryAssemble(budget, monotonicSections);
      if (result) {
        firstSuccess ??= budget;
      } else {
        expect(firstSuccess).toBeNull();
      }
    }
    expect(firstSuccess).not.toBeNull();
    expect(() =>
      assembleContext({
        maxChars: firstSuccess! - 1,
        sections: monotonicSections,
      }),
    ).toThrow();

    const droppedIds = (result: ContextAssemblerResult, kind: "canon_evidence" | "recent_scenes") =>
      new Set(sectionOf(result, kind).droppedItemIds);
    const keptEvidence = (result: ContextAssemblerResult) => {
      const dropped = droppedIds(result, "canon_evidence");
      return monotonicSections.canonEvidence
        .map((item) => item.id)
        .filter((id) => !dropped.has(id));
    };
    const keptScenes = (result: ContextAssemblerResult) => {
      const dropped = droppedIds(result, "recent_scenes");
      return monotonicSections.recentScenes
        .map((item) => item.id)
        .filter((id) => !dropped.has(id));
    };
    const pathLineCount = (result: ContextAssemblerResult) => {
      const match = /<path_summary>\n([\s\S]*?)\n<\/path_summary>/.exec(
        result.prompt,
      );
      return match
        ? match[1]!.split("\n").filter((line) => line.length > 0).length
        : 0;
    };
    const compactUsed = (result: ContextAssemblerResult) =>
      sectionOf(result, "worldline_setup").trimmed;
    const summaryUsed = (result: ContextAssemblerResult) =>
      (sectionOf(result, "recent_scenes").summarizedItemIds ?? []).length > 0;
    const truncationUsed = (result: ContextAssemblerResult) =>
      (sectionOf(result, "recent_scenes").truncatedItemIds ?? []).length > 0;

    let previous: ContextAssemblerResult | null = null;
    let sawCompact = false;
    let sawSummary = false;
    for (
      let budget = firstSuccess!;
      budget <= full.prompt.length + 100;
      budget += 1
    ) {
      const result = tryAssemble(budget, monotonicSections);
      expect(result).not.toBeNull();
      if (!result) continue;
      sawCompact ||= compactUsed(result);
      sawSummary ||= summaryUsed(result);

      if (previous) {
        for (const id of keptEvidence(previous)) {
          expect(keptEvidence(result)).toContain(id);
        }
        for (const id of keptScenes(previous)) {
          expect(keptScenes(result)).toContain(id);
        }
        expect(pathLineCount(result)).toBeGreaterThanOrEqual(
          pathLineCount(previous),
        );
        if (!compactUsed(previous)) expect(compactUsed(result)).toBe(false);
        if (!summaryUsed(previous)) expect(summaryUsed(result)).toBe(false);
        if (!truncationUsed(previous)) {
          expect(truncationUsed(result)).toBe(false);
        }
        expect(result.prompt.length).toBeGreaterThanOrEqual(
          previous.prompt.length,
        );
      }
      previous = result;
    }
    // 扫描区间至少实际覆盖了紧凑设定与摘要替换两种降级。
    expect(sawCompact).toBe(true);
    expect(sawSummary).toBe(true);
  });

  it("keeps setting deltas in their own trimmable section, never in worldline_setup", () => {
    const settingSections: ContextAssemblerInput["sections"] = {
      worldlineSetup: `完整世界线设定：${"事实正文".repeat(40)}`,
      worldlineSetupCompact: `{"currentState":{"factsAddedCount":2}}`,
      worldlineSetupCompactRemoved: ["currentState.factsAdded[].statement"],
      canonEvents:
        '{"events":[{"id":"event_01"}],"edges":[],"endingCandidates":[]}',
      settingDeltas: [
        {
          id: "delta_root",
          text: "- 沈砚（自分歧点起）：沈砚从此左手受伤，不能划船。",
          anchorDepth: 0,
          createdAt: "2026-08-11T00:00:00.000Z",
        },
        {
          id: "delta_deep",
          text: "- 旧灯塔（自第 2 幕起）：旧灯塔已被封锁，不能进入。",
          anchorDepth: 2,
          createdAt: "2026-08-11T00:01:00.000Z",
        },
      ],
      pathSummary: "第 1 幕：丁——丁的摘要。\n第 2 幕：戊——戊的摘要。",
      pathSummaryCoveredSceneIds: ["p1", "p2"],
      canonEvidence: [
        { id: "related_1", text: "相关证据一。", priority: 2 },
        { id: "style_1", text: "代表片段。", priority: 1 },
      ],
      recentScenes: [
        { id: "scene_1", text: "第一幕正文。".repeat(6), summary: "第一幕摘要。" },
        { id: "scene_2", text: "第二幕正文。".repeat(6), summary: "第二幕摘要。" },
      ],
      selectedDirection: "让沈砚在雨夜说出真相。",
      anchorReminder: "请保留顾闻舟在钟楼出现的结局。",
    };
    const full = assembleContext({
      maxChars: 100_000,
      sections: settingSections,
    });

    // 规则只在独立段中，不进入永不裁剪的 worldline_setup。
    expect(renderedSection(full.prompt, "worldline_setup")).not.toContain(
      "settingDeltas",
    );
    expect(renderedSection(full.prompt, "worldline_setup")).not.toContain(
      "旧灯塔已被封锁",
    );
    expect(renderedSection(full.prompt, "setting_deltas")).toContain(
      "旧灯塔已被封锁，不能进入。",
    );

    let firstSuccess: number | null = null;
    for (let budget = 1; budget <= full.prompt.length + 20; budget += 1) {
      const result = tryAssemble(budget, settingSections);
      if (result) firstSuccess ??= budget;
      else expect(firstSuccess).toBeNull();
    }
    expect(firstSuccess).not.toBeNull();

    const keptSettingDeltas = (result: ContextAssemblerResult) => {
      const dropped = new Set(
        sectionOf(result, "setting_deltas").droppedItemIds,
      );
      return settingSections.settingDeltas!
        .map((item) => item.id)
        .filter((id) => !dropped.has(id));
    };

    let previous: ContextAssemblerResult | null = null;
    let sawSettingDeltaDrop = false;
    let sawShallowDroppedBeforeDeep = false;
    for (
      let budget = firstSuccess!;
      budget <= full.prompt.length + 40;
      budget += 1
    ) {
      const result = tryAssemble(budget, settingSections);
      expect(result).not.toBeNull();
      if (!result) continue;
      const kept = keptSettingDeltas(result);
      sawSettingDeltaDrop ||= kept.length < 2;
      // 更浅的分歧点规则先被丢弃，更深的场景规则保留更久。
      sawShallowDroppedBeforeDeep ||= !kept.includes("delta_root") &&
        kept.includes("delta_deep");
      if (previous) {
        // 更大预算只能保留相同或更多规则；不会重新丢弃更小预算已保留的规则。
        for (const id of keptSettingDeltas(previous)) {
          expect(keptSettingDeltas(result)).toContain(id);
        }
        expect(result.prompt.length).toBeGreaterThanOrEqual(
          previous.prompt.length,
        );
      }
      previous = result;
    }
    expect(sawSettingDeltaDrop).toBe(true);
    expect(sawShallowDroppedBeforeDeep).toBe(true);
  });

  it("never fails because of trimmable setting deltas when required sections alone fit", () => {
    const rules: NonNullable<ContextAssemblerInput["sections"]["settingDeltas"]> =
      Array.from({ length: 20 }, (_, index) => ({
        id: `delta_${String(index).padStart(2, "0")}`,
        text: `- 规则 ${index}（自分歧点起）：${"灯".repeat(200)}`,
        anchorDepth: index % 2,
        createdAt: `2026-08-11T00:${String(index).padStart(2, "0")}:00.000Z`,
      }));
    const requiredSections: ContextAssemblerInput["sections"] = {
      worldlineSetup: `必需世界线设定：${"事实正文".repeat(30)}`,
      canonEvents:
        '{"events":[{"id":"event_01"}],"edges":[],"endingCandidates":[]}',
      pathSummary: "",
      canonEvidence: [],
      recentScenes: [],
      selectedDirection: "让沈砚在雨夜说出真相。",
      anchorReminder: "请保留顾闻舟在钟楼出现的结局。",
    };
    const base = assembleContext({
      maxChars: 1_000_000,
      sections: { ...requiredSections, settingDeltas: [] },
    });

    // 预算恰好只够必需段：20 条长规则必须被全部丢弃，而不是让组装失败。
    const result = assembleContext({
      maxChars: base.prompt.length,
      sections: { ...requiredSections, settingDeltas: rules },
    });
    expect(result.prompt).toBe(base.prompt);
    expect(sectionOf(result, "setting_deltas")).toMatchObject({
      included: false,
      trimmed: true,
    });
    expect(
      new Set(sectionOf(result, "setting_deltas").droppedItemIds),
    ).toEqual(new Set(rules.map((rule) => rule.id)));

    // 默认 24000 预算下同样的 20 条规则可以正常组装（规则可能被部分裁剪）。
    expect(() =>
      assembleContext({
        maxChars: 24_000,
        sections: { ...requiredSections, settingDeltas: rules },
      }),
    ).not.toThrow();
  });

  it(
    "keeps the ladder monotonic for every budget across seeded random fixtures",
    { timeout: 30_000 },
    () => {
      /** 全部为测试构造的短句，不是任何作品原文。 */
      const shortSentences = [
        "许澄把账簿放回抽屉。",
        "沈砚在门外等了很久。",
        "顾闻舟提前抵达钟楼。",
        "雨声盖住了脚步。",
        "钟楼的门半开着。",
        "灯影在墙上摇晃……",
        "他把信折好放进衣袖。",
        "远处传来一声钟响。",
        "她没有再说话。",
        "桌角压着一张旧车票。",
      ];
      const longSentences = [
        "雨声沿着钟楼的石阶一层层落下来，盖住了门外所有来往的脚步与低语。",
        "沈砚把那封没有署名的信重新折好，放回衣袖最里面的夹层里。",
        "许澄沿着长廊走到尽头，发现那扇应当上锁的木门正虚掩着。",
        "顾闻舟在灯下翻了很久的旧账，才从纸页背面找到一行褪色的字。",
      ];
      const quotedSentences = [
        "他说：「走吧。」然后停下。",
        "她低声说：「别回头。」继续向前。",
        "「没有人来过这里。」他回答。",
        "她问：「真的吗？」随后沉默。",
        "他喊道：「快走！」转身离开。",
        "她说：「等等……」又改了口。",
        "他念道：『灯灭了。』",
        '他说"别走。"然后离开。',
        "她低声道：“门外有人。”随后熄了灯。",
      ];
      const openQuotedSentences = [
        "「没有人来过这里。",
        "「灯还亮着",
        "“只有这一句。",
        "“门外没有声音",
        "『风从门缝里进来。",
        "『风从门缝里进来",
        '"门没有锁。',
        '"门没有锁',
      ];

      const pick = (rng: () => number, pool: readonly string[]): string =>
        pool[Math.floor(rng() * pool.length)]!;
      const randomInt = (
        rng: () => number,
        min: number,
        max: number,
      ): number => min + Math.floor(rng() * (max - min + 1));
      const makeSentence = (rng: () => number): string => {
        const roll = rng();
        if (roll < 0.2) return pick(rng, longSentences);
        if (roll < 0.45) return pick(rng, quotedSentences);
        if (roll < 0.55) return pick(rng, openQuotedSentences);
        return pick(rng, shortSentences);
      };
      const makeText = (
        rng: () => number,
        minSentences: number,
        maxSentences: number,
      ): string =>
        Array.from(
          { length: randomInt(rng, minSentences, maxSentences) },
          () => makeSentence(rng),
        ).join("");

      type EvidenceSpec = {
        id: string;
        text: string;
        priority: number;
        index: number;
      };
      type SceneSpec = {
        id: string;
        text: string;
        summary?: string;
        index: number;
      };
      type Fixture = {
        sections: ContextAssemblerInput["sections"];
        evidence: readonly EvidenceSpec[];
        scenes: readonly SceneSpec[];
        pathLines: readonly string[];
      };

      const evidenceToken = (index: number): string => `〔E${index}〕`;
      const sceneToken = (index: number): string => `〔S${index}〕`;
      const summaryToken = (index: number): string => `〔M${index}〕`;

      const makeFixture = (rng: () => number): Fixture => {
        const compactMode = pick(rng, [
          "none",
          "shorter",
          "shorter",
          "equal",
          "longer",
        ]);
        let worldlineSetup = `世界线设定：${Array.from(
          { length: randomInt(rng, 1, 5) },
          () => makeSentence(rng),
        ).join("")}`;
        let worldlineSetupCompact: string | undefined;
        if (compactMode === "shorter") {
          worldlineSetupCompact = `{"currentState":{"factsAddedCount":${randomInt(
            rng,
            0,
            99,
          )}}}`;
          while (worldlineSetup.length <= worldlineSetupCompact.length) {
            worldlineSetup += pick(rng, longSentences);
          }
        } else if (compactMode === "equal") {
          // 等长但内容不同：阶梯第 5 步要求严格更短，因此不得启用。
          worldlineSetupCompact = `紧${worldlineSetup.slice(1)}`;
        } else if (compactMode === "longer") {
          worldlineSetupCompact = `${worldlineSetup}，这是更长的紧凑形式。`;
        }

        const evidenceCount = randomInt(rng, 0, 12);
        const evidence: EvidenceSpec[] = Array.from(
          { length: evidenceCount },
          (_, index) => ({
            id: `evidence_${index}`,
            text: `${evidenceToken(index)}${makeText(rng, 1, 2)}`,
            priority: randomInt(rng, 0, 3),
            index,
          }),
        );
        // 主动制造同优先级并列，覆盖“同优先级从末尾丢弃”。
        for (let index = 1; index < evidence.length; index += 1) {
          if (rng() < 0.5) {
            evidence[index]!.priority = evidence[index - 1]!.priority;
          }
        }

        const sceneCount = randomInt(rng, 1, 8);
        const scenes: SceneSpec[] = Array.from(
          { length: sceneCount },
          (_, index) => {
            const text = `${sceneToken(index)}${makeText(rng, 1, 4)}`;
            const summaryRoll = rng();
            let summary: string | undefined;
            if (summaryRoll < 0.3) {
              summary = `${summaryToken(index)}${pick(rng, shortSentences)}`;
              // 摘要必须严格短于正文才可用；放不下时换成极短摘要。
              if (summary.length >= text.length) {
                summary = `${summaryToken(index)}好。`;
              }
            } else if (summaryRoll < 0.45) {
              // 摘要比正文更长：不得替换正文。
              summary = `${summaryToken(index)}${text}，这一句摘要明显更长。`;
            } else if (summaryRoll < 0.52) {
              summary = summaryToken(index);
            }
            return {
              id: `scene_${index}`,
              text,
              ...(summary === undefined ? {} : { summary }),
              index,
            };
          },
        );

        const pathLineCount = randomInt(rng, 0, 6);
        const pathLines = Array.from({ length: pathLineCount }, (_, index) => {
          if (index === 0 && rng() < 0.55) {
            return `更早剧情（第 1–1 幕）：${makeSentence(rng)}`;
          }
          return `第 ${index + 1} 幕：${makeSentence(rng)}`;
        });

        return {
          sections: {
            worldlineSetup,
            ...(worldlineSetupCompact === undefined
              ? {}
              : { worldlineSetupCompact }),
            canonEvents:
              rng() < 0.85
                ? `{"events":[{"id":"event_${randomInt(
                    rng,
                    0,
                    99,
                  )}"}],"edges":[]}`
                : "",
            pathSummary: pathLines.join("\n"),
            pathSummaryCoveredSceneIds: pathLines.map(
              (_, index) => `p${index}`,
            ),
            canonEvidence: evidence.map(({ id, text, priority }) => ({
              id,
              text,
              priority,
            })),
            recentScenes: scenes.map(({ id, text, summary }) =>
              summary === undefined ? { id, text } : { id, text, summary },
            ),
            selectedDirection:
              rng() < 0.6 ? "让沈砚在雨夜说出真相。" : "",
            anchorReminder:
              rng() < 0.6 ? "请保留顾闻舟在钟楼出现的结局。" : "",
          },
          evidence,
          scenes,
          pathLines,
        };
      };

      // mulberry32：测试内自带的确定性 PRNG，不引入依赖。
      const mulberry32 = (seed: number): (() => number) => {
        let state = seed >>> 0;
        return () => {
          state = (state + 0x6d2b79f5) | 0;
          let value = state;
          value = Math.imul(value ^ (value >>> 15), value | 1);
          value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
          return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
      };

      type SceneView =
        | { index: number; kind: "full"; body: string }
        | { index: number; kind: "summary"; body: string }
        | { index: number; kind: "truncated"; body: string; prefix: string };
      type Snapshot = {
        prompt: string;
        canonEvents: string | null;
        selectedDirection: string | null;
        anchorReminder: string | null;
        pathLines: string[];
        evidence: Set<number>;
        scenes: Map<number, SceneView>;
        usesCompact: boolean;
        usesSummary: boolean;
        usesTruncation: boolean;
      };

      const EVIDENCE_TOKEN_RE = /〔E(\d+)〕/u;
      const SCENE_TOKEN_RE = /〔S(\d+)〕/u;
      const SUMMARY_TOKEN_RE = /〔M(\d+)〕/u;
      const assertTrue = (condition: boolean, message: string): void => {
        if (!condition) throw new Error(message);
      };

      /** 从渲染后的 Prompt 解析实际可见内容，不依赖 manifest 的段标记。 */
      const parseSnapshot = (
        result: ContextAssemblerResult,
        fixture: Fixture,
        label: string,
      ): Snapshot => {
        const prompt = result.prompt;
        const evidence = new Set<number>();
        for (const body of renderedItems(prompt, "canon_evidence")) {
          const match = EVIDENCE_TOKEN_RE.exec(body);
          if (match === null) throw new Error(`${label} 无法识别证据条目`);
          evidence.add(Number(match[1]));
        }

        const newestIndex = fixture.scenes.length - 1;
        const scenes = new Map<number, SceneView>();
        for (const body of renderedItems(prompt, "recent_scenes")) {
          assertTrue(
            !isMarkerOnlyText(body),
            `${label} recent_scenes 正文不得只有截断标记`,
          );
          const sceneMatch = SCENE_TOKEN_RE.exec(body);
          if (sceneMatch !== null) {
            const index = Number(sceneMatch[1]);
            const spec = fixture.scenes[index];
            if (spec === undefined) throw new Error(`${label} 未知场景编号`);
            if (body === spec.text) {
              scenes.set(index, { index, kind: "full", body });
            } else {
              assertTrue(
                index === newestIndex,
                `${label} 只有最新场景可以截断`,
              );
              assertTrue(
                body.endsWith(TRUNCATION_MARKER),
                `${label} 场景正文只能是完整正文或截断正文`,
              );
              const prefix = body.slice(0, -TRUNCATION_MARKER.length);
              assertTrue(prefix.length > 0, `${label} 截断前缀不得为空`);
              assertTrue(
                spec.text.startsWith(prefix),
                `${label} 截断前缀必须来自原正文`,
              );
              scenes.set(index, { index, kind: "truncated", body, prefix });
            }
            continue;
          }
          const summaryMatch = SUMMARY_TOKEN_RE.exec(body);
          if (summaryMatch !== null) {
            const index = Number(summaryMatch[1]);
            const spec = fixture.scenes[index];
            if (spec === undefined) throw new Error(`${label} 未知场景编号`);
            assertTrue(
              index === newestIndex,
              `${label} 只有最新场景可以用摘要替换`,
            );
            assertTrue(
              spec.summary === body,
              `${label} 摘要替换必须使用该场景自己的摘要`,
            );
            assertTrue(
              spec.summary !== undefined &&
                spec.summary.length < spec.text.length,
              `${label} 只能使用严格短于正文的摘要`,
            );
            scenes.set(index, { index, kind: "summary", body });
            continue;
          }
          throw new Error(`${label} 无法识别场景正文`);
        }

        const newest = scenes.get(newestIndex);
        if (newest === undefined) throw new Error(`${label} 最新场景必须保留`);
        const setupBody = renderedSection(prompt, "worldline_setup");
        return {
          prompt,
          canonEvents: renderedSection(prompt, "canon_events"),
          selectedDirection: renderedSection(prompt, "selected_direction"),
          anchorReminder: renderedSection(prompt, "anchor_reminder"),
          pathLines: renderedLines(prompt, "path_summary"),
          evidence,
          scenes,
          usesCompact:
            setupBody !== null &&
            setupBody !== fixture.sections.worldlineSetup.trim(),
          usesSummary: newest.kind === "summary",
          usesTruncation: newest.kind === "truncated",
        };
      };

      // 确认生成器真的覆盖到声明的取值范围，而不是只靠随机运气。
      const coverage = {
        evidenceZero: false,
        evidenceMax: false,
        sceneMin: false,
        sceneMax: false,
        pathZero: false,
        pathMax: false,
        omissionFirst: false,
        compactShorter: false,
        compactEqual: false,
        compactLonger: false,
        summaryLongerThanText: false,
        emptyCanonEvents: false,
        emptySelectedDirection: false,
        emptyAnchorReminder: false,
        usedCompact: false,
        usedSummary: false,
        usedTruncation: false,
      };

      const FIXTURE_COUNT = 300;
      for (
        let fixtureIndex = 0;
        fixtureIndex < FIXTURE_COUNT;
        fixtureIndex += 1
      ) {
        const rng = mulberry32(
          0x9e3779b9 ^ Math.imul(fixtureIndex + 1, 0x85ebca6b),
        );
        const fixture = makeFixture(rng);
        const fullSetup = fixture.sections.worldlineSetup.trim();
        const compactSetup = fixture.sections.worldlineSetupCompact;
        coverage.evidenceZero ||= fixture.evidence.length === 0;
        coverage.evidenceMax ||= fixture.evidence.length === 12;
        coverage.sceneMin ||= fixture.scenes.length === 1;
        coverage.sceneMax ||= fixture.scenes.length === 8;
        coverage.pathZero ||= fixture.pathLines.length === 0;
        coverage.pathMax ||= fixture.pathLines.length === 6;
        coverage.omissionFirst ||=
          fixture.pathLines[0] !== undefined &&
          isPathOmissionLine(fixture.pathLines[0]);
        coverage.compactShorter ||=
          compactSetup !== undefined && compactSetup.length < fullSetup.length;
        coverage.compactEqual ||=
          compactSetup !== undefined && compactSetup.length === fullSetup.length;
        coverage.compactLonger ||=
          compactSetup !== undefined && compactSetup.length > fullSetup.length;
        coverage.summaryLongerThanText ||= fixture.scenes.some(
          (scene) =>
            scene.summary !== undefined && scene.summary.length > scene.text.length,
        );
        coverage.emptyCanonEvents ||= fixture.sections.canonEvents === "";
        coverage.emptySelectedDirection ||=
          fixture.sections.selectedDirection === "";
        coverage.emptyAnchorReminder ||= fixture.sections.anchorReminder === "";
        const full = assembleContext({
          maxChars: 1_000_000,
          sections: fixture.sections,
        });
        const fullSnapshot = parseSnapshot(
          full,
          fixture,
          `fixture ${fixtureIndex} full`,
        );
        const pathLineIndex = new Map(
          fixture.pathLines.map((line, index) => [line, index]),
        );
        const pathIndices = (
          lines: readonly string[],
          label: string,
        ): number[] => {
          const indices: number[] = [];
          for (const line of lines) {
            const index = pathLineIndex.get(line);
            assertTrue(
              index !== undefined,
              `${label} path_summary 只能出现完整原始行`,
            );
            indices.push(index as number);
          }
          return indices;
        };

        let previous: Snapshot | null = null;
        let previousBudget: number | null = null;
        let firstFeasible: number | null = null;

        for (
          let budget = 1;
          budget <= full.prompt.length + 20;
          budget += 1
        ) {
          const label = `fixture ${fixtureIndex} budget ${budget}`;
          const result = tryAssemble(budget, fixture.sections);
          if (result === null) {
            assertTrue(
              firstFeasible === null,
              `${label} 放出后不得再失败`,
            );
            continue;
          }
          firstFeasible ??= budget;
          assertTrue(result.prompt.length <= budget, `${label} 不得超预算`);
          const snapshot = parseSnapshot(result, fixture, label);
          coverage.usedCompact ||= snapshot.usesCompact;
          coverage.usedSummary ||= snapshot.usesSummary;
          coverage.usedTruncation ||= snapshot.usesTruncation;

          // canon_events / selected_direction / anchor_reminder 永不裁剪。
          for (const [kind, key, fullBody] of [
            ["canon_events", "canonEvents", fullSnapshot.canonEvents],
            ["selected_direction", "selectedDirection", fullSnapshot.selectedDirection],
            ["anchor_reminder", "anchorReminder", fullSnapshot.anchorReminder],
          ] as const) {
            assertTrue(
              snapshot[key] === fullBody,
              `${label} ${kind} 必须与完整渲染逐字节一致，不得裁剪`,
            );
          }

          // 任意预算下，保留证据的优先级不低于丢弃证据；同优先级只丢末尾。
          let minKeptPriority = Number.POSITIVE_INFINITY;
          let maxDroppedPriority = Number.NEGATIVE_INFINITY;
          const droppedAtPriority = new Set<number>();
          for (const spec of fixture.evidence) {
            if (snapshot.evidence.has(spec.index)) {
              minKeptPriority = Math.min(
                minKeptPriority,
                spec.priority,
              );
              assertTrue(
                !droppedAtPriority.has(spec.priority),
                `${label} 同优先级证据只能从末尾丢弃`,
              );
            } else {
              maxDroppedPriority = Math.max(
                maxDroppedPriority,
                spec.priority,
              );
              droppedAtPriority.add(spec.priority);
            }
          }
          assertTrue(
            minKeptPriority >= maxDroppedPriority,
            `${label} 保留证据的优先级不得低于已丢弃证据`,
          );

          if (previous !== null) {
            assertTrue(
              previousBudget === budget - 1,
              `${label} 必须与上一个可行预算相邻`,
            );

            assertTrue(
              snapshot.prompt.length >= previous.prompt.length,
              `${label} prompt length 不得随预算增大而变短：${previous.prompt.length} -> ${snapshot.prompt.length}`,
            );

            for (const id of previous.evidence) {
              assertTrue(
                snapshot.evidence.has(id),
                `${label} 证据集合必须包含更小预算保留的 ${id}`,
              );
            }

            for (const index of previous.scenes.keys()) {
              assertTrue(
                snapshot.scenes.has(index),
                `${label} 场景集合必须包含更小预算保留的 ${index}`,
              );
            }
            for (const view of previous.scenes.values()) {
              if (view.kind === "full") {
                assertTrue(
                  snapshot.scenes.get(view.index)?.kind === "full",
                  `${label} 完整场景集合必须包含 ${view.index}`,
                );
              }
            }

            const currentPathIndices = pathIndices(
              snapshot.pathLines,
              label,
            );
            for (let index = 1; index < currentPathIndices.length; index += 1) {
              assertTrue(
                currentPathIndices[index]! > currentPathIndices[index - 1]!,
                `${label} path_summary 行必须保持原始顺序`,
              );
            }
            const previousOmission =
              previous.pathLines[0] !== undefined &&
              isPathOmissionLine(previous.pathLines[0])
                ? previous.pathLines[0]
                : null;
            const currentOmission =
              snapshot.pathLines[0] !== undefined &&
              isPathOmissionLine(snapshot.pathLines[0])
                ? snapshot.pathLines[0]
                : null;
            assertTrue(
              previousOmission === null ||
                currentOmission === previousOmission,
              `${label} 更早剧情省略行不得在更大预算消失`,
            );
            // 省略行是固定在首行的表头，其余行才按“从开头裁剪”比较后缀。
            const previousContent = previous.pathLines.filter(
              (line) => !isPathOmissionLine(line),
            );
            const currentContent = snapshot.pathLines.filter(
              (line) => !isPathOmissionLine(line),
            );
            assertTrue(
              isSuffix(previousContent, currentContent),
              `${label} path_summary 保留行必须是更大预算的后缀`,
            );

            const newestIndex = fixture.scenes.length - 1;
            const previousNewest = previous.scenes.get(newestIndex);
            const currentNewest = snapshot.scenes.get(newestIndex);
            if (
              previousNewest?.kind === "truncated" &&
              currentNewest?.kind === "truncated"
            ) {
              assertTrue(
                currentNewest.prefix.startsWith(previousNewest.prefix),
                `${label} 截断前缀必须保留更小预算的前缀`,
              );
            }

            assertTrue(
              !snapshot.usesCompact || previous.usesCompact,
              `${label} 不得在更大预算才启用紧凑设定`,
            );
            assertTrue(
              !snapshot.usesSummary || previous.usesSummary,
              `${label} 不得在更大预算才启用摘要替换`,
            );
            assertTrue(
              !snapshot.usesTruncation || previous.usesTruncation,
              `${label} 不得在更大预算才启用截断`,
            );
          }

          previous = snapshot;
          previousBudget = budget;
        }
        expect(
          firstFeasible,
          `fixture ${fixtureIndex} 必须能放下`,
        ).not.toBeNull();
      }

      for (const [name, seen] of Object.entries(coverage)) {
        expect(seen, `随机生成器未覆盖 ${name}`).toBe(true);
      }
    },
  );
});
