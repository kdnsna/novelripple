import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("legacy demo cleanup migration", () => {
  it("removes only the obsolete fixed demo project and its rows", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(
      readFileSync(path.join(process.cwd(), "drizzle/0000_initial.sql"), "utf8"),
    );
    sqlite
      .prepare("INSERT INTO projects (id, title) VALUES (?, ?), (?, ?)")
      .run(
        "project_ripple_001",
        "旧演示项目",
        "project_user_owned",
        "用户项目",
      );
    sqlite
      .prepare(
        `INSERT INTO sources
          (id, project_id, title, original_text, normalized_text, content_hash, sections_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "source_ripple_001",
        "project_ripple_001",
        "旧演示 Source",
        "演示",
        "演示",
        `sha256:${"a".repeat(64)}`,
        "[]",
      );
    sqlite
      .prepare(
        `INSERT INTO artifacts
          (id, project_id, kind, schema_version, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "artifact_story_map_ripple_001_v1",
        "project_ripple_001",
        "story_map",
        1,
        JSON.stringify({
          sourceId: "source_ripple_001",
          events: [{ sourceEventId: "event_01", targetEventId: "event_02" }],
        }),
      );
    sqlite
      .prepare(
        `INSERT INTO worldlines
          (id, project_id, base_story_map_artifact_id, mode, anchors_json, idempotency_key, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "wl_ripple_001_canonical",
        "project_ripple_001",
        "artifact_story_map_ripple_001_v1",
        "open",
        "[]",
        "canonical:project_ripple_001",
        "canonical",
      );
    sqlite
      .prepare(
        `INSERT INTO artifacts
          (id, project_id, kind, schema_version, data_json, based_on_artifact_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "impact_reroute",
        "project_ripple_001",
        "impact_plan",
        1,
        JSON.stringify({ status: "accepted" }),
        "artifact_story_map_ripple_001_v1",
      );
    sqlite
      .prepare(
        `INSERT INTO worldlines
          (id, project_id, parent_worldline_id, base_story_map_artifact_id,
           divergence_json, mode, anchors_json, accepted_impact_plan_id,
           idempotency_key, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "wl_legacy_child",
        "project_ripple_001",
        "wl_ripple_001_canonical",
        "artifact_story_map_ripple_001_v1",
        JSON.stringify({ id: "divergence_1" }),
        "strict",
        "[]",
        "impact_reroute",
        "legacy-child",
        "active",
      );

    for (const migration of [
      "0001_immutable_sources.sql",
      "0002_generation_run_worldline.sql",
      "0003_story_map_artifact_version.sql",
      "0004_story_map_review.sql",
      "0005_remove_legacy_demo.sql",
    ]) {
      sqlite.exec(
        readFileSync(path.join(process.cwd(), "drizzle", migration), "utf8"),
      );
    }

    expect(
      sqlite.prepare("SELECT id FROM projects ORDER BY id").all(),
    ).toEqual([{ id: "project_user_owned" }]);
    expect(sqlite.prepare("SELECT id FROM sources").all()).toEqual([]);
    expect(sqlite.prepare("SELECT id FROM artifacts").all()).toEqual([]);
    expect(sqlite.prepare("SELECT id FROM worldlines").all()).toEqual([]);
    sqlite.close();
  });
});
