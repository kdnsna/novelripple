import { describe, expect, it } from "vitest";

import {
  assembleContext,
  CONTEXT_SECTION_ORDER,
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

  it("replaces the newest scene with its summary before failing closed", () => {
    const fullSetup = `完整状态：${"事实正文".repeat(60)}`;
    const compactSetup =
      '{"currentState":{"factsAddedCount":1,"factsAddedKeys":["generated:x"]}}';
    const newest = {
      id: "s1",
      text: "最新场景正文。".repeat(15),
      summary: "最新场景摘要。",
    };
    const baseSections: ContextAssemblerInput["sections"] = {
      ...sections,
      worldlineSetup: fullSetup,
      worldlineSetupCompact: compactSetup,
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
      droppedItemIds: ["s1"],
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

  it("fails closed when the mandatory sections alone exceed the budget", () => {
    expect(() => assemble(150)).toThrow("必需上下文段超过预算");
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
});
