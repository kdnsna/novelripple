import { describe, expect, it } from "vitest";

import {
  CANON_GUARD_BROKEN_QUOTE_NARRATOR,
  CANON_GUARD_DIALOGUE_LIE,
  CANON_GUARD_FRAME_THEN_NARRATOR,
  CANON_GUARD_LEGITIMATE,
  CANON_GUARD_NEUTRAL_PROSE,
  CANON_GUARD_OFF_LIST_VERBS,
  CANON_GUARD_PROBE_PATH_STATE,
  CANON_GUARD_PROBE_STORY_MAP,
  CANON_GUARD_RECLASSIFIED_WARN,
  CANON_GUARD_REVIEWER_DIALOGUE,
  CANON_GUARD_SHOULD_REJECT,
  CANON_GUARD_SPECULATION,
  computeCanonGuardProbeStats,
} from "../helpers/canon-guard-probe";
import {
  clauseHasCharacterSubject,
  findQuotedSpans,
  hasUnpairedQuote,
  validateAgainstPreDivergenceCanon,
} from "@/domain/invariants/validate-continuation";

/**
 * 标注探针：断言硬拒绝的假阳性上限，并记录召回率。
 *
 * 测试名与 inline snapshot 都包含测得数字，便于在没有额外脚本时直接读取。
 * 这些句子全部是自建短句，不含任何作品原文。
 */
const stats = computeCanonGuardProbeStats();
const shouldRejectCount = CANON_GUARD_SHOULD_REJECT.length;
const legitimateCount = CANON_GUARD_LEGITIMATE.length;
const dialogueCount = CANON_GUARD_DIALOGUE_LIE.length;
const reviewerDialogueCount = CANON_GUARD_REVIEWER_DIALOGUE.length;
const frameThenNarratorCount = CANON_GUARD_FRAME_THEN_NARRATOR.length;
const brokenQuoteNarratorCount = CANON_GUARD_BROKEN_QUOTE_NARRATOR.length;
const offListVerbCount = CANON_GUARD_OFF_LIST_VERBS.length;
const speculationCount = CANON_GUARD_SPECULATION.length;
const reclassifiedCount = CANON_GUARD_RECLASSIFIED_WARN.length;

