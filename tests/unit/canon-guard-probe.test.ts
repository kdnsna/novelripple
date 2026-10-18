import { describe, expect, it } from "vitest";

import {
  CANON_GUARD_LEGITIMATE,
  CANON_GUARD_NEUTRAL_PROSE,
  CANON_GUARD_PROBE_PATH_STATE,
  CANON_GUARD_PROBE_STORY_MAP,
  CANON_GUARD_SHOULD_REJECT,
  computeCanonGuardProbeStats,
} from "../helpers/canon-guard-probe";
import { validateAgainstPreDivergenceCanon } from "@/domain/invariants/validate-continuation";

/**
 * 标注探针：断言硬拒绝的假阳性上限，并记录召回率。
 *
 * 测试名与 inline snapshot 都包含测得数字，便于在没有额外脚本时直接读取。
 * 这些句子全部是自建短句，不含任何作品原文。
 */
const stats = computeCanonGuardProbeStats();

describe("canon guard labeled probe", () => {
  it(
    `catch ${stats.caught}/11, hard false-reject ${stats.hardFalseRejects}/17, ` +
      `warnings ${stats.warningsOnLegitimate}/17, neutral ${
        stats.neutralHardRejects
      }`,
    () => {
      // 合法续写是硬约束：一条都不能被硬拒绝。
      expect(stats.hardFalseRejects).toBe(0);
      expect(stats.neutralHardRejects).toBe(0);
      // 每一类都应至少产生低置信 warning，而不是静默丢失信号。
      expect(stats.warningsOnLegitimate).toBeGreaterThan(0);
      // 探针输入没有变化时结果必须确定。
      expect(computeCanonGuardProbeStats()).toEqual(stats);
      expect(stats).toMatchInlineSnapshot(`
        {
          "caught": 5,
          "hardFalseRejects": 0,
          "neutralHardRejects": 0,
          "warningsOnLegitimate": 8,
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
    expect(CANON_GUARD_SHOULD_REJECT).toHaveLength(11);
    expect(CANON_GUARD_LEGITIMATE).toHaveLength(17);
    expect(CANON_GUARD_NEUTRAL_PROSE.length).toBeGreaterThan(200);
  });
});
