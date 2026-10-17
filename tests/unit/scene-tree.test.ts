import { describe, expect, it } from "vitest";

import {
  applyStatePatch,
  buildSceneTree,
  derivePathState,
  getDefaultScenePath,
  getScenePath,
} from "@/domain/continuation/scene-tree";
import {
  ContextManifestSchema,
  ContinuationDirectionsSchema,
  ContinuationSceneArtifactSchema,
  ContinuationSceneModelOutputSchema,
  ContinuationSceneModelOutputV3Schema,
  ContinuationSceneV1Schema,
  ContinuationSceneV2Schema,
  ContinuationSchema,
  type ContextManifest,
  type ContinuationSceneV1,
  type ContinuationSceneV2,
  type StatePatch,
  WorldlineDeltaSchema,
} from "@/domain/schemas";

/** 与 M1-06 一致的最短合法场景正文（纯测试构造，不是任何作品原文）。 */
const TEST_PROSE = "风".repeat(1_200);

function emptyPatch(): StatePatch {
  return {
    factsAdded: [],
    factsRemoved: [],
    characterChanges: [],
    threadsOpened: [],
    threadsClosed: [],
  };
}

function testManifest(): ContextManifest {
  return ContextManifestSchema.parse({
    budget: { totalChars: 120, maxChars: 6_000, percentageUsed: 2 },
    sections: [
      {
        kind: "worldline_setup",
        included: true,
        chars: 80,
        trimmed: false,
        droppedItemIds: [],
      },
      {
        kind: "selected_direction",
        included: true,
        chars: 40,
        trimmed: false,
        droppedItemIds: ["direction_1"],
      },
    ],
  });
}

function v1Scene(
  overrides: Partial<ContinuationSceneV1> = {},
): ContinuationSceneV1 {
  return ContinuationSceneV1Schema.parse({
    schemaVersion: 1,
    id: "scene_v1",
    worldlineId: "wl_1",
    acceptedImpactPlanId: "impact_1",
    directionsArtifactId: "directions_1",
    selectedDirectionId: "direction_1",
    sequence: 1,
    title: "钟楼里的第二份记录",
    prose: TEST_PROSE,
    statePatch: emptyPatch(),
    contentKind: "generated",
    createdAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  });
}

function v2Scene(input: {
  id: string;
  parentSceneId: string | null;
  depth: number;
  createdAt: string;
  worldlineId?: string;
  origin?: "generated" | "retry";
  attemptIndex?: number;
  summary?: string;
  statePatch?: StatePatch;
  directionsArtifactId?: string;
  selectedDirectionId?: string;
}): ContinuationSceneV2 {
  return ContinuationSceneV2Schema.parse({
    schemaVersion: 2,
    id: input.id,
    worldlineId: input.worldlineId ?? "wl_1",
    acceptedImpactPlanId: "impact_1",
    directionsArtifactId: input.directionsArtifactId ?? "directions_1",
    selectedDirectionId: input.selectedDirectionId ?? "direction_1",
    parentSceneId: input.parentSceneId,
    depth: input.depth,
    origin: input.origin ?? "generated",
    attemptIndex: input.attemptIndex ?? 0,
    summary: input.summary ?? "许澄在钟楼核对记录。",
    contextManifest: testManifest(),
    title: "钟楼里的第二份记录",
    prose: TEST_PROSE,
    statePatch: input.statePatch ?? emptyPatch(),
    contentKind: "generated",
    createdAt: input.createdAt,
  });
}

function direction(index: number) {
  return {
    id: `direction_${index}`,
    title: `方向 ${index}`,
    premise: "许澄在钟楼与沈砚核对记录。",
    affectedCharacterIds: ["char_xucheng"],
    expectedConsequence: "顾闻舟提前抵达。",
  };
}

