import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION,
  MAX_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION,
  RIPPLE_SUGGESTION_MAX_MODEL_CALLS_PER_BATCH,
  RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV,
  resolveRippleSuggestionMaxBatches,
  rippleSuggestionModelCallLimit,
} from "@/server/ripple/ripple-suggestion-limits";

const previousValue =
  process.env[RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV];

afterEach(() => {
  if (previousValue === undefined) {
    delete process.env[RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV];
  } else {
    process.env[RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV] =
      previousValue;
  }
});

function setEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV];
  } else {
    process.env[RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION_ENV] = value;
  }
}

describe("Ripple Suggestion batch limit env", () => {
  it("uses the default when the env is unset, empty or whitespace", () => {
    setEnv(undefined);
    expect(resolveRippleSuggestionMaxBatches()).toBe(
      DEFAULT_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION,
    );
    setEnv("");
    expect(resolveRippleSuggestionMaxBatches()).toBe(
      DEFAULT_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION,
    );
    setEnv("   ");
    expect(resolveRippleSuggestionMaxBatches()).toBe(
      DEFAULT_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION,
    );
  });

  it.each([
    ["1", 1],
    ["5", 5],
    [" 7 ", 7],
    ["20", MAX_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION],
    ["10", 10],
  ])("accepts plain decimal digits %j", (raw, expected) => {
    setEnv(raw);
    expect(resolveRippleSuggestionMaxBatches()).toBe(expected);
  });

  it.each(["0", "00", "0x2", "1e0", "+3", " 2.0", "2.5", "-1", "01", "abc"])(
    "rejects non-plain-decimal env %j before any model call",
    (raw) => {
      setEnv(raw);
      expect(() => resolveRippleSuggestionMaxBatches()).toThrow(
        "必须是正整数",
      );
    },
  );

  it.each(["21", "100", "999"])(
    "fails closed when the env %j exceeds the maximum",
    (raw) => {
      setEnv(raw);
      expect(() => resolveRippleSuggestionMaxBatches()).toThrow(
        `不能超过 ${MAX_RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION}`,
      );
    },
  );

  it("applies the same integer and maximum checks to an explicit override", () => {
    expect(resolveRippleSuggestionMaxBatches(2)).toBe(2);
    expect(resolveRippleSuggestionMaxBatches(20)).toBe(20);
    expect(() => resolveRippleSuggestionMaxBatches(0)).toThrow("必须是正整数");
    expect(() => resolveRippleSuggestionMaxBatches(2.5)).toThrow(
      "必须是正整数",
    );
    expect(() => resolveRippleSuggestionMaxBatches(21)).toThrow(
      "不能超过",
    );
  });

  it("derives the model-call ceiling from the batch cap", () => {
    // 每批最坏 initial 4 次（1 首调 + 2 空响应 + 1 瞬时网络）
    // + repair 2 次（1 修复 + 0 空响应 + 1 瞬时网络）= 6。
    expect(RIPPLE_SUGGESTION_MAX_MODEL_CALLS_PER_BATCH).toBe(6);
    expect(rippleSuggestionModelCallLimit(1)).toBe(6);
    expect(rippleSuggestionModelCallLimit(5)).toBe(30);
    expect(rippleSuggestionModelCallLimit(20)).toBe(120);
  });
});
