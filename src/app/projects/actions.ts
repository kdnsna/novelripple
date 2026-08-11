"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import {
  type ContinuationDirectionsArtifact,
  type ContinuationSceneArtifact,
  StoryMapRevisionChangeSchema,
  type ImpactPlanArtifact,
  type Worldline,
} from "@/domain/schemas";
import {
  generateConfiguredContinuationDirections,
  generateConfiguredContinuationScene,
} from "@/server/continuation/generate-configured-continuation";
import { generateConfiguredImpactPlan } from "@/server/ripple/generate-configured-impact-plan";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import {
  confirmStoryMapArtifact,
  createStoryMapRevision,
} from "@/server/repositories/story-map-artifact-repository";
import { acceptImpactPlan } from "@/server/repositories/ripple-repository";
import { generateConfiguredStoryMap } from "@/server/story-map/generate-configured-story-map";

const ProjectTitleSchema = z.string().trim().min(1).max(200);
const ProjectIdSchema = z.string().min(1);

export type ProjectActionState = { error: string | null };
export type StoryMapActionResult =
  | { ok: true; artifactId: string }
  | { ok: false; error: string };
export type RipplePreviewActionResult =
  | { ok: true; artifact: ImpactPlanArtifact }
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

export async function generateStoryMapAction(
  projectId: string,
  sourceId: string,
  _previousState: ProjectActionState,
  _formData: FormData,
): Promise<ProjectActionState> {
  void _previousState;
  void _formData;
  const parsed = z
    .object({ projectId: ProjectIdSchema, sourceId: z.string().min(1) })
    .strict()
    .safeParse({ projectId, sourceId });
  if (!parsed.success) return { error: "Story Map 生成参数无效。" };

  let artifactId: string;
  try {
    artifactId = (
      await generateConfiguredStoryMap({
        projectId: parsed.data.projectId,
        sourceId: parsed.data.sourceId,
      })
    ).artifact.id;
  } catch (error) {
    return { error: storyMapGenerationErrorMessage(error) };
  }

  const query = new URLSearchParams({
    source: parsed.data.sourceId,
    artifact: artifactId,
    generated: "created",
  });
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
    return { ok: false, error: "Story Map 修改参数无效。" };
  }

  try {
    const artifact = createStoryMapRevision(parsed.data);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, artifactId: artifact.id };
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
    return { ok: false, error: "Story Map 确认参数无效。" };
  }

  try {
    const artifact = confirmStoryMapArtifact(parsed.data);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, artifactId: artifact.id };
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
    return { ok: false, error: continuationErrorMessage(error) };
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
    return { ok: false, error: continuationErrorMessage(error) };
  }
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

function storyMapGenerationErrorMessage(error: unknown): string {
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

function continuationErrorMessage(error: unknown): string {
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
    "M0 只允许一个后续场景，不能更换已生成方向",
    "Mock AI 只支持 ripple-001 的标准 rerouted Worldline",
    "Mock AI 找不到选中的 ripple-001 后续方向",
    "Mock AI 只能用于测试或本地验证",
  ];
  return safeMessages.includes(error.message)
    ? error.message
    : "Continuation 生成失败；结构化输出未通过校验，未保存 Artifact。";
}

function storyMapRevisionErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Story Map 修改失败，未创建 revision。";
  const safeFragments = [
    "Story Map 版本已更新",
    "Story Map 校验失败",
    "Evidence 不属于指定事件",
    "Evidence 已确认",
    "找不到指定的 Story Map",
    "找不到指定的 Story Edge",
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
    "严格模式必须至少选择",
    "开放模式不能选择",
    "找不到 Ending Candidate",
    "严格模式锚点不兼容",
    "Mock AI 只接受公开基准故事 ripple-001",
    "Mock AI 找不到匹配",
    "Mock AI 的 Anchor 选择不匹配",
  ];
  return safeFragments.some((fragment) => error.message.includes(fragment))
    ? error.message
    : "Ripple 操作失败，未改变 Worldline。";
}
