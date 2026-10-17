import { describe, expect, it } from "vitest";

import {
  buildPathSummary,
  type PathSummaryNode,
} from "@/domain/continuation/path-summary";

/** 全部为测试构造的短句，不是任何作品原文。 */
const path: PathSummaryNode[] = [
  {
    id: "scene_1",
    title: "钟楼初见",
    summary: "许澄在钟楼遇到沈砚。",
  },
  {
    id: "scene_2",
    title: "雨夜相约",
    summary: "两人约定次日再见。",
  },
  {
    id: "scene_3",
    title: "账簿转移",
    summary: "许澄把账簿交给沈砚。",
  },
  {
    id: "scene_4",
    title: "门外脚步",
    summary: "顾闻舟来到钟楼。",
  },
];

describe("buildPathSummary", () => {
  it("summarizes nodes older than the last two scenes, oldest first", () => {
    const summary = buildPathSummary({ pathNodes: path });

    expect(summary.text).toBe(
      [
        "第 1 幕：钟楼初见——许澄在钟楼遇到沈砚。",
        "第 2 幕：雨夜相约——两人约定次日再见。",
      ].join("\n"),
    );
    expect(summary.coveredSceneIds).toEqual(["scene_1", "scene_2"]);
    expect(summary.watermarkSceneId).toBe("scene_2");
    expect(summary.truncated).toBe(false);
  });

  it("includes every node when recentSceneCount is zero", () => {
    const summary = buildPathSummary({ pathNodes: path, recentSceneCount: 0 });

    expect(summary.coveredSceneIds).toEqual([
      "scene_1",
      "scene_2",
      "scene_3",
      "scene_4",
    ]);
    expect(summary.watermarkSceneId).toBe("scene_4");
    expect(summary.text.split("\n")).toHaveLength(4);
    expect(summary.text).toContain("第 4 幕：门外脚步——顾闻舟来到钟楼。");
  });

  it("returns an empty summary when the path is fully inside the recent window", () => {
    const summary = buildPathSummary({
      pathNodes: path.slice(0, 2),
      recentSceneCount: 2,
    });

    expect(summary).toEqual({
      text: "",
      coveredSceneIds: [],
      watermarkSceneId: null,
      truncated: false,
    });
  });

  it("falls back to the title only for v1 nodes without a summary", () => {
    const summary = buildPathSummary({
      pathNodes: [
        { id: "scene_v1", title: "钟楼初见", summary: null },
        { id: "scene_v2", title: "雨夜相约", summary: "两人约定次日再见。" },
      ],
      recentSceneCount: 0,
    });

    expect(summary.text).toBe(
      ["第 1 幕：钟楼初见", "第 2 幕：雨夜相约——两人约定次日再见。"].join(
        "\n",
      ),
    );
    expect(summary.coveredSceneIds).toEqual(["scene_v1", "scene_v2"]);
    expect(summary.watermarkSceneId).toBe("scene_v2");
  });

  it("keeps the newest line verbatim and compresses older lines", () => {
    const summary = buildPathSummary({ pathNodes: path, maxChars: 40 });

    expect(summary.text).toBe(
      [
        "更早剧情（第 1–1 幕）：钟楼初见",
        "第 2 幕：雨夜相约——两人约定次日再见。",
      ].join("\n"),
    );
    expect(summary.coveredSceneIds).toEqual(["scene_1", "scene_2"]);
    expect(summary.watermarkSceneId).toBe("scene_2");
    expect(summary.truncated).toBe(true);
  });

  it("compresses all summarised lines into one marker when nothing else fits", () => {
    const summary = buildPathSummary({ pathNodes: path, maxChars: 34 });

    expect(summary.text).toBe(
      "更早剧情（第 1–2 幕）：钟楼初见；雨夜相约",
    );
    expect(summary.coveredSceneIds).toEqual(["scene_1", "scene_2"]);
    expect(summary.watermarkSceneId).toBe("scene_2");
    expect(summary.truncated).toBe(true);
  });

  it("keeps the most recent compressed titles when not all of them fit", () => {
    const summary = buildPathSummary({ pathNodes: path, maxChars: 22 });

    // 只保留最靠近剩余全文行的最近一条压缩标题，范围必须连续。
    expect(summary.text).toBe("更早剧情（第 2–2 幕）：雨夜相约");
    // 最早一条标题没有被切成半截，也没有被错误地显示。
    expect(summary.text).not.toContain("钟楼");
    expect(summary.coveredSceneIds).toEqual(["scene_2"]);
    expect(summary.watermarkSceneId).toBe("scene_2");
    expect(summary.truncated).toBe(true);
  });

  it("reports only the compressed scenes actually shown and keeps the range contiguous", () => {
    const nodes: PathSummaryNode[] = [
      { id: "s1", title: "钟楼里的旧信", summary: "一" },
      { id: "s2", title: "雨夜里的约定", summary: "二" },
      { id: "s3", title: "账簿转移之后", summary: "三" },
      { id: "s4", title: "门外脚步响起", summary: "四" },
      { id: "s5", title: "灯塔下的夜谈", summary: "五" },
      { id: "s6", title: "清晨的渡口", summary: "六" },
    ];

    const summary = buildPathSummary({
      pathNodes: nodes,
      recentSceneCount: 1,
      maxChars: 45,
    });

    expect(summary.text).toBe(
      [
        "更早剧情（第 3–4 幕）：账簿转移之后；门外脚步响起",
        "第 5 幕：灯塔下的夜谈——五",
      ].join("\n"),
    );
    expect(summary.coveredSceneIds).toEqual(["s3", "s4", "s5"]);
    expect(summary.watermarkSceneId).toBe("s5");
    expect(summary.truncated).toBe(true);
  });

  it("fails closed when even the compressed marker cannot fit", () => {
    expect(() =>
      buildPathSummary({ pathNodes: path, maxChars: 13 }),
    ).toThrow("路径摘要预算过小");
  });

  it("only reads the given path, so sibling branches stay isolated", () => {
    const root: PathSummaryNode = {
      id: "scene_root",
      title: "共同起点",
      summary: "许澄离开钟楼。",
    };
    const branchA: PathSummaryNode = {
      id: "scene_a",
      title: "甲分支",
      summary: "沈砚留在原地。",
    };
    const branchB: PathSummaryNode = {
      id: "scene_b",
      title: "乙分支",
      summary: "顾闻舟追了出去。",
    };

    const summaryA = buildPathSummary({
      pathNodes: [root, branchA],
      recentSceneCount: 0,
    });
    const summaryB = buildPathSummary({
      pathNodes: [root, branchB],
      recentSceneCount: 0,
    });

    expect(summaryA.text).toContain("甲分支");
    expect(summaryA.text).not.toContain("乙分支");
    expect(summaryA.coveredSceneIds).not.toContain("scene_b");
    expect(summaryB.text).toContain("乙分支");
    expect(summaryB.text).not.toContain("甲分支");
    expect(summaryB.coveredSceneIds).not.toContain("scene_a");
  });

  it("is deterministic for the same input", () => {
    const first = buildPathSummary({ pathNodes: path, maxChars: 34 });
    const second = buildPathSummary({ pathNodes: path, maxChars: 34 });

    expect(second).toEqual(first);
    expect(second.text).toBe(first.text);
  });

  it("rejects invalid budgets and duplicate nodes", () => {
    expect(() =>
      buildPathSummary({ pathNodes: path, recentSceneCount: -1 }),
    ).toThrow("recentSceneCount");
    expect(() =>
      buildPathSummary({ pathNodes: path, recentSceneCount: 1.5 }),
    ).toThrow("recentSceneCount");
    expect(() => buildPathSummary({ pathNodes: path, maxChars: 0 })).toThrow(
      "maxChars",
    );
    expect(() =>
      buildPathSummary({ pathNodes: [path[0]!, path[0]!] }),
    ).toThrow("重复节点");
  });
});
