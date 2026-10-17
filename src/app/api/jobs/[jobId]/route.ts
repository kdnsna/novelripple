import { JobIdSchema } from "@/domain/schemas";
import { ensureJobRecovery } from "@/server/jobs/job-recovery";
import { toJobView } from "@/server/jobs/job-view";
import { getJob } from "@/server/repositories/job-repository";

export const dynamic = "force-dynamic";

/**
 * 只返回脱敏后的任务视图：status / progress / result / error。
 * 不返回 input、heartbeat、Prompt、模型输出或任何原文。
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const parsed = JobIdSchema.safeParse((await context.params).jobId);
  if (!parsed.success) {
    return Response.json({ error: "无效的 Job ID" }, { status: 400 });
  }

  ensureJobRecovery();
  const job = getJob(parsed.data);
  if (!job) {
    return Response.json({ error: "找不到指定的 Job" }, { status: 404 });
  }

  return Response.json(toJobView(job), {
    headers: { "Cache-Control": "no-store" },
  });
}