describe("canon guard labeled probe", () => {
  it(
    `catch ${stats.caught}/${shouldRejectCount}, hard false-reject ${
      stats.hardFalseRejects
    }/${legitimateCount}, warnings ${stats.warningsOnLegitimate}/${
      legitimateCount
    }, neutral ${stats.neutralHardRejects}, dialogue hard-reject ${
      stats.dialogueHardRejects
    }/${dialogueCount}, dialogue warnings ${stats.dialogueWarnings}/${dialogueCount}, frame-then-narrator caught ${
      stats.frameThenNarratorCaught
    }/${frameThenNarratorCount}, broken-quote narrator caught ${
      stats.brokenQuoteNarratorCaught
    }/${brokenQuoteNarratorCount}, reviewer dialogue hard-reject ${
      stats.reviewerDialogueHardRejects
    }/${reviewerDialogueCount}, reviewer dialogue warnings ${
      stats.reviewerDialogueWarnings
    }/${reviewerDialogueCount}, off-list verbs hard-reject ${
      stats.offListVerbHardRejects
    }/${offListVerbCount}, off-list verbs warnings ${
      stats.offListVerbWarnings
    }/${offListVerbCount}, speculation hard-reject ${
      stats.speculationHardRejects
    }/${speculationCount}, speculation warnings ${
      stats.speculationWarnings
    }/${speculationCount}, reclassified hard-reject ${
      stats.reclassifiedHardRejects
    }/${reclassifiedCount}, reclassified warnings ${
      stats.reclassifiedWarnings
    }/${reclassifiedCount}`,
    () => {
      // 合法续写、对白/传闻与评审方类别样本都是硬约束：一条都不能被硬拒绝。
      expect(stats.hardFalseRejects).toBe(0);
      expect(stats.neutralHardRejects).toBe(0);
      expect(stats.dialogueHardRejects).toBe(0);
      expect(stats.reviewerDialogueHardRejects).toBe(0);
      // 角色主语/推测分句在否定前出现：只 warning，一条都不能硬拒绝。
      expect(stats.offListVerbHardRejects).toBe(0);
      expect(stats.speculationHardRejects).toBe(0);
      expect(stats.reclassifiedHardRejects).toBe(0);
      // 前一分句的框架不能豁免后一分句的叙述者否定：整组都必须硬拒绝。
      expect(stats.frameThenNarratorCaught).toBe(frameThenNarratorCount);
      // 坏引号不能遮蔽叙述者否定：fail-closed 引号组必须全部硬拒绝。
      expect(stats.brokenQuoteNarratorCaught).toBe(brokenQuoteNarratorCount);
      // 每一类都应至少产生低置信 warning，而不是静默丢失信号。
      expect(stats.warningsOnLegitimate).toBeGreaterThan(0);
      expect(stats.dialogueWarnings).toBeGreaterThan(0);
      expect(stats.reviewerDialogueWarnings).toBeGreaterThan(0);
      expect(stats.offListVerbWarnings).toBeGreaterThan(0);
      expect(stats.speculationWarnings).toBeGreaterThan(0);
      expect(stats.reclassifiedWarnings).toBeGreaterThan(0);
      // 探针输入没有变化时结果必须确定。
      expect(computeCanonGuardProbeStats()).toEqual(stats);
      expect(stats).toMatchInlineSnapshot(`
        {
          "brokenQuoteNarratorCaught": 7,
          "caught": 13,
          "dialogueHardRejects": 0,
          "dialogueWarnings": 37,
          "frameThenNarratorCaught": 17,
          "hardFalseRejects": 0,
          "neutralHardRejects": 0,
          "offListVerbHardRejects": 0,
          "offListVerbWarnings": 24,
          "reclassifiedHardRejects": 0,
          "reclassifiedWarnings": 17,
          "reviewerDialogueHardRejects": 0,
          "reviewerDialogueWarnings": 8,
          "speculationHardRejects": 0,
          "speculationWarnings": 18,
          "warningsOnLegitimate": 10,
          "warningsOnShouldReject": 4,
        }
      `);
    },
  );

  it("returns a non-blocking warning for recollection instead of a hard reject", () => {
    const result = validateAgainstPreDivergenceCanon({
      textFields: [
        {
          field: "prose",
          text: CANON_GUARD_LEGITIMATE[0],
        },
      ],
      storyMap: CANON_GUARD_PROBE_STORY_MAP,
      divergenceEventId: "event_4",
      pathState: CANON_GUARD_PROBE_PATH_STATE,
      policy: "strict",
    });
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        eventId: "event_1",
        field: "prose",
        reason: expect.stringContaining("灯塔熄灭"),
      }),
    ]);
  });

  it("records the expected probe sizes", () => {
    expect(CANON_GUARD_SHOULD_REJECT).toHaveLength(19);
    expect(CANON_GUARD_LEGITIMATE).toHaveLength(19);
    expect(CANON_GUARD_DIALOGUE_LIE).toHaveLength(37);
    expect(CANON_GUARD_FRAME_THEN_NARRATOR).toHaveLength(17);
    expect(CANON_GUARD_BROKEN_QUOTE_NARRATOR).toHaveLength(7);
    expect(CANON_GUARD_REVIEWER_DIALOGUE).toHaveLength(8);
    expect(CANON_GUARD_OFF_LIST_VERBS).toHaveLength(24);
    expect(CANON_GUARD_SPECULATION).toHaveLength(18);
    expect(CANON_GUARD_RECLASSIFIED_WARN).toHaveLength(17);
    expect(CANON_GUARD_NEUTRAL_PROSE.length).toBeGreaterThan(200);
  });
});

