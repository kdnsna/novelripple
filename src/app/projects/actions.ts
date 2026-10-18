"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";

import {
  SETTING_DELTA_FORBIDDEN_CHAR_MESSAGE,
  SettingDeltaSubjectSchema,
  ProjectIdSchema,
  StoryMapRevisionChangeSchema,
  StoryMapGenerationStartModeSchema,
  type ContinuationDirectionsArtifact,
  type ContinuationSceneArtifact,
  type ImpactPlanArtifact,
  type RippleSuggestionsArtifact,
  type SettingDeltaArtifact,
  type SettingDeltaLifecycleArtifact,
  type SettingDeltaLifecycleStatus,
  type StoryMapArtifact,
  type Worldline,
} from "@/domain/schemas";
import { isSettingDeltaError } from "@/domain/continuation/setting-delta-error";
import {
  generateConfiguredContinuationDirections,
  generateConfiguredContinuationScene,
} from "@/server/continuation/generate-configured-continuation";
import { continuationErrorMessage } from "@/server/continuation/continuation-error";
import {
  runStoryMapGenerationJob,
  startStoryMapGenerationJob,
} from "@/server/jobs/story-map-generation-job";
import {
  generateConfiguredImpactPlan,
  regenerateConfiguredImpactPlanFromFeedback,
} from "@/server/ripple/generate-configured-impact-plan";
import { generateConfiguredRippleSuggestions } from "@/server/ripple/generate-configured-ripple-suggestions";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import {
  createSettingDeltaArtifact,
  createSettingDeltaLifecycleArtifact,
} from "@/server/repositories/continuation-repository";
import {
  confirmStoryMapArtifact,
  createStoryMapRevision,
  quickConfirmStoryMapArtifact,
} from "@/server/repositories/story-map-artifact-repository";
import { acceptImpactPlan } from "@/server/repositories/ripple-repository";

const ProjectTitleSchema = z.string().trim().min(1).max(200);

/**
 * 部署边界（有意为之）：当前产品是本地单用户工具，没有会话/所有权概念，
 * 所有 action 以客户端传入的 projectId 直接读写本地 SQLite。
 * 若要部署为多用户或公网服务，必须在 action 层引入会话校验；
 * 见 docs/decisions/0001-web-first-foundation.md 的部署边界补充。
 */
export type ProjectActionState = { error: string | null };
export type StoryMapActionResult =
  | { ok: true; artifact: StoryMapArtifact }
  | { ok: false; error: string };
export type RipplePreviewActionResult =
  | { ok: true; artifact: ImpactPlanArtifact }
  | { ok: false; error: string };
export type RippleSuggestionsActionResult =
  | { ok: true; artifact: RippleSuggestionsArtifact }
  | { ok: false; error: string };
export type AcceptImpactPlanActionResult =
  | {
      ok: true;
      worldline: Worldline;
      acceptedArtifact: ImpactPlanArtifact;
    }
  | { ok: false; error: string };
export type ContinuationDirectionsActionResult =
  | { ok: true; artifact: ContinuationDirectionsArtifact }
  | { ok: false; error: string };
export type ContinuationSceneActionResult =
  | { ok: true; artifact: ContinuationSceneArtifact }
  | { ok: false; error: string };
export type SettingDeltaActionResult =
  | { ok: true; artifact: SettingDeltaArtifact }
  | { ok: false; error: string };
export type SettingDeltaLifecycleActionResult =
  | { ok: true; artifact: SettingDeltaLifecycleArtifact }
  | { ok: false; error: string };

export async function createProjectAction(
  _previousState: ProjectActionState,
  formData: FormData,
): Promise<ProjectActionState> {
  const parsed = ProjectTitleSchema.safeParse(formData.get("title"));
  if (!parsed.success) {
    return { error: "请输入 1–200 个字符的项目名称。" };
  }

  let projectId: string;
  try {
    projectId = createProject({ title: parsed.data }).id;
  } catch {
    return { error: "Project 创建失败，请重试。" };
  }

  revalidatePath("/");
  redirect(`/projects/${projectId}`);
}

