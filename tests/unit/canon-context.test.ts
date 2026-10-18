import { describe, expect, it } from "vitest";

import {
  buildCanonEventsSection,
  buildRelatedEvidenceItems,
  capPinnedEvidence,
  CONTEXT_PINNED_EVIDENCE_MAX_CHARS,
  CONTEXT_PINNED_EVIDENCE_MAX_ITEMS,
  divergenceDependencyEventIds,
  selectRelatedCanon,
} from "@/domain/continuation/canon-context";
import {
  assembleContext,
  ContinuationContextBudgetError,
} from "@/domain/continuation/context-assembler";
import type { ImpactPlan, SourceReference, StoryMap } from "@/domain/schemas";
import { DEFAULT_CONTINUATION_CONTEXT_MAX_CHARS } from "@/server/continuation/continuation-limits";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

const STORY_MAP_ARTIFACT_ID = "artifact_story_map_context_budget";
/** 只复制 SourceReference 的定位信息，不包含任何原文正文。 */
const EVIDENCE_COPIES_PER_RELATED_ITEM = 40;

function withLargeEvidence(
  storyMap: StoryMap,
  evidence: SourceReference,
): StoryMap {
  const clone = structuredClone(storyMap);
  for (const edge of clone.edges) {
    edge.evidence = Array.from(
      { length: EVIDENCE_COPIES_PER_RELATED_ITEM },
      () => ({ ...evidence }),
    );
  }
  for (const ending of clone.endingCandidates) {
    ending.evidence = Array.from(
      { length: EVIDENCE_COPIES_PER_RELATED_ITEM },
      () => ({ ...evidence }),
    );
  }
  return clone;
}

function buildWorldlineSetup(input: {
  storyMap: StoryMap;
  plan: ImpactPlan;
}): string {
  return JSON.stringify({
    worldlineId: "wl_context_budget_fixture",
    mode: "strict",
    divergence: input.plan.divergence,
    anchors: input.plan.anchors,
    storyMap: {
      id: input.storyMap.id,
      title: input.storyMap.title,
      logline: input.storyMap.logline,
    },
    characters: input.storyMap.characters.map((character) => ({
      id: character.id,
      name: character.name,
      aliases: character.aliases,
      role: character.role,
    })),
    acceptedImpactPlan: input.plan,
    currentState: {
      factsAddedCount: 0,
      factsRemovedCount: 0,
      characterChangesCount: 0,
      threadsOpenedCount: 0,
      threadsClosedCount: 0,
      factsAddedKeys: [],
      factsRemovedKeys: [],
      characterChangeKeys: [],
      threadsOpenedKeys: [],
      threadsClosedKeys: [],
    },
  });
}

