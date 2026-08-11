import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import * as schemas from "@/domain/schemas";

const reference = {
  sourceId: "source_1",
  sectionId: "section_1",
  start: 0,
  end: 8,
  excerptHash: `sha256:${"a".repeat(64)}`,
};

const storyMapCandidate = {
  schemaVersion: 1,
  id: "story_map_1",
  sourceId: "source_1",
  version: 1,
  status: "draft",
  title: "测试故事",
  logline: "一个可校验的最小故事地图",
  characters: [
    {
      id: "character_1",
      name: "许澄",
      aliases: [],
      role: "protagonist",
      initialState: "尚未作出选择",
    },
  ],
  events: [
    {
      id: "event_1",
      title: "发现证据",
      summary: "许澄发现一份证据",
      sequence: 1,
      participants: ["character_1"],
      stateChanges: ["许澄知道证据存在"],
      evidenceKind: "fact",
      evidence: [reference],
    },
    {
      id: "event_2",
      title: "公开证据",
      summary: "证据进入公共记录",
      sequence: 2,
      participants: ["character_1"],
      stateChanges: ["公众获知证据"],
      evidenceKind: "fact",
      evidence: [reference],
    },
  ],
  edges: [
    {
      id: "edge_1_2",
      from: "event_1",
      to: "event_2",
      type: "causes",
      explanation: "发现证据后才能公开",
      confidence: 1,
      evidence: [reference],
      confirmed: true,
    },
  ],
  endingCandidates: [
    {
      id: "ending_1",
      targetEventId: "event_2",
      requirement: "证据进入公共记录",
      evidence: [reference],
    },
  ],
};

