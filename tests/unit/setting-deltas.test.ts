import { describe, expect, it } from "vitest";

import {
  buildSceneTree,
  getScenePath,
  type SceneTree,
} from "@/domain/continuation/scene-tree";
import {
  buildSettingDeltaContextItems,
  deriveActiveSettingDeltas,
  deriveActiveSettingDeltasAsOf,
  derivePathSettingDeltas,
  isDirectionBatchStale,
  settingDeltaActiveFingerprint,
  settingDeltaAffectedPaths,
  settingDeltaLifecycleStatuses,
  renderSettingDeltaContextText,
  subjectKey,
} from "@/domain/continuation/setting-deltas";
import {
  SETTING_DELTA_CONTEXT_MAX_CHARS,
  SETTING_DELTA_MAX_ACTIVE,
} from "@/domain/continuation/setting-delta-limits";
import {
  SettingDeltaLifecycleV1Schema,
  SettingDeltaV1Schema,
  SettingDeltaV1StoredSchema,
  sanitizeSettingDeltaText,
  type SettingDeltaLifecycleV1,
  type SettingDeltaSubject,
  type SettingDeltaV1,
} from "@/domain/schemas";

import { v2SceneFixture } from "../helpers/continuation-scene-fixtures";

/** 测试构造的短句，不是任何作品原文。 */
function settingDelta(input: {
  id: string;
  anchorSceneId?: string | null;
  subject?: SettingDeltaSubject;
  statement?: string;
  createdAt?: string;
  worldlineId?: string;
}): SettingDeltaV1 {
  return SettingDeltaV1Schema.parse({
    id: input.id,
    worldlineId: input.worldlineId ?? "wl_1",
    anchorSceneId: input.anchorSceneId ?? null,
    subject: input.subject ?? { kind: "term", name: "旧灯塔" },
    statement: input.statement ?? "旧灯塔已被封锁，不能进入。",
    contentKind: "user",
    createdAt: input.createdAt ?? "2026-08-11T00:00:00.000Z",
  });
}

function lifecycle(input: {
  id: string;
  targetDeltaId: string;
  status: "deactivated" | "reactivated" | "deleted";
  createdAt?: string;
  worldlineId?: string;
}): SettingDeltaLifecycleV1 {
  return SettingDeltaLifecycleV1Schema.parse({
    id: input.id,
    worldlineId: input.worldlineId ?? "wl_1",
    targetDeltaId: input.targetDeltaId,
    status: input.status,
    contentKind: "user",
    createdAt: input.createdAt ?? "2026-08-11T00:10:00.000Z",
  });
}

/**
 * 分歧点
 * ├─ 第一幕 A（本幕优先）
 * │  └─ 第二幕 A1
 * └─ 第一幕 B（兄弟）
 *    └─ 第二幕 B1（兄弟的后代）
 */
function buildTree(): SceneTree {
  return buildSceneTree([
    v2SceneFixture({
      id: "scene_a",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:01:00.000Z",
      title: "第一幕 A",
    }),
    v2SceneFixture({
      id: "scene_a1",
      parentSceneId: "scene_a",
      depth: 2,
      createdAt: "2026-08-11T00:02:00.000Z",
      title: "第二幕 A1",
    }),
    v2SceneFixture({
      id: "scene_b",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:03:00.000Z",
      title: "第一幕 B",
    }),
    v2SceneFixture({
      id: "scene_b1",
      parentSceneId: "scene_b",
      depth: 2,
      createdAt: "2026-08-11T00:04:00.000Z",
      title: "第二幕 B1",
    }),
  ]);
}

describe("subjectKey", () => {
  it("uses stable character ids and normalized term names", () => {
    expect(subjectKey({ kind: "character", characterId: "char_xucheng" })).toBe(
      "character:char_xucheng",
    );
    expect(subjectKey({ kind: "term", name: " 旧　灯塔 " })).toBe(
      subjectKey({ kind: "term", name: "旧 灯塔" }),
    );
    expect(subjectKey({ kind: "term", name: "Old Lantern" })).toBe(
      subjectKey({ kind: "term", name: "old lantern" }),
    );
  });
});

