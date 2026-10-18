import { describe, expect, it } from "vitest";

import {
  CONTINUATION_CONTEXT_BUDGET_EXCEEDED_CODE,
  ContinuationContextBudgetError,
} from "@/domain/continuation/context-assembler";
import { continuationErrorMessage } from "@/server/continuation/continuation-error";

function budgetError(neededChars = 24_432, maxChars = 24_000) {
  return new ContinuationContextBudgetError({
    neededChars,
    maxChars,
    message: `必需上下文段超过预算：需要 ${neededChars} 字符，maxChars=${maxChars}`,
  });
}

describe("continuationErrorMessage", () => {
  it("maps the typed budget error to plain Chinese with needed/max chars and next steps", () => {
    const message = continuationErrorMessage(budgetError(), "directions");

    expect(message).toContain("超过了当前上限");
    expect(message).toContain("24432");
    expect(message).toContain("24000");
    expect(message).toContain("无法生成方向");
    expect(message).toContain("换一个分歧瞬间");
    expect(message).toContain("让故事自由发展");
    expect(message).toContain("减少保留的结局 Anchor");
    expect(message).toContain("CONTINUATION_CONTEXT_MAX_CHARS");
    // 不再把内部术语直接透给界面。
    expect(message).not.toContain("必需上下文段超过预算");
  });

  it("also recognizes the stable code across a bundle boundary", () => {
    const message = continuationErrorMessage(
      {
        name: "ContinuationContextBudgetError",
        code: CONTINUATION_CONTEXT_BUDGET_EXCEEDED_CODE,
        neededChars: 30_000,
        maxChars: 20_000,
        message: "必需上下文段超过预算：需要 30000 字符，maxChars=20000",
      },
      "scene",
    );

    expect(message).toContain("30000");
    expect(message).toContain("20000");
    expect(message).toContain("无法生成场景");
  });

  it("maps a legacy plain Error with the old internal message to the same Chinese copy", () => {
    const message = continuationErrorMessage(
      new Error("必需上下文段超过预算：需要 24432 字符，maxChars=24000"),
      "directions",
    );
    expect(message).toContain("超过了当前上限");
    expect(message).toContain("24432");
    expect(message).not.toContain("必需上下文段超过预算");
  });
});
