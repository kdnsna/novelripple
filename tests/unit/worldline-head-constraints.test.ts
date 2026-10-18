import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

/**
 * 0012 给 head_kind / head_node_id 加的 CHECK 是 PR 内原地修改，没有
 * drizzle `check()` 快照。这里用内存 SQLite 重放迁移，验证旧行可迁移
 * 且非法组合在 INSERT / UPDATE 两侧都 fail closed。
 */
describe("worldline reading head constraints", () => {
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  const migrationsBeforeHead = readdirSync(migrationsFolder)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file) && file < "0012_")
    .sort();

  function applyMigration(sqlite: Database.Database, file: string): void {
    sqlite.exec(readFileSync(path.join(migrationsFolder, file), "utf8"));
  }

  function prepareDatabaseWithExistingWorldline(): Database.Database {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    for (const migration of migrationsBeforeHead) {
      applyMigration(sqlite, migration);
    }

    sqlite
      .prepare("INSERT INTO projects (id, title) VALUES (?, ?)")
      .run("project_head", "阅读游标测试");
    sqlite
      .prepare(
        `INSERT INTO artifacts
          (id, project_id, kind, schema_version, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("artifact_head", "project_head", "story_map", 1, "{}");
    sqlite
      .prepare(
        `INSERT INTO worldlines
          (id, project_id, base_story_map_artifact_id, mode, anchors_json,
           idempotency_key, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "wl_head",
        "project_head",
        "artifact_head",
        "open",
        "[]",
        "head-constraint-test",
        "active",
      );
    return sqlite;
  }

  it("migrates existing worldline rows to a null head", () => {
    const sqlite = prepareDatabaseWithExistingWorldline();
    applyMigration(sqlite, "0012_worldline_reading_position.sql");

    expect(
      sqlite
        .prepare("SELECT head_kind, head_node_id FROM worldlines")
        .all(),
    ).toEqual([{ head_kind: null, head_node_id: null }]);
    sqlite.close();
  });

  it("accepts only consistent head_kind / head_node_id combinations", () => {
    const sqlite = prepareDatabaseWithExistingWorldline();
    applyMigration(sqlite, "0012_worldline_reading_position.sql");
    const updateHead = sqlite.prepare(
      "UPDATE worldlines SET head_kind = ?, head_node_id = ? WHERE id = 'wl_head'",
    );

    for (const [kind, nodeId] of [
      ["root", null],
      ["scene", "scene_1"],
      [null, null],
    ] as const) {
      expect(() => updateHead.run(kind, nodeId)).not.toThrow();
    }

    for (const [kind, nodeId] of [
      ["root", "scene_1"],
      ["scene", null],
      ["scene", ""],
      ["scene", " "],
      ["scene", "\t"],
      ["scene", "\u3000"],
      ["scene", "\u00A0"],
      ["scene", "\u2003"],
      ["scene", " \t\u3000\u00A0\u2003\n"],
      // 零宽字符同样不能伪装成非空场景 id。
      ["scene", "\u200B"],
      ["scene", "\u200C\u200D"],
      ["scene", "\u2060"],
      ["scene", "\u200B\u3000\uFEFF"],
      [null, "scene_1"],
      ["bogus", null],
    ] as const) {
      expect(() => updateHead.run(kind, nodeId)).toThrow(
        /CHECK constraint failed/,
      );
    }
    sqlite.close();
  });

  it("rejects inconsistent heads on insert as well", () => {
    const sqlite = prepareDatabaseWithExistingWorldline();
    applyMigration(sqlite, "0012_worldline_reading_position.sql");
    const insert = sqlite.prepare(
      `INSERT INTO worldlines
        (id, project_id, base_story_map_artifact_id, mode, anchors_json,
         idempotency_key, status, head_kind, head_node_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insert.run(
        "wl_bad_head",
        "project_head",
        "artifact_head",
        "open",
        "[]",
        "bad-head",
        "active",
        "root",
        "scene_1",
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insert.run(
        "wl_empty_head",
        "project_head",
        "artifact_head",
        "open",
        "[]",
        "empty-head",
        "active",
        "scene",
        "",
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insert.run(
        "wl_space_head",
        "project_head",
        "artifact_head",
        "open",
        "[]",
        "space-head",
        "active",
        "scene",
        " ",
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insert.run(
        "wl_tab_head",
        "project_head",
        "artifact_head",
        "open",
        "[]",
        "tab-head",
        "active",
        "scene",
        "\t",
      ),
    ).toThrow(/CHECK constraint failed/);
    for (const [index, nodeId] of [
      "\u3000",
      "\u00A0",
      "\u2003",
      " \t\u3000\u00A0\u2003\n",
      "\u200B",
      "\u200C\u200D",
      "\u2060",
      "\u200B\u3000\uFEFF",
    ].entries()) {
      expect(() =>
        insert.run(
          `wl_unicode_ws_head_${index}`,
          "project_head",
          "artifact_head",
          "open",
          "[]",
          `unicode-ws-head-${index}`,
          "active",
          "scene",
          nodeId,
        ),
      ).toThrow(/CHECK constraint failed/);
    }
    expect(() =>
      insert.run(
        "wl_good_head",
        "project_head",
        "artifact_head",
        "open",
        "[]",
        "good-head",
        "active",
        "scene",
        "scene_1",
      ),
    ).not.toThrow();
    sqlite.close();
  });
});
