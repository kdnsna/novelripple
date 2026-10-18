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

describe("assembleContext", () => {
  it("renders the fixed section order with stable tags", () => {
    const result = assemble(10_000);

    const positions = CONTEXT_SECTION_ORDER.map((kind) =>
      result.prompt.indexOf(`<${kind}>`),
    );
    for (const [index, position] of positions.entries()) {
      expect(position).toBeGreaterThanOrEqual(0);
      if (index > 0) expect(position).toBeGreaterThan(positions[index - 1]!);
    }
    expect(result.prompt.startsWith("<worldline_setup>")).toBe(true);
    expect(result.prompt.indexOf("<canon_events>")).toBeLessThan(
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

  it("fails closed when the whole v1 scene is inside a quotation", () => {
    for (const prose of ["「没有人来过这里。", "“只有这一句。"]) {
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

      // 最外层开引号就在开头，没有安全的非空前缀：不得只返回截断标记。
      expect(() =>
        assembleContext({
          maxChars: full.prompt.length - 1,
          sections: baseSections,
        }),
      ).toThrow(/必需上下文段与最新场景超过预算/);
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

  it(
    "keeps the ladder monotonic for every budget across seeded random fixtures",
    { timeout: 30_000 },
    () => {
      /** 全部为测试构造的短句，不是任何作品原文。 */
      const sentences = [
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
      const quotedSentences = [
        "他说：「走吧。」然后停下。",
        "她低声说：「别回头。」继续向前。",
        "「没有人来过这里。」他回答。",
        "她问：「真的吗？」随后沉默。",
        "他喊道：「快走！」转身离开。",
        "她说：「等等……」又改了口。",
        "他念道：「灯灭了。』」",
      ];
      const pick = (rng: () => number, pool: readonly string[]): string =>
        pool[Math.floor(rng() * pool.length)]!;
      const randomInt = (
        rng: () => number,
        min: number,
        max: number,
      ): number => min + Math.floor(rng() * (max - min + 1));
      const makeText = (
        rng: () => number,
        minSentences: number,
        maxSentences: number,
      ): string => {
        const pool = rng() < 0.45 ? quotedSentences : sentences;
        const count = randomInt(rng, minSentences, maxSentences);
        return Array.from({ length: count }, () => pick(rng, pool)).join("");
      };

      const makeFixture = (
        rng: () => number,
      ): ContextAssemblerInput["sections"] => {
        const setupSentences =
          rng() < 0.6 ? randomInt(rng, 3, 6) : randomInt(rng, 1, 3);
        const worldlineSetup = `世界线设定：${Array.from(
          { length: setupSentences },
          () => pick(rng, sentences),
        ).join("")}`;
        const compactSetup =
          rng() < 0.65
            ? `{"currentState":{"factsAddedCount":${randomInt(rng, 0, 9)}}}`
            : undefined;

        const evidenceCount =
          rng() < 0.15 ? 0 : randomInt(rng, 1, 7);
        const canonEvidence = Array.from({ length: evidenceCount }, (_, index) => ({
          id: `evidence_${index}`,
          text: makeText(rng, 1, 4),
          priority: randomInt(rng, 0, 2),
        }));

        const sceneCount = randomInt(rng, 1, 6);
        const recentScenes = Array.from({ length: sceneCount }, (_, index) => {
          const hasSummary = rng() < 0.45;
          const text = makeText(
            rng,
            hasSummary ? 3 : 1,
            hasSummary ? 5 : 3,
          );
          if (!hasSummary) return { id: `scene_${index}`, text };
          return {
            id: `scene_${index}`,
            text,
            summary: pick(rng, sentences),
          };
        });

        const pathLineCount = randomInt(rng, 0, 3);
        const pathLines = Array.from({ length: pathLineCount }, (_, index) =>
          index === 0 && rng() < 0.4
            ? `更早剧情（第 1–2 幕）：${pick(rng, sentences)}`
            : `第 ${index + 1} 幕：${pick(rng, sentences)}`,
        );

        return {
          worldlineSetup,
          ...(compactSetup === undefined
            ? {}
            : { worldlineSetupCompact: compactSetup }),
          canonEvents:
            rng() < 0.8
              ? `{"events":[{"id":"event_${randomInt(rng, 0, 9)}"}],"edges":[]}`
              : "",
          pathSummary: pathLines.join("\n"),
          pathSummaryCoveredSceneIds: pathLines.map((_, index) => `p${index}`),
          canonEvidence,
          recentScenes,
          selectedDirection: rng() < 0.7 ? "让沈砚在雨夜说出真相。" : "",
          anchorReminder: rng() < 0.7 ? "请保留顾闻舟在钟楼出现的结局。" : "",
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

      const sectionOfResult = (
        result: ContextAssemblerResult,
        kind: ContextManifestSectionKind,
      ) => {
        const found = result.manifest.sections.find(
          (section) => section.kind === kind,
        );
        if (!found) throw new Error(`manifest 缺少段：${kind}`);
        return found;
      };
      const droppedSet = (result: ContextAssemblerResult, kind: "canon_evidence" | "recent_scenes") =>
        new Set(sectionOfResult(result, kind).droppedItemIds);
      const retainedEvidenceIds = (
        result: ContextAssemblerResult,
        ids: readonly string[],
      ): string[] => {
        const dropped = droppedSet(result, "canon_evidence");
        return ids.filter((id) => !dropped.has(id));
      };
      const keptSceneIds = (
        result: ContextAssemblerResult,
        ids: readonly string[],
      ): string[] => {
        const dropped = droppedSet(result, "recent_scenes");
        return ids.filter((id) => !dropped.has(id));
      };
      const fullSceneIds = (
        result: ContextAssemblerResult,
        ids: readonly string[],
      ): string[] => {
        const scenes = sectionOfResult(result, "recent_scenes");
        const degraded = new Set([
          ...scenes.droppedItemIds,
          ...(scenes.summarizedItemIds ?? []),
          ...(scenes.truncatedItemIds ?? []),
        ]);
        return ids.filter((id) => !degraded.has(id));
      };
      const usesCompact = (result: ContextAssemblerResult): boolean =>
        sectionOfResult(result, "worldline_setup").trimmed;
      const usesSummary = (result: ContextAssemblerResult): boolean =>
        (sectionOfResult(result, "recent_scenes").summarizedItemIds ?? [])
          .length > 0;
      const usesTruncation = (result: ContextAssemblerResult): boolean =>
        (sectionOfResult(result, "recent_scenes").truncatedItemIds ?? [])
          .length > 0;

      const FIXTURE_COUNT = 300;
      // 全预算扫描会产生数十万次比较；用 throw 保持测试在几秒内完成。
      const assertTrue = (condition: boolean, message: string): void => {
        if (!condition) throw new Error(message);
      };
      for (let fixtureIndex = 0; fixtureIndex < FIXTURE_COUNT; fixtureIndex += 1) {
        const rng = mulberry32(
          0x9e3779b9 ^ Math.imul(fixtureIndex + 1, 0x85ebca6b),
        );
        const fixture = makeFixture(rng);
        const evidenceIds = fixture.canonEvidence.map((item) => item.id);
        const sceneIds = fixture.recentScenes.map((item) => item.id);
        const full = assembleContext({ maxChars: 1_000_000, sections: fixture });
        let previous: ContextAssemblerResult | null = null;
        let firstFeasible: number | null = null;

        for (let budget = 1; budget <= full.prompt.length + 20; budget += 1) {
          const result = tryAssemble(budget, fixture);
          const label = `fixture ${fixtureIndex} budget ${budget}`;
          if (!result) {
            assertTrue(firstFeasible === null, `${label} 放出后不得再失败`);
            continue;
          }
          firstFeasible ??= budget;
          assertTrue(result.prompt.length <= budget, `${label} 不得超预算`);
          if (previous) {
            assertTrue(
              result.prompt.length >= previous.prompt.length,
              `${label} 的 prompt 不得短于更小预算`,
            );

            const currentEvidence = new Set(
              retainedEvidenceIds(result, evidenceIds),
            );
            for (const id of retainedEvidenceIds(previous, evidenceIds)) {
              assertTrue(
                currentEvidence.has(id),
                `${label} 证据集合必须包含 ${id}`,
              );
            }

            const currentFullScenes = new Set(fullSceneIds(result, sceneIds));
            for (const id of fullSceneIds(previous, sceneIds)) {
              assertTrue(
                currentFullScenes.has(id),
                `${label} 完整场景集合必须包含 ${id}`,
              );
            }

            const currentScenes = new Set(keptSceneIds(result, sceneIds));
            for (const id of keptSceneIds(previous, sceneIds)) {
              assertTrue(
                currentScenes.has(id),
                `${label} 场景集合必须包含 ${id}`,
              );
            }

            assertTrue(
              !usesCompact(result) || usesCompact(previous),
              `${label} 不得更早启用紧凑设定`,
            );
            assertTrue(
              !usesSummary(result) || usesSummary(previous),
              `${label} 不得更早启用摘要替换`,
            );
            assertTrue(
              !usesTruncation(result) || usesTruncation(previous),
              `${label} 不得更早启用截断`,
            );
          }
          previous = result;
        }
        expect(firstFeasible, `fixture ${fixtureIndex} 必须能放下`).not.toBeNull();
      }
    },
  );
});
