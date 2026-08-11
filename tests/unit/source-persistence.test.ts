import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDatabase,
  getDatabase,
} from "@/server/db/client";
import {
  createProject,
  getProject,
  getProjectSource,
  importProjectSource,
  listProjectSources,
} from "@/server/repositories/project-repository";

let temporaryDirectory: string;
let databasePath: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "novelripple-step5-"));
  databasePath = path.join(temporaryDirectory, "test.db");
  process.env.DB_FILE_NAME = databasePath;
  closeDatabase();
  migrate(getDatabase(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
});

afterAll(async () => {
  closeDatabase();
  delete process.env.DB_FILE_NAME;
  await rm(temporaryDirectory, { recursive: true });
});

describe("SQLite Source persistence", () => {
  it("migrates the five-table schema and immutable Source trigger from empty", () => {
    const sqlite = new Database(databasePath, { readonly: true });
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const trigger = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'sources_prevent_update'",
      )
      .get() as { name: string } | undefined;
    sqlite.close();

    expect(tables.map((table) => table.name)).toEqual([
      "artifacts",
      "generation_runs",
      "projects",
      "sources",
      "worldlines",
    ]);
    expect(trigger?.name).toBe("sources_prevent_update");
  });

  it("persists a Project and Source across a database reconnect", () => {
    const project = createProject({ title: "潮汐测试" });
    const imported = importProjectSource({
      projectId: project.id,
      fileName: "潮汐.txt",
      bytes: new TextEncoder().encode("第一段。\r\n\r\n第二段。"),
    });

    expect(imported.disposition).toBe("created");
    closeDatabase();

    expect(getProject(project.id)).toEqual(project);
    expect(getProjectSource(project.id, imported.source.id)).toEqual(
      imported.source,
    );
  });

  it("returns the existing Source for repeated normalized content", () => {
    const project = createProject({ title: "幂等测试" });
    const first = importProjectSource({
      projectId: project.id,
      fileName: "same.txt",
      bytes: new TextEncoder().encode("第一行\r\n第二行"),
    });
    const repeated = importProjectSource({
      projectId: project.id,
      fileName: "renamed.md",
      bytes: new TextEncoder().encode("第一行\n第二行"),
    });

    expect(first.disposition).toBe("created");
    expect(repeated.disposition).toBe("existing");
    expect(repeated.source.id).toBe(first.source.id);
    expect(listProjectSources(project.id)).toHaveLength(1);
  });

  it("creates a new Source for changed content without modifying the old one", () => {
    const project = createProject({ title: "版本测试" });
    const first = importProjectSource({
      projectId: project.id,
      fileName: "story.txt",
      bytes: new TextEncoder().encode("版本一"),
    });
    const second = importProjectSource({
      projectId: project.id,
      fileName: "story.txt",
      bytes: new TextEncoder().encode("版本二"),
    });

    expect(second.disposition).toBe("created");
    expect(second.source.id).not.toBe(first.source.id);
    expect(listProjectSources(project.id)).toHaveLength(2);
    expect(getProjectSource(project.id, first.source.id)?.originalText).toBe(
      "版本一",
    );
  });

  it("rejects direct SQL updates to an immutable Source", () => {
    const project = createProject({ title: "不可变测试" });
    const imported = importProjectSource({
      projectId: project.id,
      fileName: "immutable.md",
      bytes: new TextEncoder().encode("不可覆盖的原文"),
    });
    const sqlite = new Database(databasePath);

    expect(() =>
      sqlite
        .prepare("UPDATE sources SET original_text = ? WHERE id = ?")
        .run("覆盖后的内容", imported.source.id),
    ).toThrow("Source is immutable");
    sqlite.close();

    expect(getProjectSource(project.id, imported.source.id)?.originalText).toBe(
      "不可覆盖的原文",
    );
  });
});