export async function importProjectSourceAction(
  projectId: string,
  _previousState: ProjectActionState,
  formData: FormData,
): Promise<ProjectActionState> {
  const parsedProjectId = ProjectIdSchema.safeParse(projectId);
  const file = formData.get("sourceFile");
  if (!parsedProjectId.success || !(file instanceof File) || file.size === 0) {
    return { error: "请选择一个非空的 .txt 或 .md 文件。" };
  }

  let result: ReturnType<typeof importProjectSource>;
  try {
    result = importProjectSource({
      projectId: parsedProjectId.data,
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  } catch (error) {
    return { error: sourceImportErrorMessage(error) };
  }

  const query = new URLSearchParams({
    source: result.source.id,
    imported: result.disposition,
  });
  revalidatePath(`/projects/${parsedProjectId.data}`);
  redirect(`/projects/${parsedProjectId.data}?${query}`);
}

export async function startStoryMapGenerationAction(
  projectId: string,
  sourceId: string,
  mode: string,
  _previousState: ProjectActionState,
  _formData: FormData,
): Promise<ProjectActionState> {
  void _previousState;
  void _formData;
  const parsed = z
    .object({
      projectId: ProjectIdSchema,
      sourceId: z.string().min(1),
      mode: StoryMapGenerationStartModeSchema,
    })
    .strict()
    .safeParse({ projectId, sourceId, mode });
  if (!parsed.success) return { error: "Story Map 生成参数无效。" };

  let started: ReturnType<typeof startStoryMapGenerationJob>;
  try {
    started = startStoryMapGenerationJob(parsed.data);
  } catch {
    return { error: "Story Map 生成任务创建失败，请重试。" };
  }

  // 单飞：已有 queued/running 任务时只回到该任务，不启动第二个 Runner。
  if (started.created) {
    const jobId = started.job.id;
    after(() => runStoryMapGenerationJob(jobId));
  }

  const query = new URLSearchParams({ source: parsed.data.sourceId });
  revalidatePath(`/projects/${parsed.data.projectId}`);
  redirect(`/projects/${parsed.data.projectId}?${query}`);
}

const StoryMapRevisionActionInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    artifactId: z.string().min(1),
    change: StoryMapRevisionChangeSchema,
  })
  .strict();

export async function reviseStoryMapAction(
  input: unknown,
): Promise<StoryMapActionResult> {
  const parsed = StoryMapRevisionActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Story Map 修改数据无效：缺少必填字段或字段类型不正确。",
    };
  }

  try {
    // 不调用 revalidatePath：工作区用 history.replaceState 触发 ACTION_RESTORE
    // 导航刷新页面数据（Next 16 会 patch replaceState），避免同一 mutation 双往返。
    const artifact = createStoryMapRevision(parsed.data);
    return { ok: true, artifact };
  } catch (error) {
    return { ok: false, error: storyMapRevisionErrorMessage(error) };
  }
}

export async function confirmStoryMapAction(input: unknown): Promise<StoryMapActionResult> {
  const parsed = z
    .object({
      projectId: ProjectIdSchema,
      artifactId: z.string().min(1),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Story Map 确认数据无效：项目或 Artifact 标识缺失。",
    };
  }

  try {
    // 同上：确认后的页面刷新由工作区的 replaceState → ACTION_RESTORE 完成。
    const artifact = confirmStoryMapArtifact(parsed.data);
    return { ok: true, artifact };
  } catch (error) {
    return { ok: false, error: storyMapRevisionErrorMessage(error) };
  }
}

export async function quickStartRippleAction(
  input: unknown,
): Promise<StoryMapActionResult> {
  const parsed = z
    .object({
      projectId: ProjectIdSchema,
      artifactId: z.string().min(1),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "快速开始数据无效：项目或 Artifact 标识缺失。",
    };
  }

  try {
    // 与 confirm 相同：页面刷新由工作区的 replaceState → ACTION_RESTORE 完成。
    const artifact = quickConfirmStoryMapArtifact(parsed.data);
    return { ok: true, artifact };
  } catch (error) {
    return { ok: false, error: storyMapRevisionErrorMessage(error) };
  }
}

const GenerateRipplePreviewInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    storyMapArtifactId: z.string().min(1),
    eventId: z.string().min(1),
    type: z.enum(["prevent", "choice", "outcome"]),
    instruction: z.string().trim().min(1).max(500),
    mode: z.enum(["strict", "open"]),
    endingCandidateIds: z.array(z.string().min(1)),
  })
  .strict();

