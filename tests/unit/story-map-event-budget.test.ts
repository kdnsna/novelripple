import { describe, expect, it } from "vitest";

import {
  computeEventBudget,
  EVENT_BUDGET_FLOOR,
  EVENT_BUDGET_PER_SQRT_CHAR,
  EVENT_FOLD_TRIGGER_PER_SQRT_CHAR,
} from "@/domain/story-map/event-budget";

describe("Story Map event budget", () => {
  it("uses the documented sub-linear coefficients and floor", () => {
    expect(EVENT_BUDGET_PER_SQRT_CHAR).toBe(0.2);
    expect(EVENT_FOLD_TRIGGER_PER_SQRT_CHAR).toBe(0.25);
    expect(EVENT_BUDGET_FLOOR).toBe(3);

    expect(computeEventBudget(10_000, 20)).toEqual({
      coreTextChars: 10_000,
      eventCount: 20,
      expectedEvents: 20,
      foldAbove: 25,
      foldRequired: false,
    });
  });

  it("floors expectedEvents and foldAbove at 3 for short core text", () => {
    expect(computeEventBudget(10, 1)).toEqual({
      coreTextChars: 10,
      eventCount: 1,
      expectedEvents: 3,
      foldAbove: 3,
      foldRequired: false,
    });
    expect(computeEventBudget(10, 4).foldRequired).toBe(true);
  });

  it("requires folding only above the rounded threshold", () => {
    // 2500 字符：expectedEvents = round(10) = 10；foldAbove = round(12.5) = 13。
    expect(computeEventBudget(2_500, 13)).toMatchObject({
      expectedEvents: 10,
      foldAbove: 13,
      foldRequired: false,
    });
    expect(computeEventBudget(2_500, 14)).toMatchObject({
      expectedEvents: 10,
      foldAbove: 13,
      foldRequired: true,
    });
    expect(computeEventBudget(10_000, 25).foldRequired).toBe(false);
    expect(computeEventBudget(10_000, 26).foldRequired).toBe(true);
  });
});
