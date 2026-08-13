import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    originalText: text("original_text").notNull(),
    normalizedText: text("normalized_text").notNull(),
    contentHash: text("content_hash").notNull(),
    sectionsJson: text("sections_json").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("sources_project_content_hash_unique").on(
      table.projectId,
      table.contentHash,
    ),
  ],
);

export const generationRuns = sqliteTable(
  "generation_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    worldlineId: text("worldline_id").references(
      (): AnySQLiteColumn => worldlines.id,
    ),
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text("status", { enum: ["pending", "succeeded", "failed"] })
      .notNull(),
    rawOutput: text("raw_output"),
    error: text("error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [index("generation_runs_project_kind_idx").on(table.projectId, table.kind)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => sources.id),
    worldlineId: text("worldline_id").references(
      (): AnySQLiteColumn => worldlines.id,
    ),
    kind: text("kind", {
      enum: [
        "story_map",
        "story_map_revision",
        "impact_plan",
        "ripple_suggestions",
        "continuation",
      ],
    }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    version: integer("version"),
    dataJson: text("data_json").notNull(),
    reviewJson: text("review_json")
      .notNull()
      .default('{"evidenceConfirmations":[]}'),
    basedOnArtifactId: text("based_on_artifact_id").references(
      (): AnySQLiteColumn => artifacts.id,
    ),
    generationRunId: text("generation_run_id").references(() => generationRuns.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("artifacts_project_kind_idx").on(table.projectId, table.kind),
    uniqueIndex("artifacts_story_map_source_version_unique")
      .on(table.projectId, table.sourceId, table.version)
      .where(
        sql`${table.kind} IN ('story_map', 'story_map_revision') AND ${table.sourceId} IS NOT NULL AND ${table.version} IS NOT NULL`,
      ),
  ],
);

export const worldlines = sqliteTable(
  "worldlines",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentWorldlineId: text("parent_worldline_id").references(
      (): AnySQLiteColumn => worldlines.id,
    ),
    baseStoryMapArtifactId: text("base_story_map_artifact_id")
      .notNull()
      .references(() => artifacts.id),
    divergenceJson: text("divergence_json"),
    mode: text("mode", { enum: ["strict", "open"] }).notNull(),
    anchorsJson: text("anchors_json").notNull(),
    acceptedImpactPlanId: text("accepted_impact_plan_id").references(
      () => artifacts.id,
    ),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", {
      enum: ["canonical", "active", "archived"],
    }).notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("worldlines_project_idempotency_unique").on(
      table.projectId,
      table.idempotencyKey,
    ),
    index("worldlines_project_parent_idx").on(
      table.projectId,
      table.parentWorldlineId,
    ),
  ],
);