export async function generateRipplePreviewAction(
  input: unknown,
): Promise<RipplePreviewActionResult> {
  const parsed = GenerateRipplePreviewInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Ripple 参数无效，请检查分歧与 Anchor。" };
  }

  try {
    const generated = await generateConfiguredImpactPlan({
      projectId: parsed.data.projectId,
      storyMapArtifactId: parsed.data.storyMapArtifactId,
      divergence: {
        id: `divergence_${randomUUID()}`,
        eventId: parsed.data.eventId,
        type: parsed.data.type,
        instruction: parsed.data.instruction,
      },
      mode: parsed.data.mode,
      endingCandidateIds: parsed.data.endingCandidateIds,
    });
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, artifact: generated.artifact };
  } catch (error) {
    return { ok: false, error: rippleErrorMessage(error) };
  }
}

export async function generateRippleSuggestionsAction(
  input: unknown,
): Promise<RippleSuggestionsActionResult> {
  const parsed = z
    .object({
      projectId: ProjectIdSchema,
      storyMapArtifactId: z.string().min(1),
      // 只有显式「换一批」才携带；自动首次加载沿用服务端复用路径。
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Ripple Suggestions 参数无效。" };
  }
  try {
    const generated = await generateConfiguredRippleSuggestions(parsed.data);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, artifact: generated.artifact };
  } catch (error) {
    return { ok: false, error: rippleErrorMessage(error) };
  }
}

export async function regenerateRipplePreviewAction(
  input: unknown,
): Promise<RipplePreviewActionResult> {
  const parsed = z
    .object({
      projectId: ProjectIdSchema,
      priorCandidateArtifactId: z.string().min(1),
      feedback: z.string().trim().min(1).max(2_000),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "请输入一条明确反馈。" };
  }
  try {
    const generated = await regenerateConfiguredImpactPlanFromFeedback(
      parsed.data,
    );
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, artifact: generated.artifact };
  } catch (error) {
    return { ok: false, error: rippleErrorMessage(error) };
  }
}

export async function acceptImpactPlanAction(
  input: unknown,
): Promise<AcceptImpactPlanActionResult> {
  const parsed = z
    .object({
      projectId: ProjectIdSchema,
      candidateArtifactId: z.string().min(1),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "ImpactPlan 接受参数无效。" };
  }

  try {
    const accepted = acceptImpactPlan(parsed.data);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return {
      ok: true,
      worldline: accepted.worldline,
      acceptedArtifact: accepted.acceptedArtifact,
    };
  } catch (error) {
    return { ok: false, error: rippleErrorMessage(error) };
  }
}

export async function generateContinuationDirectionsAction(
  input: unknown,
): Promise<ContinuationDirectionsActionResult> {
  const parsed = z
    .object({
      projectId: ProjectIdSchema,
      worldlineId: z.string().min(1),
      parentSceneId: z.string().min(1).nullable().optional(),
      newBatch: z.boolean().optional(),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Continuation 方向参数无效。" };
  }

  try {
    const generated = await generateConfiguredContinuationDirections(
      parsed.data,
    );
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, artifact: generated.artifact };
  } catch (error) {
    return {
      ok: false,
      error: continuationErrorMessage(error, "directions"),
    };
  }
}

export async function generateContinuationSceneAction(
  input: unknown,
): Promise<ContinuationSceneActionResult> {
  const parsed = z
    .object({
      projectId: ProjectIdSchema,
      worldlineId: z.string().min(1),
      directionsArtifactId: z.string().min(1),
      selectedDirectionId: z.string().min(1),
      retry: z.boolean().optional(),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Continuation 场景参数无效。" };
  }

  try {
    const generated = await generateConfiguredContinuationScene(parsed.data);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, artifact: generated.artifact };
  } catch (error) {
    return { ok: false, error: continuationErrorMessage(error, "scene") };
  }
}

const AddSettingDeltaInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    worldlineId: z.string().min(1),
    anchorSceneId: z.string().min(1).nullable(),
    subject: SettingDeltaSubjectSchema,
    // 长度/不可见字符/NFC 由仓储层在规范化后统一校验，避免 Action 的原始
    // 长度上限抢先拒绝本应被规范化接受的文本。
    statement: z.string(),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export async function addSettingDeltaAction(
  input: unknown,
): Promise<SettingDeltaActionResult> {
  const parsed = AddSettingDeltaInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "设定增量参数无效：请检查主体、说明与锚点。",
    };
  }

  try {
    const artifact = createSettingDeltaArtifact(parsed.data);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, artifact };
  } catch (error) {
    return { ok: false, error: settingDeltaErrorMessage(error) };
  }
}

const SettingDeltaLifecycleInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    worldlineId: z.string().min(1),
    targetDeltaId: z.string().min(1),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

async function changeSettingDeltaLifecycleAction(
  status: SettingDeltaLifecycleStatus,
  input: unknown,
): Promise<SettingDeltaLifecycleActionResult> {
  const parsed = SettingDeltaLifecycleInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "设定增量操作参数无效：请刷新后重试。",
    };
  }

  try {
    const artifact = createSettingDeltaLifecycleArtifact({
      ...parsed.data,
      status,
    });
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, artifact };
  } catch (error) {
    return { ok: false, error: settingDeltaErrorMessage(error) };
  }
}

export async function deactivateSettingDeltaAction(
  input: unknown,
): Promise<SettingDeltaLifecycleActionResult> {
  return changeSettingDeltaLifecycleAction("deactivated", input);
}

export async function reactivateSettingDeltaAction(
  input: unknown,
): Promise<SettingDeltaLifecycleActionResult> {
  return changeSettingDeltaLifecycleAction("reactivated", input);
}

export async function deleteSettingDeltaAction(
  input: unknown,
): Promise<SettingDeltaLifecycleActionResult> {
  return changeSettingDeltaLifecycleAction("deleted", input);
}

function settingDeltaErrorMessage(error: unknown): string {
  // Zod 只可能来自主体/说明的 Schema 解析；错误文案本身就是面向读者的规则说明。
  if (error instanceof z.ZodError) {
    if (
      error.issues.some(
        (issue) => issue.message === SETTING_DELTA_FORBIDDEN_CHAR_MESSAGE,
      )
    ) {
      return SETTING_DELTA_FORBIDDEN_CHAR_MESSAGE;
    }
    return "设定增量参数无效：请检查主体、说明与锚点。";
  }
  // 仓储/领域检查统一抛 SettingDeltaError：message 已包含路径等规则相关
  // 上下文，直接透传，不再维护一份易漂移的字符串白名单。
  if (isSettingDeltaError(error)) return error.message;
  return "设定增量保存失败，未写入任何规则。";
}

function sourceImportErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Source 导入失败，请重试。";

  const safeMessages = [
    "仅支持 .txt 和 .md 文件",
    "文件不能超过 512 KB",
    "文件必须使用有效的 UTF-8 编码",
    "Source 内容不能为空",
    "找不到指定的 Project",
  ];
  return safeMessages.includes(error.message)
    ? error.message
    : "Source 导入失败，请重试。";
}

function storyMapRevisionErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "Story Map 修改数据无效：字段缺失或类型不正确，未创建 revision。";
  }
  if (!(error instanceof Error)) return "Story Map 修改失败，未创建 revision。";
  const safeFragments = [
    "Story Map 版本已更新",
    "Story Map 校验失败",
    "Evidence 不属于指定事件",
    "Evidence 不属于指定 Edge",
    "Evidence 已确认",
    "Edge Evidence 已确认",
    "人物已确认",
    "Ending Candidate 已确认",
    "Story Map 尚未完成必要核对",
    "找不到指定的 Story Map",
    "找不到指定的 Story Map Character",
    "找不到指定的 Story Map Event",
    "找不到指定的 Story Edge",
    "找不到指定的 Ending Candidate",
    "人物合并必须使用互不重复",
    "事件重排必须包含当前全部 Event",
    "修改没有产生变化",
  ];
  return safeFragments.some((fragment) => error.message.includes(fragment))
    ? error.message
    : "Story Map 修改失败，未创建 revision。";
}

function rippleErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "Ripple 结构化结果未通过 Schema 校验，未保存候选。";
  }
  if (!(error instanceof Error)) return "Ripple 操作失败，未改变 Worldline。";
  const safeFragments = [
    "只有 confirmed Story Map",
    "找不到可反馈的候选 Impact Plan",
    "反馈候选未绑定 confirmed Story Map",
    "反馈内容不能为空",
    "严格模式必须至少选择",
    "开放模式不能选择",
    "找不到 Ending Candidate",
    "严格模式锚点不兼容",
    "Mock AI 只接受公开基准故事 ripple-001",
    "Mock AI 找不到匹配",
    "Mock AI 的 Anchor 选择不匹配",
    "换一批上限",
    "模型调用上限",
    "还没有首批",
  ];
  return safeFragments.some((fragment) => error.message.includes(fragment))
    ? error.message
    : "Ripple 操作失败，未改变 Worldline。";
}
