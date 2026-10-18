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
    /**
     * 本次生成绑定的 Story Map revision。Ripple Suggestions 用它把成功、
     * 失败与 pending 的真实模型调用按 revision 计数；其它生成可以不绑定。
     */
    storyMapArtifactId: text("story_map_artifact_id").references(
      (): AnySQLiteColumn => artifacts.id,
    ),
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    /**
     * 本 run 实际发起的 provider 调用次数（含 repair 与瞬时网络重试）。
     * 每次调用前自增并落库；迁移 0011 之前的旧行为 null，按 1 次兜底。
     */
    modelCalls: integer("model_calls"),
    status: text("status", { enum: ["pending", "succeeded", "failed"] })
      .notNull(),
    rawOutput: text("raw_output"),
    error: text("error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("generation_runs_project_kind_idx").on(table.projectId, table.kind),
    index("generation_runs_story_map_kind_idx").on(
      table.projectId,
      table.storyMapArtifactId,
      table.kind,
    ),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    inputJson: text("input_json").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "interrupted"],
    }).notNull(),
    progressJson: text("progress_json").notNull(),
    resultJson: text("result_json"),
    error: text("error"),
    /** 本 attempt 实际发起的模型调用数（含 repair 与瞬时网络重试）。 */
    modelCalls: integer("model_calls").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
  },
  (table) => [
    index("jobs_project_kind_idx").on(table.projectId, table.kind),
    index("jobs_status_heartbeat_idx").on(table.status, table.heartbeatAt),
  ],
);

/**
 * Story Map 分块检查点：只追加，不 UPDATE。
 *
 * 每个 (run_group_id, checkpoint_key, stage) 保存一次已验证的分块中间输出
 * （stage = extract / glean），供同一 run group 的后续 attempt 复用。
 * checkpoint_key 已包含 Source 内容身份、分块计划、Prompt 版本与模型身份；
 * 任何一项变化都会得到新 key，旧行自然失效但仍保留。
 */
export const storyMapChunkCheckpoints = sqliteTable(
  "story_map_chunk_checkpoints",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    sourceContentHash: text("source_content_hash").notNull(),
    runGroupId: text("run_group_id").notNull(),
    checkpointKey: text("checkpoint_key").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    stage: text("stage", { enum: ["extract", "glean"] }).notNull(),
    resultJson: text("result_json").notNull(),
    modelCalls: integer("model_calls").notNull(),
    /**
     * 产生该阶段结果的 Generation Run；迁移 0009 之前写入的旧行没有该字段。
     * 复用检查点时应把原始 run id 带回生成结果，保持证据/来源可追踪。
     */
    generationRunId: text("generation_run_id").references(
      () => generationRuns.id,
    ),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("story_map_chunk_checkpoints_group_key_idx").on(
      table.runGroupId,
      table.checkpointKey,
      table.stage,
    ),
    index("story_map_chunk_checkpoints_project_source_idx").on(
      table.projectId,
      table.sourceId,
    ),
  ],
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
    /** 阅读游标：最近一次阅读的场景；null 表示默认路径/分歧点。 */
    headNodeId: text("head_node_id"),
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

/**
 * 命名书签：读者在世界线上的阅读游标，不是叙事 Artifact。
 *
 * scene_node_id 为 null 表示分歧点/根路径；非空由仓储层校验必须是本
 * Worldline 的场景。唯一 (worldline_id, name) 防止同名书签。
 */
export const worldlineBookmarks = sqliteTable(
  "worldline_bookmarks",
  {
    id: text("id").primaryKey(),
    worldlineId: text("worldline_id")
      .notNull()
      .references(() => worldlines.id, { onDelete: "cascade" }),
    sceneNodeId: text("scene_node_id"),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("worldline_bookmarks_worldline_name_unique").on(
      table.worldlineId,
      table.name,
    ),
    index("worldline_bookmarks_worldline_idx").on(table.worldlineId),
  ],
);