describe("buildCanonEventsSection", () => {
  it("omits evidence on edges/endings and keeps only the slim character fields", async () => {
    const fixture = await loadRippleFixture();
    const storyMap = withLargeEvidence(
      fixture.storyMap,
      fixture.storyMap.events[0]!.evidence[0]!,
    );
    const plan = fixture.impactPlans[0]!;
    const section = buildCanonEventsSection({
      storyMap,
      storyMapArtifactId: STORY_MAP_ARTIFACT_ID,
      source: fixture.source,
      impactPlan: plan,
      anchors: plan.anchors,
    });
    const parsed = JSON.parse(section) as {
      characters: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
      endingCandidates: Array<Record<string, unknown>>;
    };

    expect(parsed.characters).toEqual(
      storyMap.characters.map((character) => ({
        id: character.id,
        name: character.name,
        aliases: character.aliases,
        role: character.role,
      })),
    );
    for (const character of parsed.characters) {
      expect(Object.keys(character).sort()).toEqual([
        "aliases",
        "id",
        "name",
        "role",
      ]);
    }
    expect(parsed.edges.length).toBeGreaterThan(0);
    for (const edge of parsed.edges) {
      expect(Object.keys(edge).sort()).toEqual([
        "confidence",
        "confirmed",
        "explanation",
        "from",
        "id",
        "to",
        "type",
      ]);
    }
    expect(parsed.endingCandidates).toHaveLength(1);
    for (const ending of parsed.endingCandidates) {
      expect(Object.keys(ending).sort()).toEqual([
        "id",
        "requirement",
        "targetEventId",
      ]);
    }
    for (const event of parsed.events) {
      expect(Object.keys(event).sort()).toEqual([
        "id",
        "participants",
        "sequence",
        "stateChanges",
        "summary",
        "title",
      ]);
    }
    expect(section).not.toContain('"evidence"');
  });

  it("fits a strict one-anchor fixture under the 24000 budget only after slimming", async () => {
    const fixture = await loadRippleFixture();
    const storyMap = withLargeEvidence(
      fixture.storyMap,
      fixture.storyMap.events[0]!.evidence[0]!,
    );
    const plan = fixture.impactPlans[0]!;
    const related = selectRelatedCanon({
      storyMap,
      impactPlan: plan,
      anchors: plan.anchors,
    });
    const legacyCanonEvents = JSON.stringify({
      sourceId: fixture.source.id,
      storyMapArtifactId: STORY_MAP_ARTIFACT_ID,
      storyMapId: storyMap.id,
      characters: storyMap.characters,
      events: related.events.map((event) => ({
        id: event.id,
        title: event.title,
        summary: event.summary,
        sequence: event.sequence,
        participants: event.participants,
        stateChanges: event.stateChanges,
      })),
      edges: related.edges,
      endingCandidates: related.endingCandidates,
    });
    const slimCanonEvents = buildCanonEventsSection({
      storyMap,
      storyMapArtifactId: STORY_MAP_ARTIFACT_ID,
      source: fixture.source,
      impactPlan: plan,
      anchors: plan.anchors,
    });
    const worldlineSetup = buildWorldlineSetup({ storyMap, plan });
    const baseSections = {
      worldlineSetup,
      pathSummary: "",
      canonEvidence: [],
      recentScenes: [],
      selectedDirection: "",
      anchorReminder: "严格模式锁定 Anchor。",
    };

    expect(legacyCanonEvents.length).toBeGreaterThan(
      DEFAULT_CONTINUATION_CONTEXT_MAX_CHARS,
    );
    expect(slimCanonEvents.length).toBeLessThan(
      DEFAULT_CONTINUATION_CONTEXT_MAX_CHARS,
    );

    let legacyError: unknown;
    try {
      assembleContext({
        maxChars: DEFAULT_CONTINUATION_CONTEXT_MAX_CHARS,
        sections: { ...baseSections, canonEvents: legacyCanonEvents },
      });
    } catch (error) {
      legacyError = error;
    }
    expect(legacyError).toBeInstanceOf(ContinuationContextBudgetError);
    expect(
      (legacyError as ContinuationContextBudgetError).neededChars,
    ).toBeGreaterThan(DEFAULT_CONTINUATION_CONTEXT_MAX_CHARS);

    const assembled = assembleContext({
      maxChars: DEFAULT_CONTINUATION_CONTEXT_MAX_CHARS,
      sections: { ...baseSections, canonEvents: slimCanonEvents },
    });
    expect(assembled.prompt.length).toBeLessThanOrEqual(
      DEFAULT_CONTINUATION_CONTEXT_MAX_CHARS,
    );
    expect(assembled.prompt).toContain(slimCanonEvents);
    expect(
      assembled.manifest.sections.find(
        (section) => section.kind === "canon_evidence",
      ),
    ).toMatchObject({ included: false, chars: 0 });
  });
});