describe("scene tree", () => {
  it("normalizes a v1 scene as the first node after the divergence point", () => {
    const tree = buildSceneTree([v1Scene()]);
    const node = tree.nodes.get("scene_v1");

    expect(node).toMatchObject({
      parentSceneId: null,
      depth: 1,
      origin: "generated",
      attemptIndex: 0,
      summary: null,
      contextManifest: null,
    });
    expect(tree.childrenByParent.get(null)?.map((child) => child.id)).toEqual([
      "scene_v1",
    ]);
  });

  it("keeps multiple children under one parent in deterministic order", () => {
    const root = v2Scene({
      id: "scene_root",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const late = v2Scene({
      id: "scene_late",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:02:00.000Z",
    });
    const early = v2Scene({
      id: "scene_early",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:01:00.000Z",
    });

    const tree = buildSceneTree([late, root, early]);

    expect(
      tree.childrenByParent.get("scene_root")?.map((child) => child.id),
    ).toEqual(["scene_early", "scene_late"]);
    expect(tree.childrenByParent.get(null)?.map((child) => child.id)).toEqual([
      "scene_root",
    ]);
  });

  it("treats retry scenes as siblings of the same parent, batch and direction", () => {
    const root = v2Scene({
      id: "scene_root",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const generated = v2Scene({
      id: "scene_generated",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:01:00.000Z",
      attemptIndex: 0,
    });
    const retry = v2Scene({
      id: "scene_retry",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:02:00.000Z",
      origin: "retry",
      attemptIndex: 1,
    });

    const tree = buildSceneTree([root, generated, retry]);
    const siblings = tree.childrenByParent.get("scene_root");

    expect(siblings?.map((node) => node.id)).toEqual([
      "scene_generated",
      "scene_retry",
    ]);
    expect(siblings?.map((node) => node.origin)).toEqual([
      "generated",
      "retry",
    ]);
    expect(siblings?.map((node) => node.attemptIndex)).toEqual([0, 1]);
    expect(siblings?.[0]?.directionsArtifactId).toBe(
      siblings?.[1]?.directionsArtifactId,
    );
  });

  it("returns the root-to-node path", () => {
    const root = v2Scene({
      id: "scene_root",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const middle = v2Scene({
      id: "scene_middle",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:01:00.000Z",
    });
    const leaf = v2Scene({
      id: "scene_leaf",
      parentSceneId: "scene_middle",
      depth: 3,
      createdAt: "2026-08-11T00:02:00.000Z",
    });

    const tree = buildSceneTree([root, middle, leaf]);

    expect(getScenePath(tree, "scene_leaf").map((node) => node.id)).toEqual([
      "scene_root",
      "scene_middle",
      "scene_leaf",
    ]);
    expect(getScenePath(tree, "scene_root").map((node) => node.id)).toEqual([
      "scene_root",
    ]);
    expect(() => getScenePath(tree, "scene_missing")).toThrow("不存在节点");
  });

  it("defaults to the deepest first-attempt path", () => {
    const root = v2Scene({
      id: "scene_root",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const generated = v2Scene({
      id: "scene_generated",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:01:00.000Z",
      attemptIndex: 0,
    });
    const retry = v2Scene({
      id: "scene_retry",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:02:00.000Z",
      origin: "retry",
      attemptIndex: 1,
    });
    const deeper = v2Scene({
      id: "scene_deeper",
      parentSceneId: "scene_generated",
      depth: 3,
      createdAt: "2026-08-11T00:03:00.000Z",
    });
    const retryChild = v2Scene({
      id: "scene_retry_child",
      parentSceneId: "scene_retry",
      depth: 3,
      createdAt: "2026-08-11T00:04:00.000Z",
    });

    const tree = buildSceneTree([
      root,
      retry,
      generated,
      retryChild,
      deeper,
    ]);

    expect(getDefaultScenePath(tree).map((node) => node.id)).toEqual([
      "scene_root",
      "scene_generated",
      "scene_deeper",
    ]);
  });

  describe("fails closed", () => {
    it("rejects an unknown parent", () => {
      const orphan = v2Scene({
        id: "scene_orphan",
        parentSceneId: "scene_missing",
        depth: 2,
        createdAt: "2026-08-11T00:00:00.000Z",
      });

      expect(() => buildSceneTree([orphan])).toThrow("未知父节点");
    });

    it("rejects a parent from another worldline", () => {
      const parent = v2Scene({
        id: "scene_parent",
        worldlineId: "wl_1",
        parentSceneId: null,
        depth: 1,
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      const foreignChild = v2Scene({
        id: "scene_foreign",
        worldlineId: "wl_2",
        parentSceneId: "scene_parent",
        depth: 2,
        createdAt: "2026-08-11T00:01:00.000Z",
      });

      expect(() => buildSceneTree([parent, foreignChild])).toThrow(
        "其他世界线",
      );
    });

    it("rejects a depth jump", () => {
      const root = v2Scene({
        id: "scene_root",
        parentSceneId: null,
        depth: 1,
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      const skipped = v2Scene({
        id: "scene_skipped",
        parentSceneId: "scene_root",
        depth: 3,
        createdAt: "2026-08-11T00:01:00.000Z",
      });

      expect(() => buildSceneTree([root, skipped])).toThrow("深度不连续");
    });

    it("rejects a root whose depth is not 1", () => {
      const root = v2Scene({
        id: "scene_root",
        parentSceneId: null,
        depth: 2,
        createdAt: "2026-08-11T00:00:00.000Z",
      });

      expect(() => buildSceneTree([root])).toThrow("根场景深度必须为 1");
    });

    it("rejects a cycle", () => {
      const left = v2Scene({
        id: "scene_left",
        parentSceneId: "scene_right",
        depth: 2,
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      const right = v2Scene({
        id: "scene_right",
        parentSceneId: "scene_left",
        depth: 2,
        createdAt: "2026-08-11T00:01:00.000Z",
      });

      expect(() => buildSceneTree([left, right])).toThrow("循环引用");
    });

    it("rejects duplicate node ids", () => {
      const scene = v2Scene({
        id: "scene_duplicate",
        parentSceneId: null,
        depth: 1,
        createdAt: "2026-08-11T00:00:00.000Z",
      });

      expect(() => buildSceneTree([scene, scene])).toThrow("重复节点");
    });
  });
});

describe("path state", () => {
  const baseDelta = WorldlineDeltaSchema.parse({
    factsAdded: [
      { key: "divergence:div_1", statement: "许澄没有交出账簿" },
      { key: "generated:old", statement: "旧的钟楼记录" },
    ],
    factsRemoved: ["event:event_07"],
    characterChanges: [{ characterId: "char_xucheng", summary: "初始状态" }],
    threadsOpened: ["线索甲", "线索乙"],
    threadsClosed: [],
  });

  it("applies fact, thread and character semantics compatible with the validator", () => {
    const first = applyStatePatch(baseDelta, {
      factsAdded: [{ key: "generated:clock", statement: "钟楼记录建立" }],
      factsRemoved: ["generated:old"],
      characterChanges: [
        { characterId: "char_xucheng", summary: "变化一" },
        { characterId: "char_shenyan", summary: "沈砚加入" },
      ],
      threadsOpened: [],
      threadsClosed: ["线索乙"],
    });

    expect(first.factsAdded.map((fact) => fact.key)).toEqual([
      "divergence:div_1",
      "generated:clock",
    ]);
    expect(first.factsRemoved).toEqual(
      expect.arrayContaining(["event:event_07", "generated:old"]),
    );
    expect(first.characterChanges).toEqual([
      { characterId: "char_xucheng", summary: "变化一" },
      { characterId: "char_shenyan", summary: "沈砚加入" },
    ]);
    expect(first.threadsOpened).toEqual(["线索甲"]);
    expect(first.threadsClosed).toEqual(["线索乙"]);
    expect(WorldlineDeltaSchema.safeParse(first).success).toBe(true);

    const reopened = applyStatePatch(first, {
      factsAdded: [],
      factsRemoved: [],
      characterChanges: [{ characterId: "char_xucheng", summary: "变化二" }],
      threadsOpened: ["线索乙"],
      threadsClosed: [],
    });

    expect(reopened.threadsClosed).toEqual([]);
    expect(reopened.threadsOpened).toEqual(["线索甲", "线索乙"]);
    expect(reopened.characterChanges).toEqual([
      { characterId: "char_xucheng", summary: "变化二" },
      { characterId: "char_shenyan", summary: "沈砚加入" },
    ]);

    const removed = applyStatePatch(reopened, {
      factsAdded: [],
      factsRemoved: ["divergence:div_1"],
      characterChanges: [],
      threadsOpened: [],
      threadsClosed: [],
    });
    expect(removed.factsAdded.map((fact) => fact.key)).toEqual([
      "generated:clock",
    ]);
    expect(removed.factsRemoved).toContain("divergence:div_1");
  });

  it("never lets a sibling branch see the other branch's state", () => {
    const root = v2Scene({
      id: "scene_root",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      statePatch: {
        ...emptyPatch(),
        factsAdded: [{ key: "generated:shared", statement: "共同起点" }],
      },
    });
    const branchA = v2Scene({
      id: "scene_a",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:01:00.000Z",
      statePatch: {
        ...emptyPatch(),
        factsAdded: [{ key: "generated:a-only", statement: "分支甲的事实" }],
      },
    });
    const branchB = v2Scene({
      id: "scene_b",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:02:00.000Z",
      statePatch: {
        ...emptyPatch(),
        factsAdded: [{ key: "generated:b-only", statement: "分支乙的事实" }],
      },
    });

    const tree = buildSceneTree([root, branchA, branchB]);
    const emptyBase = WorldlineDeltaSchema.parse(emptyPatch());
    const stateA = derivePathState(
      emptyBase,
      getScenePath(tree, "scene_a"),
    );
    const stateB = derivePathState(
      emptyBase,
      getScenePath(tree, "scene_b"),
    );
    const keysA = stateA.factsAdded.map((fact) => fact.key);
    const keysB = stateB.factsAdded.map((fact) => fact.key);

    expect(keysA).toEqual(["generated:shared", "generated:a-only"]);
    expect(keysB).toEqual(["generated:shared", "generated:b-only"]);
    expect(keysA).not.toContain("generated:b-only");
    expect(keysB).not.toContain("generated:a-only");
  });

  it("rejects a path that crosses worldlines or breaks the parent chain", () => {
    const root = v2Scene({
      id: "scene_root",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const child = v2Scene({
      id: "scene_child",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:01:00.000Z",
    });
    const tree = buildSceneTree([root, child]);
    const emptyBase = WorldlineDeltaSchema.parse(emptyPatch());

    expect(() =>
      derivePathState(emptyBase, [tree.nodes.get("scene_child")!]),
    ).toThrow("断裂的父子链");
  });
});

describe("continuation v1/v2 schemas", () => {
  it("still parses a v1 scene with sequence 1", () => {
    const parsed = ContinuationSchema.parse(v1Scene());

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed).toMatchObject({ sequence: 1 });
  });

  it("parses a v2 scene and requires summary, depth and contextManifest", () => {
    const scene = v2Scene({
      id: "scene_v2",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      summary: "  许澄与沈砚建立了离线见证记录。  ",
    });
    const parsed = ContinuationSchema.parse(scene);

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed).not.toHaveProperty("sequence");
    expect(parsed).toMatchObject({
      summary: "许澄与沈砚建立了离线见证记录。",
      depth: 1,
      parentSceneId: null,
    });

    const withoutSummary: Record<string, unknown> = { ...scene };
    delete withoutSummary.summary;
    expect(ContinuationSchema.safeParse(withoutSummary).success).toBe(false);
    expect(
      ContinuationSchema.safeParse({ ...scene, summary: "   " }).success,
    ).toBe(false);
    expect(
      ContinuationSchema.safeParse({ ...scene, summary: "长".repeat(201) })
        .success,
    ).toBe(false);

    const withoutManifest: Record<string, unknown> = { ...scene };
    delete withoutManifest.contextManifest;
    expect(ContinuationSchema.safeParse(withoutManifest).success).toBe(false);
  });

  it("keeps the old model output and adds summary in v3", () => {
    const output = {
      title: "钟楼里的第二份记录",
      prose: TEST_PROSE,
      statePatch: emptyPatch(),
    };
    const withSummary = {
      ...output,
      summary: "许澄在钟楼核对记录。",
    };

    expect(ContinuationSceneModelOutputSchema.safeParse(output).success).toBe(
      true,
    );
    expect(
      ContinuationSceneModelOutputSchema.safeParse(withSummary).success,
    ).toBe(false);
    expect(
      ContinuationSceneModelOutputV3Schema.parse(withSummary).summary,
    ).toBe("许澄在钟楼核对记录。");
    expect(
      ContinuationSceneModelOutputV3Schema.safeParse(output).success,
    ).toBe(false);
  });

  it("round-trips directions v1 and v2", () => {
    const base = {
      id: "directions_1",
      worldlineId: "wl_1",
      acceptedImpactPlanId: "impact_1",
      directions: [direction(1), direction(2), direction(3)],
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const v1 = ContinuationDirectionsSchema.parse({
      ...base,
      schemaVersion: 1,
    });
    const v2 = ContinuationDirectionsSchema.parse({
      ...base,
      schemaVersion: 2,
      parentSceneId: "scene_root",
      batchIndex: 2,
    });

    expect(v1.schemaVersion).toBe(1);
    expect(v2).toMatchObject({
      schemaVersion: 2,
      parentSceneId: "scene_root",
      batchIndex: 2,
    });
    expect(
      ContinuationDirectionsSchema.safeParse({
        ...base,
        schemaVersion: 2,
        parentSceneId: "scene_root",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown manifest section kinds and any prose field", () => {
    const manifest = testManifest();

    expect(ContextManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      ContextManifestSchema.safeParse({
        ...manifest,
        sections: [
          {
            ...manifest.sections[0],
            kind: "raw_source_text",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ContextManifestSchema.safeParse({
        ...manifest,
        prose: "这里不应出现原文。",
      }).success,
    ).toBe(false);
    expect(
      ContextManifestSchema.safeParse({
        budget: { totalChars: 1, maxChars: 0, percentageUsed: 1 },
        sections: [],
      }).success,
    ).toBe(false);
  });

  it("requires the artifact schemaVersion to match the inner continuation", () => {
    const scene = v2Scene({
      id: "scene_v2",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const artifact = {
      id: scene.id,
      projectId: "project_1",
      sourceId: "source_1",
      worldlineId: scene.worldlineId,
      kind: "continuation" as const,
      artifactType: "scene" as const,
      schemaVersion: 2 as const,
      continuation: scene,
      basedOnArtifactId: scene.directionsArtifactId,
      generationRunId: "run_1",
      createdAt: scene.createdAt,
    };

    expect(ContinuationSceneArtifactSchema.safeParse(artifact).success).toBe(
      true,
    );
    expect(
      ContinuationSceneArtifactSchema.safeParse({
        ...artifact,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
  });
});