describe("deriveActiveSettingDeltas", () => {
  const tree = buildTree();
  const path = getScenePath(tree, "scene_a1");
  const deltas = [
    settingDelta({
      id: "delta_root",
      subject: { kind: "term", name: "旧灯塔" },
      statement: "旧灯塔已被封锁。",
      createdAt: "2026-08-11T00:00:00.000Z",
    }),
    settingDelta({
      id: "delta_a",
      anchorSceneId: "scene_a",
      subject: { kind: "character", characterId: "char_shenyan" },
      statement: "沈砚从此左手受伤，不能划船。",
      createdAt: "2026-08-11T00:01:00.000Z",
    }),
    settingDelta({
      id: "delta_a1",
      anchorSceneId: "scene_a1",
      subject: { kind: "term", name: "渡船" },
      statement: "夜班渡船已经停航。",
      createdAt: "2026-08-11T00:02:00.000Z",
    }),
    settingDelta({
      id: "delta_sibling",
      anchorSceneId: "scene_b1",
      subject: { kind: "term", name: "北侧石阶" },
      statement: "北侧石阶已经塌方，不能通行。",
      createdAt: "2026-08-11T00:03:00.000Z",
    }),
  ];

  it("keeps root and ancestor rules visible and hides sibling branches", () => {
    const active = deriveActiveSettingDeltas({ tree, deltas, path });
    expect(active.map((entry) => entry.active.id)).toEqual([
      "delta_root",
      "delta_a",
      "delta_a1",
    ]);
    expect(active.map((entry) => entry.active.anchorSceneId)).toEqual([
      null,
      "scene_a",
      "scene_a1",
    ]);
    expect(active.some((entry) => entry.active.id === "delta_sibling")).toBe(
      false,
    );
  });

  it("shows only root-scoped rules at the divergence point", () => {
    const active = deriveActiveSettingDeltas({ tree, deltas, path: [] });
    expect(active.map((entry) => entry.active.id)).toEqual(["delta_root"]);
  });

  it("never leaks a sibling rule to the other branch's descendant", () => {
    const siblingPath = getScenePath(tree, "scene_b1");
    const active = deriveActiveSettingDeltas({
      tree,
      deltas,
      path: siblingPath,
    });
    expect(active.map((entry) => entry.active.id)).toEqual([
      "delta_root",
      "delta_sibling",
    ]);
    expect(active.some((entry) => entry.active.id === "delta_a1")).toBe(false);
  });

  it("replaces the same subject along the path and keeps history", () => {
    const replacementDeltas = [
      settingDelta({
        id: "delta_rule_root",
        subject: { kind: "character", characterId: "char_shenyan" },
        statement: "沈砚左手受伤。",
        createdAt: "2026-08-11T00:00:00.000Z",
      }),
      settingDelta({
        id: "delta_rule_a",
        anchorSceneId: "scene_a",
        subject: { kind: "character", characterId: "char_shenyan" },
        statement: "沈砚左手受伤，不能划船。",
        createdAt: "2026-08-11T00:01:00.000Z",
      }),
      settingDelta({
        id: "delta_rule_a1",
        anchorSceneId: "scene_a1",
        subject: { kind: "character", characterId: "char_shenyan" },
        statement: "沈砚左手受伤，不能划船，也不能搬重物。",
        createdAt: "2026-08-11T00:02:00.000Z",
      }),
    ];
    const active = deriveActiveSettingDeltas({
      tree,
      deltas: replacementDeltas,
      path,
    });
    expect(active).toHaveLength(1);
    expect(active[0]!.subjectKey).toBe("character:char_shenyan");
    expect(active[0]!.active.id).toBe("delta_rule_a1");
    expect(active[0]!.history.map((delta) => delta.id)).toEqual([
      "delta_rule_root",
      "delta_rule_a",
    ]);
  });

  it("orders visible rules by anchor depth then createdAt then id, but outputs by first appearance", () => {
    const ordered = [
      settingDelta({
        id: "delta_child",
        anchorSceneId: "scene_a",
        subject: { kind: "term", name: "渡船" },
        createdAt: "2026-08-11T00:00:00.000Z",
      }),
      settingDelta({
        id: "delta_root_b",
        subject: { kind: "term", name: "旧灯塔" },
        createdAt: "2026-08-11T00:02:00.000Z",
      }),
      settingDelta({
        id: "delta_root_a",
        subject: { kind: "term", name: "北侧石阶" },
        createdAt: "2026-08-11T00:01:00.000Z",
      }),
    ];
    const active = deriveActiveSettingDeltas({
      tree,
      deltas: ordered,
      path,
    });
    // 根规则（深度 0）先于场景规则（深度 1），根规则内部按 createdAt。
    expect(active.map((entry) => entry.active.id)).toEqual([
      "delta_root_a",
      "delta_root_b",
      "delta_child",
    ]);
  });

  it("caps active subjects to the deepest/latest ones", () => {
    const many = Array.from({ length: SETTING_DELTA_MAX_ACTIVE + 5 }, (_, index) =>
      settingDelta({
        id: `delta_${String(index).padStart(2, "0")}`,
        subject: { kind: "term", name: `规则 ${index}` },
        statement: `这是第 ${index} 条测试规则。`,
        createdAt: `2026-08-11T00:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const active = deriveActiveSettingDeltas({ tree, deltas: many, path });
    expect(active).toHaveLength(SETTING_DELTA_MAX_ACTIVE);
    expect(active.map((entry) => entry.active.id)).toEqual(
      many.slice(5).map((delta) => delta.id),
    );
  });

  it("fails closed for a delta from another worldline", () => {
    expect(() =>
      deriveActiveSettingDeltas({
        tree,
        deltas: [
          settingDelta({
            id: "delta_other_worldline",
            worldlineId: "wl_other",
          }),
        ],
        path,
      }),
    ).toThrow("设定增量属于其他世界线");
  });

  it("fails closed for an anchor id that is not in the tree", () => {
    expect(() =>
      deriveActiveSettingDeltas({
        tree,
        deltas: [settingDelta({ id: "delta_bad_anchor", anchorSceneId: "scene_missing" })],
        path,
      }),
    ).toThrow("设定增量引用了场景树中不存在的锚点");
  });

  it("fails closed for a path that does not match the scene tree", () => {
    const brokenPath = [getScenePath(tree, "scene_a1")[1]!];
    expect(() =>
      deriveActiveSettingDeltas({ tree, deltas, path: brokenPath }),
    ).toThrow("设定增量的当前路径不属于给定场景树");
  });

  it("fails closed for duplicate delta ids", () => {
    const delta = settingDelta({ id: "delta_duplicate" });
    expect(() =>
      deriveActiveSettingDeltas({
        tree,
        deltas: [delta, delta],
        path,
      }),
    ).toThrow("设定增量存在重复 id");
  });
});

describe("setting delta lifecycles", () => {
  const tree = buildTree();
  const path = getScenePath(tree, "scene_a1");

  it("shows a deactivated winner as inactive and drops it from active context", () => {
    const deltas = [
      settingDelta({
        id: "delta_term",
        statement: "旧灯塔已被封锁。",
      }),
    ];
    const lifecycles = [
      lifecycle({
        id: "lifecycle_deactivate",
        targetDeltaId: "delta_term",
        status: "deactivated",
      }),
    ];

    const visible = derivePathSettingDeltas({
      tree,
      deltas,
      lifecycles,
      path,
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      status: "deactivated",
      subjectKey: "term:旧灯塔",
    });
    expect(deriveActiveSettingDeltas({ tree, deltas, lifecycles, path })).toEqual(
      [],
    );
  });

  it("hides a soft-deleted winner entirely instead of restoring an older version", () => {
    const deltas = [
      settingDelta({
        id: "delta_root",
        statement: "旧灯塔还能通行。",
        createdAt: "2026-08-11T00:00:00.000Z",
      }),
      settingDelta({
        id: "delta_scene",
        anchorSceneId: "scene_a",
        statement: "旧灯塔已被封锁。",
        createdAt: "2026-08-11T00:01:00.000Z",
      }),
    ];
    const lifecycles = [
      lifecycle({
        id: "lifecycle_delete",
        targetDeltaId: "delta_scene",
        status: "deleted",
      }),
    ];

    const visible = derivePathSettingDeltas({
      tree,
      deltas,
      lifecycles,
      path,
    });
    expect(visible).toEqual([]);
  });

  it("excludes a soft-deleted history item without hiding the active winner", () => {
    const deltas = [
      settingDelta({
        id: "delta_root",
        statement: "旧灯塔还能通行。",
        createdAt: "2026-08-11T00:00:00.000Z",
      }),
      settingDelta({
        id: "delta_scene",
        anchorSceneId: "scene_a",
        statement: "旧灯塔已被封锁。",
        createdAt: "2026-08-11T00:01:00.000Z",
      }),
    ];
    const lifecycles = [
      lifecycle({
        id: "lifecycle_delete_history",
        targetDeltaId: "delta_root",
        status: "deleted",
      }),
    ];

    const visible = derivePathSettingDeltas({
      tree,
      deltas,
      lifecycles,
      path,
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]!.active.id).toBe("delta_scene");
    expect(visible[0]!.history.map((delta) => delta.id)).toEqual([]);
  });

  it("lets the latest lifecycle win so reactivation restores the original statement", () => {
    const deltas = [
      settingDelta({
        id: "delta_term",
        statement: "旧灯塔已被封锁。",
      }),
    ];
    const lifecycles = [
      lifecycle({
        id: "lifecycle_deactivate",
        targetDeltaId: "delta_term",
        status: "deactivated",
        createdAt: "2026-08-11T00:10:00.000Z",
      }),
      lifecycle({
        id: "lifecycle_reactivate",
        targetDeltaId: "delta_term",
        status: "reactivated",
        createdAt: "2026-08-11T00:11:00.000Z",
      }),
    ];

    const active = deriveActiveSettingDeltas({
      tree,
      deltas,
      lifecycles,
      path,
    });
    expect(active).toHaveLength(1);
    expect(active[0]!.active.statement).toBe("旧灯塔已被封锁。");
    expect(
      settingDeltaLifecycleStatuses(lifecycles).get("delta_term"),
    ).toBe("reactivated");
  });

  it("fails closed for cross-worldline or unknown lifecycle targets", () => {
    const delta = settingDelta({ id: "delta_term" });
    expect(() =>
      derivePathSettingDeltas({
        tree,
        deltas: [delta],
        lifecycles: [
          lifecycle({
            id: "lifecycle_other_worldline",
            targetDeltaId: "delta_term",
            status: "deactivated",
            worldlineId: "wl_other",
          }),
        ],
        path,
      }),
    ).toThrow("设定增量生命周期属于其他世界线");

    expect(() =>
      derivePathSettingDeltas({
        tree,
        deltas: [delta],
        lifecycles: [
          lifecycle({
            id: "lifecycle_unknown_target",
            targetDeltaId: "delta_missing",
            status: "deleted",
          }),
        ],
        path,
      }),
    ).toThrow("设定增量生命周期引用了未知规则");
  });
});

describe("setting delta context serialization", () => {
  const characters = [{ id: "char_shenyan", name: "沈砚" }];

  it("builds stable per-rule lines with subject and scope", () => {
    const tree = buildTree();
    const deltas = [
      settingDelta({
        id: "delta_character",
        subject: { kind: "character", characterId: "char_shenyan" },
        statement: "沈砚从此左手受伤，不能划船。",
      }),
      settingDelta({
        id: "delta_term",
        anchorSceneId: "scene_a",
        subject: { kind: "term", name: "旧灯塔" },
        statement: "旧灯塔已被封锁。",
      }),
    ];
    const active = deriveActiveSettingDeltas({
      tree,
      deltas,
      path: getScenePath(tree, "scene_a1"),
    });
    const items = buildSettingDeltaContextItems({ active, characters });
    expect(items.map((item) => item.id)).toEqual([
      "delta_character",
      "delta_term",
    ]);
    expect(items[0]!.text).toContain("沈砚（自分歧点起）");
    expect(items[1]!.text).toContain("旧灯塔（自第 1 幕起）");
    // 写时测量与 Prompt 段内文本共用同一个渲染函数。
    expect(renderSettingDeltaContextText(items)).toBe(
      items.map((item) => item.text).join("\n"),
    );
  });

  it("measures the exact rendered setting_deltas text for the 2k cap", () => {
    const tree = buildTree();
    const maxStatements = Array.from({ length: 20 }, (_, index) =>
      settingDelta({
        id: `delta_max_${index}`,
        subject: { kind: "term", name: `规则 ${index}` },
        statement: "灯".repeat(200),
        createdAt: `2026-08-11T00:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const active = deriveActiveSettingDeltas({
      tree,
      deltas: maxStatements,
      path: [],
    });
    const rendered = renderSettingDeltaContextText(
      buildSettingDeltaContextItems({ active, characters: [] }),
    );
    expect(rendered.length).toBeGreaterThan(SETTING_DELTA_CONTEXT_MAX_CHARS);

    const small = maxStatements.slice(0, 2);
    const smallRendered = renderSettingDeltaContextText(
      buildSettingDeltaContextItems({
        active: deriveActiveSettingDeltas({ tree, deltas: small, path: [] }),
        characters: [],
      }),
    );
    expect(smallRendered.length).toBeLessThanOrEqual(
      SETTING_DELTA_CONTEXT_MAX_CHARS,
    );
  });

  it("strips legacy forbidden characters from rendered rules and keeps emoji", () => {
    // 模拟规则收紧前写入的历史行：存储 Schema 宽松读取，但渲染必须清洗。
    const legacy = SettingDeltaV1StoredSchema.parse({
      id: "delta_legacy",
      worldlineId: "wl_1",
      anchorSceneId: null,
      subject: { kind: "term", name: "旧灯\u200B塔" },
      statement: "旧灯\u200B塔已被封锁。",
      contentKind: "user",
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const rendered = renderSettingDeltaContextText(
      buildSettingDeltaContextItems({
        active: [
          {
            subjectKey: "term:旧灯\u200B塔",
            active: legacy,
            history: [],
            anchorDepth: 0,
          },
        ],
        characters: [],
      }),
    );
    expect(rendered).not.toContain("\u200B");
    expect(rendered).toBe("- 旧灯塔（自分歧点起）：旧灯塔已被封锁。");

    // 合法 emoji 序列保持完整；孤立零宽字符被移除。
    expect(sanitizeSettingDeltaText("👨‍👩‍👧❤️👍🏽1️⃣🇨🇳")).toBe(
      "👨‍👩‍👧❤️👍🏽1️⃣🇨🇳",
    );
    expect(sanitizeSettingDeltaText("灯\u200B塔\u200D")).toBe("灯塔");
  });

  it("lists the anchor subtree paths that a write can affect", () => {
    const tree = buildTree();
    const rootPaths = settingDeltaAffectedPaths(tree, null);
    // 空根路径 + 树中每个节点。
    expect(rootPaths).toHaveLength(tree.nodes.size + 1);
    expect(rootPaths[0]).toEqual({ path: [], label: "分歧点" });

    const anchorPaths = settingDeltaAffectedPaths(tree, "scene_a");
    const ids = anchorPaths.map((entry) => entry.path.at(-1)?.id ?? "root");
    expect(ids).toContain("scene_a");
    expect(ids).toContain("scene_a1");
    expect(ids).not.toContain("scene_b");
    expect(anchorPaths[0]!.label).toBe("第 1 幕 · 第一幕 A");
  });
});

describe("stale direction batches", () => {
  const tree = buildTree();
  const pathToSceneA = getScenePath(tree, "scene_a");
  const batch = {
    id: "batch_a_0",
    parentSceneId: "scene_a",
    createdAt: "2026-08-11T00:05:00.000Z",
  };
  const beforeBatch = settingDelta({
    id: "delta_before",
    anchorSceneId: "scene_a",
    subject: { kind: "term", name: "旧灯塔" },
    statement: "旧灯塔还能通行。",
    createdAt: "2026-08-11T00:01:00.000Z",
  });

  function stale(
    deltas: SettingDeltaV1[],
    lifecycles: SettingDeltaLifecycleV1[] = [],
  ): boolean {
    return isDirectionBatchStale({
      batch,
      tree,
      pathToParent: pathToSceneA,
      deltas,
      lifecycles,
    });
  }

  it("replays only rules and lifecycles created at or before the batch", () => {
    const later = settingDelta({
      id: "delta_later",
      anchorSceneId: "scene_a",
      subject: { kind: "term", name: "渡船" },
      statement: "夜班渡船已经停航。",
      createdAt: "2026-08-11T00:06:00.000Z",
    });
    const current = deriveActiveSettingDeltas({
      tree,
      deltas: [beforeBatch, later],
      path: pathToSceneA,
    });
    const asOf = deriveActiveSettingDeltasAsOf({
      tree,
      deltas: [beforeBatch, later],
      path: pathToSceneA,
      asOfCreatedAt: batch.createdAt,
    });
    expect(current.map((entry) => entry.active.id)).toEqual([
      "delta_before",
      "delta_later",
    ]);
    expect(asOf.map((entry) => entry.active.id)).toEqual(["delta_before"]);
    expect(settingDeltaActiveFingerprint(current)).not.toBe(
      settingDeltaActiveFingerprint(asOf),
    );
  });

  it("is fresh when no rule changed after the batch", () => {
    expect(stale([beforeBatch])).toBe(false);
  });

  it("becomes stale when a visible rule is added after the batch", () => {
    expect(
      stale([
        beforeBatch,
        settingDelta({
          id: "delta_after",
          anchorSceneId: "scene_a",
          subject: { kind: "term", name: "渡船" },
          statement: "夜班渡船已经停航。",
          createdAt: "2026-08-11T00:06:00.000Z",
        }),
      ]),
    ).toBe(true);
  });

  it("ignores a rule added only on a sibling path", () => {
    expect(
      stale([
        beforeBatch,
        settingDelta({
          id: "delta_sibling",
          anchorSceneId: "scene_b1",
          subject: { kind: "term", name: "北侧石阶" },
          statement: "北侧石阶已经塌方，不能通行。",
          createdAt: "2026-08-11T00:06:00.000Z",
        }),
      ]),
    ).toBe(false);
  });

  it("becomes stale when the visible rule is deactivated", () => {
    expect(
      stale(
        [beforeBatch],
        [
          lifecycle({
            id: "lifecycle_deactivate",
            targetDeltaId: "delta_before",
            status: "deactivated",
            createdAt: "2026-08-11T00:06:00.000Z",
          }),
        ],
      ),
    ).toBe(true);
  });

  it("is fresh again when deactivate then reactivate restores the same rule", () => {
    expect(
      stale(
        [beforeBatch],
        [
          lifecycle({
            id: "lifecycle_deactivate",
            targetDeltaId: "delta_before",
            status: "deactivated",
            createdAt: "2026-08-11T00:06:00.000Z",
          }),
          lifecycle({
            id: "lifecycle_reactivate",
            targetDeltaId: "delta_before",
            status: "reactivated",
            createdAt: "2026-08-11T00:07:00.000Z",
          }),
        ],
      ),
    ).toBe(false);
  });

  it("becomes stale when a later rule changes the subject statement", () => {
    expect(
      stale([
        beforeBatch,
        settingDelta({
          id: "delta_replacement",
          anchorSceneId: "scene_a",
          subject: { kind: "term", name: "旧灯塔" },
          statement: "旧灯塔已被封锁，不能进入。",
          createdAt: "2026-08-11T00:06:00.000Z",
        }),
      ]),
    ).toBe(true);
  });

  it("is fresh when a new rule is added and deactivated after the batch", () => {
    const added = settingDelta({
      id: "delta_added_then_deactivated",
      anchorSceneId: "scene_a",
      subject: { kind: "term", name: "渡船" },
      statement: "夜班渡船已经停航。",
      createdAt: "2026-08-11T00:06:00.000Z",
    });
    expect(
      stale(
        [beforeBatch, added],
        [
          lifecycle({
            id: "lifecycle_added_deactivated",
            targetDeltaId: added.id,
            status: "deactivated",
            createdAt: "2026-08-11T00:07:00.000Z",
          }),
        ],
      ),
    ).toBe(false);
  });

  it("fails closed when the parent path does not match the batch", () => {
    expect(() =>
      isDirectionBatchStale({
        batch: { ...batch, parentSceneId: "scene_b" },
        tree,
        pathToParent: pathToSceneA,
        deltas: [beforeBatch],
      }),
    ).toThrow("方向批次的父路径与 parentSceneId 不一致");
    expect(() =>
      isDirectionBatchStale({
        batch: { ...batch, parentSceneId: null },
        tree,
        pathToParent: pathToSceneA,
        deltas: [beforeBatch],
      }),
    ).toThrow("根方向批次的父路径必须为空");
  });
});
