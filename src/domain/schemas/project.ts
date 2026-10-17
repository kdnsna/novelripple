import { z } from "zod";

/** 项目标识的唯一校验：Server Action、路由查询参数与仓库调用共用。 */
export const ProjectIdSchema = z.string().min(1);

export const ProjectSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;