describe("clauseHasCharacterSubject", () => {
  const names = ["沈砚", "小满"];

  it("recognizes Story Map names, aliases, pronouns and person nouns", () => {
    for (const clause of [
      "沈砚点了点头",
      "小满低声说",
      "他点点头",
      "众人说完后便散了",
      "老渔夫坚称",
      "船长嘱咐",
      "守塔人提醒",
      "村里的孩子们安慰",
      "掌柜的伙计们保证",
    ]) {
      expect(clauseHasCharacterSubject(clause, names)).toBe(true);
    }
  });

  it("allows a short leading adverbial (≤4 chars)", () => {
    expect(clauseHasCharacterSubject("后来沈砚点了点头", names)).toBe(true);
    expect(clauseHasCharacterSubject("那天清晨他转过身", names)).toBe(true);
    expect(clauseHasCharacterSubject("忽然老渔夫笑了", names)).toBe(true);
  });

  it("requires content after the subject and rejects non-character clauses", () => {
    expect(clauseHasCharacterSubject("他", names)).toBe(false);
    expect(clauseHasCharacterSubject("沈砚", names)).toBe(false);
    expect(clauseHasCharacterSubject("老渔夫", names)).toBe(false);
    expect(clauseHasCharacterSubject("夜色渐深", names)).toBe(false);
    expect(clauseHasCharacterSubject("结论只有一个", names)).toBe(false);
    expect(clauseHasCharacterSubject("据说那年很冷", names)).toBe(false);
    expect(clauseHasCharacterSubject("  他，", names)).toBe(false);
  });

  it("rejects copula phrases but keeps demonstrative+measure person nouns", () => {
    expect(clauseHasCharacterSubject("这是水手们的说法", names)).toBe(false);
    expect(clauseHasCharacterSubject("这是水手", names)).toBe(false);
    expect(clauseHasCharacterSubject("有人", names)).toBe(false);
    expect(clauseHasCharacterSubject("有人在敲门", names)).toBe(true);
    expect(clauseHasCharacterSubject("那位老船长摇摇头", names)).toBe(true);
    expect(clauseHasCharacterSubject("这位船长点点头", names)).toBe(true);
    expect(clauseHasCharacterSubject("那群孩子跑过来", names)).toBe(true);
  });
});

