import { z } from "zod";

/**
 * Story Map 生成失败消息的唯一脱敏出口。
 * 只放行已知安全消息；其他错误一律替换为固定文案，
 * 绝不把模型输出、Prompt、原文或底层异常写进 job.error。
 */
export function storyMapGenerationErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "AI 配置不完整：请设置供应商、模型与结构化输出模式。";
  }
  if (!(error instanceof Error)) return "Story Map 生成失败，未保存 Artifact。";
  const safeMessages = [
    "找不到指定的 Source",
    "Mock AI 只能用于测试或本地验证",
    "Mock AI 只接受公开基准故事 ripple-001",
  ];
  return safeMessages.includes(error.message)
    ? error.message
    : "Story Map 生成失败，未保存 Artifact。";
}
