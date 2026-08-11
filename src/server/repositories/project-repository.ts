import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  ProjectSchema,
  SourceSchema,
  type Project,
  type Source,
} from "@/domain/schemas";
import { prepareSourceImport } from "@/domain/source/normalize-source";
import { getDatabase } from "@/server/db/client";
import { projects, sources } from "@/server/db/schema";

const CreateProjectInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    createdAt: z.iso.datetime().optional(),
  })
  .strict();

export type ImportProjectSourceResult = {
  source: Source;
  disposition: "created" | "existing";
};

export function createProject(input: {
  title: string;
  createdAt?: string;
}): Project {
  const parsed = CreateProjectInputSchema.parse(input);
  const timestamp = parsed.createdAt ?? new Date().toISOString();
  const project = ProjectSchema.parse({
    id: `project_${randomUUID()}`,
    title: parsed.title,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  getDatabase().insert(projects).values(project).run();
  return project;
}

export function getProject(projectId: string): Project | null {
  const row = getDatabase()
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  return row ? ProjectSchema.parse(row) : null;
}

export function listProjects(): Project[] {
  return getDatabase()
    .select()
    .from(projects)
    .orderBy(desc(projects.createdAt))
    .all()
    .map((row) => ProjectSchema.parse(row));
}

export function importProjectSource(input: {
  projectId: string;
  fileName: string;
  bytes: Uint8Array;
  createdAt?: string;
}): ImportProjectSourceResult {
  const project = getProject(input.projectId);
  if (!project) throw new Error("找不到指定的 Project");

  const prepared = prepareSourceImport({
    fileName: input.fileName,
    bytes: input.bytes,
  });
  const database = getDatabase();

  return database.transaction((transaction) => {
    const existing = transaction
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.projectId, project.id),
          eq(sources.contentHash, prepared.contentHash),
        ),
      )
      .get();

    if (existing) {
      return { source: parseSourceRow(existing), disposition: "existing" };
    }

    const source = SourceSchema.parse({
      id: `source_${randomUUID()}`,
      projectId: project.id,
      ...prepared,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
    const inserted = transaction
      .insert(sources)
      .values({
        id: source.id,
        projectId: source.projectId,
        title: source.title,
        originalText: source.originalText,
        normalizedText: source.normalizedText,
        contentHash: source.contentHash,
        sectionsJson: JSON.stringify(source.sections),
        createdAt: source.createdAt,
      })
      .onConflictDoNothing({
        target: [sources.projectId, sources.contentHash],
      })
      .returning({ id: sources.id })
      .get();

    if (inserted) return { source, disposition: "created" };

    const concurrent = transaction
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.projectId, project.id),
          eq(sources.contentHash, source.contentHash),
        ),
      )
      .get();
    if (!concurrent) throw new Error("Source 写入失败");

    return { source: parseSourceRow(concurrent), disposition: "existing" };
  });
}

export function listProjectSources(projectId: string): Source[] {
  return getDatabase()
    .select()
    .from(sources)
    .where(eq(sources.projectId, projectId))
    .orderBy(desc(sources.createdAt), desc(sources.id))
    .all()
    .map(parseSourceRow);
}

export function getProjectSource(
  projectId: string,
  sourceId: string,
): Source | null {
  const row = getDatabase()
    .select()
    .from(sources)
    .where(and(eq(sources.projectId, projectId), eq(sources.id, sourceId)))
    .get();

  return row ? parseSourceRow(row) : null;
}

function parseSourceRow(row: typeof sources.$inferSelect): Source {
  return SourceSchema.parse({
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    originalText: row.originalText,
    normalizedText: row.normalizedText,
    contentHash: row.contentHash,
    sections: JSON.parse(row.sectionsJson),
    createdAt: row.createdAt,
  });
}