describe("canon guard person-noun subject heuristic", () => {
  function evaluate(text: string) {
    return validateAgainstPreDivergenceCanon({
      textFields: [{ field: "prose", text }],
      storyMap: CANON_GUARD_PROBE_STORY_MAP,
      divergenceEventId: "event_4",
      pathState: CANON_GUARD_PROBE_PATH_STATE,
      policy: "strict",
    });
  }

  it("does not treat a copula phrase ending in 们 as a character subject", () => {
    const result = evaluate("这是水手们的说法，交出钥匙从未发生过。");
    expect(result.issues).toHaveLength(1);
    expect(result.hardRejections[0]).toMatchObject({ title: "交出钥匙" });
  });

  it("keeps a demonstrative + measure person noun as a character subject", () => {
    const result = evaluate("那位老船长摇摇头，灯塔熄灭从未发生过。");
    expect(result.issues).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("keeps 有人 as a pronoun-like character subject", () => {
    const result = evaluate("有人在敲门，灯塔熄灭从未发生过。");
    expect(result.issues).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("canon guard ASCII sentence terminators", () => {
  function evaluate(text: string) {
    return validateAgainstPreDivergenceCanon({
      textFields: [{ field: "prose", text }],
      storyMap: CANON_GUARD_PROBE_STORY_MAP,
      divergenceEventId: "event_4",
      pathState: CANON_GUARD_PROBE_PATH_STATE,
      policy: "strict",
    });
  }

  it("splits at ASCII periods so the speech subject stays short", () => {
    const result = evaluate("Tom mother said nothing.她哭喊，灯塔熄灭从未发生过。");
    expect(result.issues).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("hard-rejects a narrator negation in the following ASCII sentence", () => {
    const result = evaluate("Night fell. 灯塔熄灭从未发生过。");
    expect(result.issues).toHaveLength(1);
    expect(result.hardRejections[0]).toMatchObject({ title: "灯塔熄灭" });
  });

  it("does not split a decimal between two digits", () => {
    const result = evaluate("水位涨了3.5米，灯塔熄灭从未发生过。");
    expect(result.issues).toHaveLength(1);
  });
});

function quotedTexts(text: string): string[] {
  return findQuotedSpans(text).map((span) => text.slice(span.start, span.end));
}

describe("findQuotedSpans fail-closed policy", () => {
  it("pairs the same style across sentences inside one paragraph", () => {
    expect(quotedTexts("“甲。乙。”")).toEqual(["“甲。乙。”"]);
    expect(quotedTexts("「甲！乙？」")).toEqual(["「甲！乙？」"]);
  });

  it("keeps nested different styles as separate spans in document order", () => {
    const text = "“外『内』外”";
    expect(quotedTexts(text)).toEqual(["“外『内』外”", "『内』"]);
  });

  it("never pairs across paragraphs or across different styles", () => {
    expect(findQuotedSpans("“甲\n乙”")).toEqual([]);
    expect(findQuotedSpans("“甲」")).toEqual([]);
    expect(findQuotedSpans("“甲")).toEqual([]);
    expect(findQuotedSpans("甲”")).toEqual([]);
  });

  it("alternates ASCII double quotes inside one paragraph", () => {
    expect(quotedTexts('"甲" 和 "乙"')).toEqual(['"甲"', '"乙"']);
  });

  it("ignores an unmatched apostrophe but not an unmatched single opener", () => {
    expect(findQuotedSpans("海风’很冷")).toEqual([]);
    expect(hasUnpairedQuote("海风’很冷")).toBe(false);
    expect(findQuotedSpans("海风很冷，‘甲")).toEqual([]);
    expect(hasUnpairedQuote("海风很冷，‘甲")).toBe(true);
  });

  it("reports unclosed, stray and mismatched quotes to the caller", () => {
    expect(hasUnpairedQuote("“甲”")).toBe(false);
    expect(hasUnpairedQuote("“甲")).toBe(true);
    expect(hasUnpairedQuote("甲”")).toBe(true);
    expect(hasUnpairedQuote("“甲」")).toBe(true);
    expect(hasUnpairedQuote("“甲\n乙”")).toBe(true);
    // 关闭引号匹配更深的外层时，中间未匹配的开引号被丢弃且记为错配。
    const cleaned = "“外『内”";
    expect(quotedTexts(cleaned)).toEqual(["“外『内”"]);
    expect(hasUnpairedQuote(cleaned)).toBe(true);
  });

  it("records the offending sentence and the unpaired-quote flag", () => {
    const broken = validateAgainstPreDivergenceCanon({
      textFields: [
        { field: "prose", text: "夜色渐深，“灯塔熄灭从未发生过。" },
      ],
      storyMap: CANON_GUARD_PROBE_STORY_MAP,
      divergenceEventId: "event_4",
      pathState: CANON_GUARD_PROBE_PATH_STATE,
      policy: "strict",
    });
    expect(broken.hardRejections).toEqual([
      expect.objectContaining({
        eventId: "event_1",
        title: "灯塔熄灭",
        sentence: "夜色渐深，“灯塔熄灭从未发生过",
        unpairedQuote: true,
      }),
    ]);

    const clean = validateAgainstPreDivergenceCanon({
      textFields: [{ field: "prose", text: "灯塔熄灭从未发生过。" }],
      storyMap: CANON_GUARD_PROBE_STORY_MAP,
      divergenceEventId: "event_4",
      pathState: CANON_GUARD_PROBE_PATH_STATE,
      policy: "strict",
    });
    expect(clean.hardRejections[0]).toMatchObject({
      sentence: "灯塔熄灭从未发生过",
      unpairedQuote: false,
    });
  });

  it("keeps a valid nested quote as warning-only", () => {
    const result = validateAgainstPreDivergenceCanon({
      textFields: [
        {
          field: "prose",
          text: CANON_GUARD_DIALOGUE_LIE[CANON_GUARD_DIALOGUE_LIE.length - 1]!,
        },
      ],
      storyMap: CANON_GUARD_PROBE_STORY_MAP,
      divergenceEventId: "event_4",
      pathState: CANON_GUARD_PROBE_PATH_STATE,
      policy: "strict",
    });
    expect(result.issues).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