describe("core domain schemas", () => {
  it("exports the required SourceReference and Event contracts", () => {
    expect(schemas).toHaveProperty("SourceReferenceSchema");
    expect(schemas).toHaveProperty("CharacterSchema");
    expect(schemas).toHaveProperty("EventSchema");
  });

  it("requires StoryMap schema version 1 and from/to edges", () => {
    expect(schemas.StoryMapSchema.safeParse(storyMapCandidate).success).toBe(
      true,
    );
    expect(
      schemas.StoryMapSchema.safeParse({
        ...storyMapCandidate,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
  });

  it("rejects generated content as a Canon Story Map Event", () => {
    const generatedEvent = {
      ...storyMapCandidate,
      events: [
        {
          ...storyMapCandidate.events[0],
          evidenceKind: "generated",
          evidence: [],
        },
        storyMapCandidate.events[1],
      ],
    };

    expect(schemas.StoryMapSchema.safeParse(generatedEvent).success).toBe(false);
  });

  it("rejects IDs that cannot become stable Worldline fact keys", () => {
    expect(
      schemas.EventSchema.safeParse({
        ...storyMapCandidate.events[0],
        id: "事件 01",
      }).success,
    ).toBe(false);
    expect(
      schemas.DivergenceSchema.safeParse({
        id: "divergence/1",
        eventId: "event_1",
        type: "choice",
        instruction: "改变选择",
      }).success,
    ).toBe(false);
    expect(
      schemas.ImpactItemSchema.safeParse({
        id: "impact/1",
        scope: "direct",
        changeType: "modified",
        fromEventId: "event_1",
        affectedEventId: "event_1",
        summary: "改变事件",
        explanation: "分歧造成改变",
        reasonPath: ["event_1"],
        confidence: 1,
      }).success,
    ).toBe(false);
    expect(
      schemas.EndingCandidateSchema.safeParse({
        id: "结局 1",
        targetEventId: "event_2",
        requirement: "证据进入公共记录",
        evidence: [reference],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate Event IDs inside a reasonPath at the Schema boundary", () => {
    expect(
      schemas.ImpactItemSchema.safeParse({
        id: "impact_1",
        scope: "direct",
        changeType: "modified",
        fromEventId: "event_1",
        affectedEventId: "event_1",
        summary: "改变事件",
        explanation: "分歧造成改变",
        reasonPath: ["event_1", "event_1"],
        confidence: 1,
      }).success,
    ).toBe(false);
    expect(
      schemas.AnchorEvaluationSchema.safeParse({
        anchorId: "anchor_1",
        status: "rerouted",
        explanation: "通过新路径到达",
        reasonPath: ["event_1", "event_1", "event_2"],
      }).success,
    ).toBe(false);
  });

  it("accepts only prevent, choice, and outcome divergences", () => {
    for (const type of ["prevent", "choice", "outcome"] as const) {
      expect(
        schemas.DivergenceSchema.safeParse({
          id: `divergence_${type}`,
          eventId: "event_1",
          type,
          instruction: "改变这个事件",
        }).success,
      ).toBe(true);
    }

    expect(
      schemas.DivergenceSchema.safeParse({
        id: "divergence_legacy",
        eventId: "event_1",
        type: "alternate_choice",
        instruction: "使用旧枚举",
      }).success,
    ).toBe(false);
  });

  it("does not introduce a second soft-Anchor policy in M0", () => {
    expect(
      schemas.AnchorSchema.safeParse({
        id: "anchor_1",
        targetEventId: "event_2",
        requirement: "证据进入公共记录",
        strength: "soft",
      }).success,
    ).toBe(false);
  });

  it("represents direct, downstream, and ending impacts", () => {
    const result = schemas.ImpactPlanSchema.safeParse({
      id: "impact_plan_1",
      storyMapId: "story_map_1",
      mode: "strict",
      divergence: {
        id: "divergence_choice",
        eventId: "event_1",
        type: "choice",
        instruction: "许澄选择不公开证据",
      },
      anchors: [
        {
          id: "anchor_1",
          targetEventId: "event_2",
          requirement: "证据最终进入公共记录",
          strength: "hard",
        },
      ],
      impacts: [
        {
          id: "impact_direct",
          scope: "direct",
          changeType: "removed",
          fromEventId: "event_1",
          affectedEventId: "event_1",
          summary: "公开行动不发生",
          explanation: "选择直接移除原行动",
          reasonPath: ["event_1"],
          confidence: 1,
        },
        {
          id: "impact_downstream",
          scope: "downstream",
          changeType: "modified",
          fromEventId: "event_1",
          affectedEventId: "event_2",
          summary: "公众无法按原路径获知证据",
          explanation: "直接改变向后传导",
          reasonPath: ["event_1", "event_2"],
          confidence: 0.9,
        },
        {
          id: "impact_ending",
          scope: "ending",
          changeType: "modified",
          fromEventId: "event_1",
          affectedEventId: "event_2",
          summary: "公开结局需要新路径",
          explanation: "Anchor 不能再按原路径到达",
          reasonPath: ["event_1", "event_2"],
          confidence: 0.8,
        },
      ],
      characterChanges: [
        {
          characterId: "character_1",
          summary: "许澄继续独自保管证据",
        },
      ],
      threadChanges: {
        opened: ["证据如何经新路径公开"],
        closed: ["按原路径立即公开证据"],
      },
      anchorEvaluations: [
        {
          anchorId: "anchor_1",
          status: "rerouted",
          explanation: "仍可以通过新路径满足",
          reasonPath: ["event_1", "event_2"],
        },
      ],
      uncertainties: ["新路径需要多久"],
      status: "candidate",
    });

    expect(result.success).toBe(true);
  });

  it("requires explicit strict/open mode semantics", () => {
    const schema = schemas.ImpactPlanSchema;
    const base = {
      id: "impact_plan_open",
      storyMapId: "story_map_1",
      mode: "open",
      divergence: {
        id: "divergence_outcome",
        eventId: "event_2",
        type: "outcome",
        instruction: "公开事件发生但结果不同",
      },
      anchors: [],
      impacts: [
        {
          id: "impact_direct",
          scope: "direct",
          changeType: "modified",
          fromEventId: "event_2",
          affectedEventId: "event_2",
          summary: "公开结果改变",
          explanation: "分歧直接改变公开结果",
          reasonPath: ["event_2"],
          confidence: 1,
        },
      ],
      characterChanges: [],
      threadChanges: { opened: [], closed: [] },
      anchorEvaluations: [],
      uncertainties: [],
      status: "candidate",
    };

    expect(schema.safeParse(base).success).toBe(true);
    expect(
      schema.safeParse({
        ...base,
        mode: "open",
        anchors: [
          {
            id: "anchor_1",
            targetEventId: "event_2",
            requirement: "证据进入公共记录",
            strength: "hard",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("defines Continuation as generated content bound to one worldline", () => {
    const continuationSchema = Reflect.get(
      schemas,
      "ContinuationSchema",
    ) as ZodType | undefined;

    expect(continuationSchema).toBeDefined();
    expect(
      continuationSchema?.safeParse({
        schemaVersion: 1,
        id: "continuation_1",
        worldlineId: "worldline_1",
        acceptedImpactPlanId: "impact_plan_1",
        directionsArtifactId: "artifact_directions_1",
        selectedDirectionId: "direction_1",
        sequence: 1,
        title: "下一个场景",
        prose:
          "许澄没有沿用原来的移交路线。她带着仍由自己保管的红账走进雨夜，在沈砚的见证下重新封存原件。周岚只通过电话记录封条编号和时间，没有接触账簿。堤岸外的车灯扫过窗框时，许澄把钥匙收进口袋，决定等风暴过去便亲自提交证据。这个选择没有恢复已经被删除的移交事实，也没有改写原著基线。",
        statePatch: {
          factsAdded: [
            {
              key: "generated:scene_1",
              statement: "许澄在沈砚见证下重新封存红账。",
            },
          ],
          factsRemoved: [],
          characterChanges: [],
          threadsOpened: ["堤岸外车辆的身份"],
          threadsClosed: [],
        },
        contentKind: "generated",
        createdAt: "2026-08-11T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
