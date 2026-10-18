import { z } from "zod";

/**
 * 后台任务（job）只保存任务控制信息，不保存 Source 正文、Prompt 或模型输出。
 * input_json 只允许稳定 ID；progress_json 只允许阶段与计数。
 */
export const JobKindSchema = z.enum(["story_map_generation"]);

/**
 * 启动 Story Map 生成的显式模式：
 * - resume（默认）：最新任务 failed / interrupted 时沿用它的 run group，复用检查点与预算；
 * - fresh：总是新建 run group，不读旧检查点，预算从 0 开始。
 */
export const StoryMapGenerationStartModeSchema = z.enum(["resume", "fresh"]);

/**
 * 模型调用预算耗尽的固定脱敏文案。
 * 与 `STORY_MAP_MAX_MODEL_CALLS` 的原始错误分开：UI 依据该常量把
 * “从头重新生成”作为明确出路，且不泄露 Prompt、原文或底层异常。
 */
export const STORY_MAP_BUDGET_EXHAUSTED_ERROR =
  "本次生成已用完模型调用预算（STORY_MAP_MAX_MODEL_CALLS）；请选择“从头重新生成”开始新的预算。";

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
]);

/** Story Map 生成阶段；UI 顺序与名称由此单一枚举派生。 */
export const STORY_MAP_JOB_STAGES = [
  "queued",
  "chunking",
  "extract",
  "glean",
  "names",
  "endings",
  "merge",
  "saving",
] as const;

export const StoryMapJobStageSchema = z.enum(STORY_MAP_JOB_STAGES);

export const JobProgressSchema = z
  .object({
    stage: StoryMapJobStageSchema,
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** 续跑时已完整复用的分块数；只在 chunking / extract / glean 阶段出现。 */
    reusedChunks: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((progress) => progress.completed <= progress.total, {
    message: "Job progress completed 不能超过 total",
    path: ["completed"],
  })
  .refine(
    (progress) =>
      progress.reusedChunks === undefined ||
      progress.reusedChunks <= progress.total,
    {
      message: "Job progress reusedChunks 不能超过 total",
      path: ["reusedChunks"],
    },
  );

export const JobIdSchema = z
  .string()
  .regex(
    /^job_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "无效的 Job ID",
  );

/** 任务输入只保存 ID，绝不保存原文。 */
export const StoryMapGenerationJobInputSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    /** 同一逻辑生成的多次 attempt 共享；新生成使用全新 group，重试沿用上一 attempt。 */
    runGroupId: z.string().min(1).max(200).optional(),
    /** 重试只追加新行，并显式指向被重试的上一 attempt。 */
    retryOfJobId: JobIdSchema.optional(),
  })
  .strict();

export const JobInputSchema = StoryMapGenerationJobInputSchema;

export const StoryMapGenerationJobResultSchema = z
  .object({
    artifactId: z.string().min(1).max(200),
  })
  .strict();

export const JobResultSchema = StoryMapGenerationJobResultSchema;

export const JobSchema = z
  .object({
    id: JobIdSchema,
    projectId: z.string().min(1),
    kind: JobKindSchema,
    input: JobInputSchema,
    status: JobStatusSchema,
    progress: JobProgressSchema,
    result: JobResultSchema.nullable(),
    error: z.string().min(1).max(500).nullable(),
    /** 本 attempt 的模型调用数；跨 attempt 预算按同一 run group 求和。 */
    modelCalls: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    heartbeatAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.status === "queued" || job.status === "running") {
      if (job.result !== null) {
        context.addIssue({
          code: "custom",
          path: ["result"],
          message: "未完成的任务不能有 result",
        });
      }
      if (job.error !== null) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "未完成的任务不能有 error",
        });
      }
    }

    if (job.status === "succeeded") {
      if (job.result === null) {
        context.addIssue({
          code: "custom",
          path: ["result"],
          message: "succeeded 任务必须包含 result",
        });
      }
      if (job.error !== null) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "succeeded 任务不能有 error",
        });
      }
    }

    if (job.status === "failed" || job.status === "interrupted") {
      if (job.error === null) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "失败或中断的任务必须包含失败原因",
        });
      }
      if (job.result !== null) {
        context.addIssue({
          code: "custom",
          path: ["result"],
          message: "失败或中断的任务不能有 result",
        });
      }
    }
  });

export type JobKind = z.infer<typeof JobKindSchema>;
export type StoryMapGenerationStartMode = z.infer<
  typeof StoryMapGenerationStartModeSchema
>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type StoryMapJobStage = z.infer<typeof StoryMapJobStageSchema>;
export type JobProgress = z.infer<typeof JobProgressSchema>;
export type JobInput = z.infer<typeof JobInputSchema>;
export type JobResult = z.infer<typeof JobResultSchema>;
export type Job = z.infer<typeof JobSchema>;
