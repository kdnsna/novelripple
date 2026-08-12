import Link from "next/link";
import { notFound } from "next/navigation";

import { PersistedSourceReader } from "@/components/project/persisted-source-reader";
import { SourceImportForm } from "@/components/project/source-import-form";
import { StoryMapGenerationForm } from "@/components/project/story-map-generation-form";
import { StoryMapReviewWorkspace } from "@/components/story-workspace/story-map-review-workspace";
import { deriveStoryMapReview } from "@/domain/review/derive-story-map-review";
import {
  deriveEvidenceUnits,
  sourceReferenceForUnit,
} from "@/domain/source/evidence-units";
import { listProjectContinuationArtifacts } from "@/server/repositories/continuation-repository";
import {
  getProject,
  getProjectSource,
  listProjectSources,
} from "@/server/repositories/project-repository";
import {
  getStoryMapArtifact,
  listStoryMapArtifactsForSource,
} from "@/server/repositories/story-map-artifact-repository";
import {
  listImpactPlanArtifactsForStoryMap,
  listProjectWorldlines,
} from "@/server/repositories/ripple-repository";

export const dynamic = "force-dynamic";

type ProjectPageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{
    source?: string | string[];
    artifact?: string | string[];
    imported?: string | string[];
    generated?: string | string[];
  }>;
};

export default async function ProjectPage({
  params,
  searchParams,
}: ProjectPageProps) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const project = getProject(projectId);
  if (!project) notFound();

  const projectSources = listProjectSources(project.id);
  const selectedSourceId = singleValue(query.source);
  const selectedSource = selectedSourceId
    ? getProjectSource(project.id, selectedSourceId)
    : projectSources[0] ?? null;
  const imported = singleValue(query.imported);
  const generated = singleValue(query.generated);
  const storyMapArtifacts = selectedSource
    ? listStoryMapArtifactsForSource(project.id, selectedSource.id)
    : [];
  const selectedArtifactId = singleValue(query.artifact);
  const requestedArtifact = selectedArtifactId
    ? getStoryMapArtifact(selectedArtifactId)
    : null;
  const selectedArtifact =
    requestedArtifact?.projectId === project.id &&
    requestedArtifact.sourceId === selectedSource?.id
      ? requestedArtifact
      : storyMapArtifacts[0] ?? null;
  const selectedWorldlines = selectedArtifact
    ? listProjectWorldlines(project.id).filter(
        (worldline) =>
          worldline.baseStoryMapArtifactId === selectedArtifact.id,
      )
    : [];
  const selectedImpactPlanArtifacts = selectedArtifact
    ? listImpactPlanArtifactsForStoryMap(project.id, selectedArtifact.id)
    : [];
  const selectedWorldlineIds = new Set(
    selectedWorldlines.map((worldline) => worldline.id),
  );
  const selectedContinuationArtifacts = selectedArtifact
    ? listProjectContinuationArtifacts(project.id).filter((artifact) =>
        selectedWorldlineIds.has(artifact.worldlineId),
      )
    : [];

  return (
    <main className="foundation-shell">
      <nav className="foundation-nav">
        <Link className="brand-lockup" href="/">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>NovelRipple</strong>
            <small>故事涟漪</small>
          </span>
        </Link>
        <Link className="quiet-link" href="/">
          所有项目
        </Link>
      </nav>

      <header className="project-heading">
        <div>
          <span className="eyebrow">故事项目</span>
          <h1>{project.title}</h1>
        </div>
        <span>{projectSources.length} 个 Source 版本</span>
      </header>

      {imported === "created" ? (
        <p className="import-status" role="status">
          Source 导入成功，原文已作为不可变版本保存。
        </p>
      ) : imported === "existing" ? (
        <p className="import-status" role="status">
          相同内容此前已导入，已打开现有 Source。
        </p>
      ) : generated === "created" ? (
        <p className="import-status" role="status">
          Story Map 已通过 Schema、Evidence 和领域校验，并保存为新的 draft Artifact。
        </p>
      ) : null}

      {selectedArtifact && selectedSource ? (
        <>
          <div className="workspace-context-bar">
            <nav aria-label="Source 版本">
              {projectSources.map((source, index) => (
                <Link
                  className={source.id === selectedSource.id ? "active" : ""}
                  href={`/projects/${project.id}?source=${source.id}`}
                  key={source.id}
                >
                  Source 版本 v{projectSources.length - index}
                </Link>
              ))}
            </nav>
            <nav aria-label="Story Map revisions">
              {storyMapArtifacts.map((artifact) => (
                <Link
                  className={artifact.id === selectedArtifact.id ? "active" : ""}
                  href={`/projects/${project.id}?source=${selectedSource.id}&artifact=${artifact.id}`}
                  key={artifact.id}
                >
                  Map v{artifact.version}
                </Link>
              ))}
            </nav>
            <details>
              <summary>导入新 Source</summary>
              <div className="workspace-import-popover">
                <SourceImportForm projectId={project.id} />
              </div>
            </details>
          </div>
          <StoryMapReviewWorkspace
            artifact={selectedArtifact}
            derivedReview={deriveStoryMapReview(selectedArtifact, selectedSource)}
            evidenceOptions={deriveEvidenceUnits(selectedSource).map((unit) => ({
              id: unit.id,
              sectionId: unit.sectionId,
              sectionTitle:
                selectedSource.sections.find(
                  (section) => section.id === unit.sectionId,
                )?.title ?? unit.sectionId,
              start: unit.start,
              end: unit.end,
              text: unit.text,
              reference: sourceReferenceForUnit(unit),
            }))}
            initialContinuationArtifacts={selectedContinuationArtifacts}
            initialImpactPlanArtifacts={selectedImpactPlanArtifacts}
            initialWorldlines={selectedWorldlines}
            key={selectedArtifact.id}
            projectId={project.id}
            source={selectedSource}
          />
        </>
      ) : (
        <div className="project-grid">
        <aside className="foundation-card source-sidebar">
          <div>
            <span className="eyebrow">导入新版本</span>
            <h2>添加 Source</h2>
          </div>
          <SourceImportForm projectId={project.id} />

          {projectSources.length > 0 ? (
            <div className="source-version-list">
              <h3>已保存版本</h3>
              {projectSources.map((source, index) => (
                <Link
                  className={source.id === selectedSource?.id ? "active" : ""}
                  href={`/projects/${project.id}?source=${source.id}`}
                  key={source.id}
                >
                  <span>v{projectSources.length - index}</span>
                  <strong>{source.title}</strong>
                </Link>
              ))}
            </div>
          ) : null}

          {selectedSource ? (
            <StoryMapGenerationForm
              projectId={project.id}
              sourceId={selectedSource.id}
            />
          ) : null}
        </aside>

        {selectedSource ? (
          <PersistedSourceReader source={selectedSource} />
        ) : (
          <section className="foundation-card empty-source-state">
            <span className="eyebrow">等待原著</span>
            <h2>尚未导入 Source</h2>
            <p>请选择一个 UTF-8 编码的 txt 或 md 文件开始。</p>
          </section>
        )}
        </div>
      )}
    </main>
  );
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