describe("divergenceDependencyEventIds", () => {
  it("returns the divergence event and pre-divergence confirmed incoming sources only", async () => {
    const fixture = await loadRippleFixture();
    const storyMap = structuredClone(fixture.storyMap);
    const divergence = storyMap.events.find((event) => event.id === "event_07")!;
    const evidence = divergence.evidence[0]!;
    // 已确认、早于分歧的额外入边：应计入直接依赖。
    storyMap.edges.push({
      id: "edge_test_pre_incoming",
      from: "event_02",
      to: "event_07",
      type: "enables",
      explanation: "测试构造：分歧前的额外入边。",
      confidence: 0.5,
      confirmed: true,
      evidence: [{ ...evidence }],
    });
    // 晚于分歧的入边：不是直接依赖。
    storyMap.edges.push({
      id: "edge_test_post_incoming",
      from: "event_08",
      to: "event_07",
      type: "causes",
      explanation: "测试构造：分歧后的入边。",
      confidence: 0.5,
      confirmed: true,
      evidence: [{ ...evidence }],
    });
    // 未确认入边：不是直接依赖。
    storyMap.edges.push({
      id: "edge_test_unconfirmed_incoming",
      from: "event_05",
      to: "event_07",
      type: "foreshadows",
      explanation: "测试构造：未确认入边。",
      confidence: 0.5,
      confirmed: false,
      evidence: [{ ...evidence }],
    });

    const ids = divergenceDependencyEventIds(storyMap, "event_07");

    expect([...ids].sort()).toEqual(["event_02", "event_06", "event_07"]);
    // 从分歧事件出发的边（event_07 -> event_08）不算直接依赖。
    expect(ids.has("event_08")).toBe(false);
    expect(ids.has("event_05")).toBe(false);
  });

  it("includes dependency evidence even when it is not otherwise relevant", async () => {
    const fixture = await loadRippleFixture();
    const plan = structuredClone(fixture.impactPlans[0]!);
    plan.impacts = [];
    plan.anchorEvaluations = [];
    plan.anchors = [];

    const items = buildRelatedEvidenceItems({
      storyMap: fixture.storyMap,
      source: fixture.source,
      impactPlan: plan,
    });
    const ids = items.map((item) => item.id);

    expect(ids.some((id) => id.startsWith("related:event_07:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("related:event_06:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("related:event_08:"))).toBe(false);
  });
});

describe("capPinnedEvidence", () => {
  it("keeps divergence evidence first and caps dependencies deterministically", async () => {
    const fixture = await loadRippleFixture();
    const items = fixture.storyMap.events.flatMap((event) =>
      Array.from({ length: 3 }, (_, index) => ({
        id: `related:${event.id}:${index}`,
        text: `[${event.id}] 分歧前证据 ${index}。`,
        priority: 2,
        pinned: true,
      })),
    );
    const input = {
      items,
      storyMap: fixture.storyMap,
      divergenceEventId: "event_07",
    };
    const first = capPinnedEvidence(input);
    const second = capPinnedEvidence(input);

    expect(first.pinnedItemIds.length).toBeLessThanOrEqual(
      CONTEXT_PINNED_EVIDENCE_MAX_ITEMS,
    );
    expect(first.pinnedItemIds).toHaveLength(
      CONTEXT_PINNED_EVIDENCE_MAX_ITEMS,
    );
    // 分歧事件自身的证据全部保留（manifest 按渲染顺序记录）。
    expect(first.pinnedItemIds).toEqual(
      expect.arrayContaining([
        "related:event_07:0",
        "related:event_07:1",
        "related:event_07:2",
      ]),
    );
    expect(
      first.demotedItemIds.some((id) => id.startsWith("related:event_07:")),
    ).toBe(false);
    // 最近的直接依赖先拿到第二轮；最远的 event_01 只保留第一条。
    expect(first.pinnedItemIds).toEqual(
      expect.arrayContaining([
        "related:event_06:0",
        "related:event_06:1",
      ]),
    );
    // 轮转保证每条依赖事件都先拿到第一条；最远的 event_01 的其余条目被降级。
    expect(first.demotedItemIds).toEqual(
      expect.arrayContaining([
        "related:event_01:1",
        "related:event_01:2",
      ]),
    );
    expect(first.pinnedItemIds).toContain("related:event_01:0");
    // 确定性：同一输入逐项相同。
    expect(second.pinnedItemIds).toEqual(first.pinnedItemIds);
    expect(second.demotedItemIds).toEqual(first.demotedItemIds);
    // 超限条目仍留在候选中，只是降级为可裁剪证据；不在 droppedItemIds。
    expect(first.items).toHaveLength(items.length);
    for (const id of first.demotedItemIds) {
      const item = first.items.find((candidate) => candidate.id === id)!;
      expect(item.pinned).toBe(false);
      expect(item.demotedFromPinned).toBe(true);
    }
    expect(first.demotedItemIds).toHaveLength(
      items.length - CONTEXT_PINNED_EVIDENCE_MAX_ITEMS,
    );
  });

  it("applies the pinned character cap without changing the candidate list", async () => {
    const fixture = await loadRippleFixture();
    const items = fixture.storyMap.events.map((event) => ({
      id: `related:${event.id}:0`,
      text: "长".repeat(CONTEXT_PINNED_EVIDENCE_MAX_CHARS),
      priority: 2,
      pinned: true,
    }));
    const result = capPinnedEvidence({
      items,
      storyMap: fixture.storyMap,
      divergenceEventId: "event_07",
    });
    const pinnedChars = result.items
      .filter((item) => item.pinned)
      .reduce((total, item) => total + item.text.trim().length, 0);
    expect(pinnedChars).toBeLessThanOrEqual(
      CONTEXT_PINNED_EVIDENCE_MAX_CHARS,
    );
    expect(result.items).toHaveLength(items.length);
    expect(result.demotedItemIds.length).toBeGreaterThan(0);
  });
});

