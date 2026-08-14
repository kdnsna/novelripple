import { describe, expect, it } from "vitest";

import {
  selectContinuationContext,
  CONTINUATION_CONTEXT_MAX_BUDGET_CHARS,
  CONTINUATION_CONTEXT_MAX_SOURCE_RATIO,
  type ContinuationContextPacket,
} from "@/domain/continuation/select-continuation-context";
import { sha256 } from "@/domain/source/normalize-source";
import { StoryMapArtifactSchema } from "@/domain/schemas";
import { createWorldline } from "@/domain/services/create-worldline";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

async function buildInput() {
  const fixture = await loadRippleFixture();
  const storyMapArtifact = StoryMapArtifactSchema.parse({
    id: "artifact_story_map_ripple_001_confirmed",
    projectId: "project_ripple_001",
    sourceId: fixture.storyMap.sourceId,
    kind: "story_map_revision",
    schemaVersion: 2,
    version: 2,
    storyMap: { ...fixture.storyMap, version: 2, status: "confirmed" },
    review: { evidenceConfirmations: [] },
    basedOnArtifactId: "artifact_story_map_ripple_001_draft",
    generationRunId: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  });

  const impactPlan = {
    ...fixture.impactPlans[0],
    id: "artifact_impact_plan_accepted",
    storyMapId: storyMapArtifact.storyMap.id,
    status: "accepted" as const,
  };
  const acceptedImpactPlanArtifact = {
    id: "artifact_impact_plan_accepted",
    projectId: "project_ripple_001",
    sourceId: fixture.storyMap.sourceId,
    storyMapArtifactId: storyMapArtifact.id,
    kind: "impact_plan" as const,
    schemaVersion: 1 as const,
    impactPlan,
    basedOnArtifactId: storyMapArtifact.id,
    generationRunId: null,
    lineage: null,
    createdAt: "2026-08-11T02:00:00.000Z",
  };

  const worldline = createWorldline({
    projectId: storyMapArtifact.projectId,
    parentWorldlineId: "wl_canonical",
    baseStoryMapArtifact: storyMapArtifact,
    impactPlan,
    mode: "strict",
    createdAt: "2026-08-11T03:00:00.000Z",
  });

  const selectedDirection = {
    id: "direction_01",
    title: "许澄沿灯塔北侧的石阶离开",
    premise: "许澄把红账原件与备份分开存放，独自经北侧石阶离开潮标站。",
    affectedCharacterIds: ["char_xucheng", "char_zhoulan"],
    expectedConsequence: "红账暂时脱离顾闻舟的监视范围，周岚在明早轮渡前完成誊录。",
  };

  return {
    fixture,
    input: {
      storyMap: storyMapArtifact.storyMap,
      source: fixture.source,
      worldline,
      acceptedImpactPlan: acceptedImpactPlanArtifact,
      selectedDirection,
    },
  };
}

describe("selectContinuationContext (M1-06 T1)", () => {
  it("deterministic：同输入两次输出逐字节相等", async () => {
    const { input } = await buildInput();
    const first = selectContinuationContext(input);
    const second = selectContinuationContext(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("source grounded：所有片段 offset 在 normalizedText 边界内且切片与 excerptHash 一致", async () => {
    const { fixture, input } = await buildInput();
    const packet = selectContinuationContext(input);
    const text = fixture.source.normalizedText;

    const allExcerpts = [
      ...packet.representativeExcerpts,
      ...packet.characterEvidence,
    ];
    expect(allExcerpts.length).toBeGreaterThan(0);

    for (const excerpt of allExcerpts) {
      expect(excerpt.start).toBeGreaterThanOrEqual(0);
      expect(excerpt.end).toBeLessThanOrEqual(text.length);
      expect(excerpt.start).toBeLessThan(excerpt.end);
      const sliced = text.slice(excerpt.start, excerpt.end);
      expect(sliced).toBe(excerpt.excerpt);
      expect(excerpt.excerptHash).toBe(sha256(sliced));
    }
  });

  it("representative excerpts 覆盖四种窗口（opening/middle/ending/divergence）", async () => {
    const { input } = await buildInput();
    const packet = selectContinuationContext(input);
    const kinds = packet.representativeExcerpts.map((excerpt) => excerpt.kind);
    for (const kind of ["opening", "middle", "ending", "divergence"] as const) {
      expect(kinds).toContain(kind);
    }
  });

  it("selected characters 相关 Evidence 只含方向人物参与的事件", async () => {
    const { input } = await buildInput();
    const packet = selectContinuationContext(input);
    const affected = new Set(input.selectedDirection.affectedCharacterIds);
    for (const excerpt of packet.characterEvidence) {
      expect(affected.has(excerpt.characterId)).toBe(true);
      const event = input.storyMap.events.find(
        (event) => event.id === excerpt.eventId,
      );
      expect(event?.participants).toContain(excerpt.characterId);
    }
  });

  it("no whole source：内嵌文本总字符 < Source 25% 且 ≤ 预算", async () => {
    const { fixture, input } = await buildInput();
    const packet = selectContinuationContext(input);
    const sourceLength = fixture.source.normalizedText.length;

    expect(packet.budget.totalChars).toBeLessThan(
      sourceLength * CONTINUATION_CONTEXT_MAX_SOURCE_RATIO,
    );
    expect(packet.budget.totalChars).toBeLessThanOrEqual(
      CONTINUATION_CONTEXT_MAX_BUDGET_CHARS,
    );
  });

  it("max context budget：任意输入 packet ≤ 预算常量（6000）", async () => {
    const { input } = await buildInput();
    const packet = selectContinuationContext(input);
    expect(packet.budget.totalChars).toBeLessThanOrEqual(
      CONTINUATION_CONTEXT_MAX_BUDGET_CHARS,
    );
    expect(packet.budget.effectiveBudgetChars).toBeGreaterThan(0);
    expect(packet.budget.totalChars).toBeLessThan(
      packet.budget.effectiveBudgetChars,
    );
  });

  it("纯函数：不改动输入对象", async () => {
    const { input } = await buildInput();
    const snapshot = JSON.stringify(input);
    selectContinuationContext(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("类型导出：packet 结构完整（sourceId/窗口/人物证据/预算）", async () => {
    const { input } = await buildInput();
    const packet: ContinuationContextPacket = selectContinuationContext(input);
    expect(packet.sourceId).toBe(input.source.id);
    expect(Array.isArray(packet.representativeExcerpts)).toBe(true);
    expect(Array.isArray(packet.characterEvidence)).toBe(true);
    expect(packet.budget.maxBudgetChars).toBe(
      CONTINUATION_CONTEXT_MAX_BUDGET_CHARS,
    );
    expect(packet.budget.maxSourceRatio).toBe(
      CONTINUATION_CONTEXT_MAX_SOURCE_RATIO,
    );
  });
});
