import { describe, expect, it } from "vitest";

import {
  CONTINUATION_CONTEXT_BUDGET_EXCEEDED_CODE,
  ContinuationContextBudgetError,
} from "@/domain/continuation/context-assembler";
import {
  CanonGuardRejectionError,
  readContinuationCanonGuardPolicy,
} from "@/server/continuation/canon-guard";
import { continuationErrorMessage } from "@/server/continuation/continuation-error";

function budgetError(neededChars = 24_432, maxChars = 24_000) {
  return new ContinuationContextBudgetError({
    neededChars,
    maxChars,
    message: `必需上下文段超过预算：需要 ${neededChars} 字符，maxChars=${maxChars}`,
  });
}

describe("readContinuationCanonGuardPolicy", () => {
  it("defaults to strict and accepts the three documented values", () => {
    expect(readContinuationCanonGuardPolicy({})).toBe("strict");
    expect(
      readContinuationCanonGuardPolicy({ CONTINUATION_CANON_GUARD: " " }),
    ).toBe("strict");
    expect(
      readContinuationCanonGuardPolicy({ CONTINUATION_CANON_GUARD: "warn" }),
    ).toBe("warn");
    expect(
      readContinuationCanonGuardPolicy({ CONTINUATION_CANON_GUARD: "off" }),
    ).toBe("off");
  });

  it("fails closed on unknown values", () => {
    expect(() =>
      readContinuationCanonGuardPolicy({
        CONTINUATION_CANON_GUARD: "STRICT",
      }),
    ).toThrow("CONTINUATION_CANON_GUARD");
  });
});

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
    expect(message).toContain("自动裁剪");
    expect(message).not.toContain("停用或软删除");
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

  it("maps a hard canon rejection to the specific Chinese message without prose", () => {
    const message = continuationErrorMessage(
      new CanonGuardRejectionError(["铜门被打开"]),
      "scene",
    );
    expect(message).toBe(
      "生成内容明确否定了分歧前已确认的原著事件「铜门被打开」，已拒绝且未保存；请重试或换一批。",
    );
    expect(message).not.toContain("Structured generation failed");
  });

  it("surfaces an invalid canon guard policy instead of silently disabling it", () => {
    const message = continuationErrorMessage(
      new Error("环境变量 CONTINUATION_CANON_GUARD 只能是 strict、warn 或 off"),
      "directions",
    );
    expect(message).toContain("CONTINUATION_CANON_GUARD");
    expect(message).toContain("strict");
  });
});
