import { JobIdSchema, ProjectIdSchema } from "@/domain/schemas";
import { ensureJobRecovery } from "@/server/jobs/job-recovery";
import { toJobView } from "@/server/jobs/job-view";
import { getJob } from "@/server/repositories/job-repository";

export const dynamic = "force-dynamic";

/**
 * 只返回脱敏后的任务视图：status / progress / result / error。
 * 不返回 input、heartbeat、Prompt、模型输出或任何原文。
 *
 * 调用方必须带上 job 所属的 projectId；不存在与不属于本项目返回同一个
 * 404，避免用任务 id 探测其它项目。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const parsedJobId = JobIdSchema.safeParse((await context.params).jobId);
  if (!parsedJobId.success) {
    return Response.json({ error: "无效的 Job ID" }, { status: 400 });
  }

  const parsedProjectId = ProjectIdSchema.safeParse(
    new URL(request.url).searchParams.get("projectId"),
  );
  if (!parsedProjectId.success) {
    return Response.json({ error: "无效的项目 ID" }, { status: 400 });
  }

  ensureJobRecovery();
  const job = getJob(parsedJobId.data);
  if (!job || job.projectId !== parsedProjectId.data) {
    return Response.json({ error: "找不到指定的 Job" }, { status: 404 });
  }

  return Response.json(toJobView(job), {
    headers: { "Cache-Control": "no-store" },
  });
}
