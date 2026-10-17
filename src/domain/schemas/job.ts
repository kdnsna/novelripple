import { z } from "zod";

/**
 * 后台任务（job）只保存任务控制信息，不保存 Source 正文、Prompt 或模型输出。
 * input_json 只允许稳定 ID；progress_json 只允许阶段与计数。
 */
export const JobKindSchema = z.enum(["story_map_generation"]);

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
  })
  .strict()
  .refine((progress) => progress.completed <= progress.total, {
    message: "Job progress completed 不能超过 total",
    path: ["completed"],
  });

/** 任务输入只保存 ID，绝不保存原文。 */
export const StoryMapGenerationJobInputSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
  })
  .strict();

export const JobInputSchema = StoryMapGenerationJobInputSchema;

export const StoryMapGenerationJobResultSchema = z
  .object({
    artifactId: z.string().min(1).max(200),
  })
  .strict();

export const JobResultSchema = StoryMapGenerationJobResultSchema;

export const JobIdSchema = z
  .string()
  .regex(
    /^job_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "无效的 Job ID",
  );

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
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type StoryMapJobStage = z.infer<typeof StoryMapJobStageSchema>;
export type JobProgress = z.infer<typeof JobProgressSchema>;
export type JobInput = z.infer<typeof JobInputSchema>;
export type JobResult = z.infer<typeof JobResultSchema>;
export type Job = z.infer<typeof JobSchema>;
