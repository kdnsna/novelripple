import { z } from "zod";

import { isContinuationContextBudgetError } from "@/domain/continuation/context-assembler";
import { CONTINUATION_CONTEXT_MAX_CHARS_ENV } from "@/server/continuation/continuation-limits";

export type ContinuationGenerationStage = "directions" | "scene";

/**
 * 服务端边界统一把 Continuation 异常映射成可展示的字符串。
 *
 * 预算溢出使用类型化错误里的 needed/maxChars 与稳定 code，返回普通中文
 * 说明和可执行出路；不把内部的“必需上下文段超过预算：…”直接透给界面。
 */
export function continuationErrorMessage(
  error: unknown,
  stage: ContinuationGenerationStage = "directions",
): string {
  if (isContinuationContextBudgetError(error)) {
    const target = stage === "scene" ? "场景" : "方向";
    return [
      `续写所需的基础上下文（世界线设定、相关原著事件、结局约束）超过了当前上限（需要约 ${error.neededChars} 字，上限 ${error.maxChars} 字），无法生成${target}。`,
      "接下来可以：",
      "• 换一个分歧瞬间，或改用「让故事自由发展」（开放模式通常更短）；",
      "• 减少保留的结局 Anchor；",
      `• 若由部署方配置，可提高环境变量 ${CONTINUATION_CONTEXT_MAX_CHARS_ENV} 后重试。`,
    ].join("\n");
  }
  if (error instanceof z.ZodError) {
    return "AI 配置不完整：请检查模型与结构化输出模式。";
  }
  if (!(error instanceof Error)) {
    return "Continuation 生成失败，未保存 Artifact。";
  }
  const safeMessages = [
    "Continuation 只能从 active Worldline 生成",
    "Worldline 未绑定 accepted Impact Plan",
    "Worldline 未绑定 confirmed Story Map 基线",
    "找不到 Worldline 对应的不可变 Source",
    "找不到当前 Worldline 的后续方向 Artifact",
    "找不到选中的后续方向",
    "父场景不属于当前 Worldline",
    "后续场景父节点与方向批次不一致",
    "后续场景深度必须等于父场景深度加一",
    "根场景深度必须为 1",
    "Mock AI 只支持 ripple-001 的标准 rerouted Worldline",
    "Mock AI 找不到选中的 ripple-001 后续方向",
    "Mock AI 找不到当前路径的父场景",
    "Mock AI 只能用于测试或本地验证",
  ];
  if (safeMessages.includes(error.message)) return error.message;
  // 兼容仍抛出旧字符串错误的路径：同样给出可执行出路，不透传内部术语。
  if (
    error.message.includes("必需上下文段超过预算") ||
    error.message.includes("必需上下文段与最新场景超过预算")
  ) {
    const match = /需要 (\d+) 字符，maxChars=(\d+)/.exec(error.message);
    const neededChars = match ? Number(match[1]) : undefined;
    const maxChars = match ? Number(match[2]) : undefined;
    if (
      neededChars !== undefined &&
      maxChars !== undefined &&
      Number.isFinite(neededChars) &&
      Number.isFinite(maxChars)
    ) {
      return continuationErrorMessage(
        {
          code: "continuation_context_budget_exceeded",
          neededChars,
          maxChars,
          message: error.message,
        },
        stage,
      );
    }
  }
  if (error.message.includes(CONTINUATION_CONTEXT_MAX_CHARS_ENV)) {
    return error.message;
  }
  return "Continuation 生成失败；结构化输出未通过校验，未保存 Artifact。";
}
