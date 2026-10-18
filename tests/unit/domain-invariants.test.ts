import { describe, expect, it } from "vitest";

import {
  assertValidStoryMap,
  validateImpactPlan,
  validateStoryMap,
} from "@/domain/invariants/validate-story-map";
import { validateAgainstPreDivergenceCanon } from "@/domain/invariants/validate-continuation";
import {
  ImpactPlanSchema,
  SourceSchema,
  StoryMapSchema,
  WorldlineDeltaSchema,
} from "@/domain/schemas";
import { sha256 } from "@/domain/source/normalize-source";

const normalizedText = "许澄发现证据。证据进入公共记录。";
const source = SourceSchema.parse({
  id: "source_1",
  projectId: "project_1",
  title: "测试故事",
  originalText: normalizedText,
  normalizedText,
  contentHash: sha256(normalizedText),
  sections: [
    {
      id: "section_1",
      title: "全文",
      start: 0,
      end: normalizedText.length,
    },
  ],
  createdAt: "2026-08-11T00:00:00.000Z",
});
const reference = {
  sourceId: source.id,
  sectionId: "section_1",
  start: 0,
  end: 8,
  excerptHash: sha256(normalizedText.slice(0, 8)),
};
const storyMap = StoryMapSchema.parse({
  schemaVersion: 1,
  id: "story_map_1",
  sourceId: source.id,
  version: 1,
  status: "confirmed",
  title: source.title,
  logline: "许澄让证据进入公共记录",
  characters: [
    {
      id: "character_1",
      name: "许澄",
      aliases: [],
      role: "protagonist",
      initialState: "不知道证据存在",
    },
  ],
  events: [
    {
      id: "event_1",
      title: "发现证据",
      summary: "许澄发现证据",
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
      explanation: "发现证据使公开成为可能",
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
});
const impactPlan = ImpactPlanSchema.parse({
  id: "impact_plan_1",
  storyMapId: storyMap.id,
  mode: "strict",
  divergence: {
    id: "divergence_1",
    eventId: "event_1",
    type: "choice",
    instruction: "许澄暂不公开证据",
  },
  anchors: [
    {
      id: "anchor_1",
      targetEventId: "event_2",
      requirement: "证据进入公共记录",
      strength: "hard",
    },
  ],
  impacts: [
    {
      id: "impact_1",
      scope: "direct",
      changeType: "modified",
      fromEventId: "event_1",
      affectedEventId: "event_1",
      summary: "证据暂时不公开",
      explanation: "选择直接延后公开",
      reasonPath: ["event_1"],
      confidence: 1,
    },
    {
      id: "impact_downstream",
      scope: "downstream",
      changeType: "modified",
      fromEventId: "event_1",
      affectedEventId: "event_2",
      summary: "公众不能按原时间获知证据",
      explanation: "延后公开会改变下游知情状态",
      reasonPath: ["event_1", "event_2"],
      confidence: 0.9,
    },
    {
      id: "impact_2",
      scope: "ending",
      changeType: "modified",
      fromEventId: "event_1",
      affectedEventId: "event_2",
      summary: "公开结局需要改道",
      explanation: "延后后必须有新的公开行动",
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
    opened: ["何时公开证据"],
    closed: ["按原时间公开证据"],
  },
  anchorEvaluations: [
    {
      anchorId: "anchor_1",
      status: "rerouted",
      explanation: "结局仍可经新路径达成",
      reasonPath: ["event_1", "event_2"],
    },
  ],
  uncertainties: ["新路径的时间成本"],
  status: "candidate",
});

describe("deterministic domain validators", () => {
  it("accepts a structurally and referentially valid StoryMap", () => {
    expect(validateStoryMap(storyMap, source)).toEqual([]);
  });

  it("rejects non-contiguous event sequence values", () => {
    const invalid = structuredClone(storyMap);
    invalid.events[1].sequence = 3;

    expect(validateStoryMap(invalid, source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("连续") }),
      ]),
    );
  });

  it("throws a diagnostic error for duplicate IDs", () => {
    const invalid = structuredClone(storyMap);
    invalid.events[1].id = invalid.events[0].id;

    expect(() => assertValidStoryMap(invalid, source)).toThrow(
      "重复事件 ID",
    );
  });

  it("rejects a Character that cannot be traced through an evidenced Event", () => {
    const invalid = structuredClone(storyMap);
    invalid.characters.push({
      id: "character_untraced",
      name: "无证人物",
      aliases: [],
      role: "supporting",
      initialState: "没有任何事件证据",
    });

    expect(validateStoryMap(invalid, source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("有 Evidence 的 Event") }),
      ]),
    );
  });

  it("accepts a valid ImpactPlan", () => {
    expect(validateImpactPlan(impactPlan, storyMap)).toEqual([]);
  });

  it("keeps legacy plans without uncertain ids valid", () => {
    const legacy = ImpactPlanSchema.parse({
      ...structuredClone(impactPlan),
      uncertainEdgeIds: undefined,
      uncertainImpactIds: undefined,
      usedUncertainEdgeIds: undefined,
    });

    expect(legacy.uncertainEdgeIds).toBeUndefined();
    expect(validateImpactPlan(legacy, storyMap)).toEqual([]);
  });

  it("rejects uncertain Edge ids that do not exist in the bound Story Map", () => {
    const invalid = structuredClone(impactPlan);
    invalid.uncertainEdgeIds = ["edge_1_2", "edge_missing"];
    invalid.usedUncertainEdgeIds = ["edge_missing"];

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "uncertainEdgeIds.1",
          message: expect.stringContaining("未知 Edge"),
        }),
        expect.objectContaining({
          path: "usedUncertainEdgeIds.0",
          message: expect.stringContaining("未知 Edge"),
        }),
      ]),
    );
  });

  it("rejects missing reasonPath nodes", () => {
    const invalid = structuredClone(impactPlan);
    invalid.impacts[0].reasonPath = ["event_missing"];

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("reasonPath"),
        }),
      ]),
    );
  });

  it("requires every Impact reasonPath to contain the Divergence Event", () => {
    const invalid = structuredClone(impactPlan);
    invalid.impacts[1].fromEventId = "event_2";
    invalid.impacts[1].reasonPath = ["event_2"];

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("Divergence Event"),
        }),
      ]),
    );
  });

  it("requires a direct Impact reasonPath to start at the Divergence Event", () => {
    const invalid = structuredClone(impactPlan);
    invalid.impacts[0].fromEventId = "event_2";
    invalid.impacts[0].reasonPath = ["event_2", "event_1"];

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("direct Impact"),
        }),
      ]),
    );
  });

  it("requires affectedEventId to be the last Impact reasonPath node", () => {
    const invalid = structuredClone(impactPlan);
    invalid.impacts[1].reasonPath = ["event_1"];

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("affectedEventId"),
        }),
      ]),
    );
  });

  it("requires every Anchor reasonPath to start at Divergence and end at its target", () => {
    const wrongStart = structuredClone(impactPlan);
    wrongStart.anchorEvaluations[0].reasonPath = ["event_2"];
    const missingTarget = structuredClone(impactPlan);
    missingTarget.anchorEvaluations[0].reasonPath = ["event_1"];

    expect(validateImpactPlan(wrongStart, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("Divergence Event"),
        }),
      ]),
    );
    expect(validateImpactPlan(missingTarget, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("targetEventId"),
        }),
      ]),
    );
  });

  it("rejects repeated Events in Impact and Anchor reasonPaths", () => {
    const invalid = structuredClone(impactPlan);
    invalid.impacts[0].reasonPath = ["event_1", "event_1"];
    invalid.anchorEvaluations[0].reasonPath = [
      "event_1",
      "event_1",
      "event_2",
    ];

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "impacts.0.reasonPath",
          message: expect.stringContaining("重复 Event"),
        }),
        expect.objectContaining({
          path: "anchorEvaluations.0.reasonPath",
          message: expect.stringContaining("重复 Event"),
        }),
      ]),
    );
  });

  it("rejects unknown Divergence and Anchor targets", () => {
    const invalid = structuredClone(impactPlan);
    invalid.divergence.eventId = "event_missing";
    invalid.anchors[0].targetEventId = "event_missing";

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Divergence") }),
        expect.objectContaining({ message: expect.stringContaining("Anchor") }),
      ]),
    );
  });

  it("requires exactly one evaluation for every Anchor", () => {
    const invalid = structuredClone(impactPlan);
    invalid.anchorEvaluations = [];

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("缺少 Anchor 评估"),
        }),
      ]),
    );
  });

  it("requires direct, downstream, and ending impact groups", () => {
    const invalid = structuredClone(impactPlan);
    invalid.impacts = invalid.impacts.filter(
      (impact) => impact.scope !== "downstream",
    );

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("downstream"),
        }),
      ]),
    );
  });

  it("requires an impact origin and affected Event that agree with reasonPath", () => {
    const invalid = structuredClone(impactPlan);
    invalid.impacts[0].fromEventId = "event_2";
    invalid.impacts[0].affectedEventId = "event_missing";

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("fromEventId"),
        }),
        expect.objectContaining({
          message: expect.stringContaining("affectedEventId"),
        }),
      ]),
    );
  });

  it("rejects unknown Character state changes", () => {
    const invalid = structuredClone(impactPlan);
    invalid.characterChanges[0].characterId = "character_missing";

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("未知人物"),
        }),
      ]),
    );
  });

  it("rejects an ImpactPlan that cannot form an unambiguous Delta", () => {
    const invalid = structuredClone(impactPlan);
    invalid.characterChanges.push(structuredClone(invalid.characterChanges[0]));
    invalid.threadChanges.opened.push(invalid.threadChanges.opened[0]);
    invalid.threadChanges.closed.push(invalid.threadChanges.opened[0]);

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("重复人物") }),
        expect.objectContaining({ message: expect.stringContaining("重复开启") }),
        expect.objectContaining({ message: expect.stringContaining("同时开启和关闭") }),
      ]),
    );
  });

  it("requires strict Anchors to match confirmed ending candidates", () => {
    const invalid = structuredClone(impactPlan);
    invalid.anchors[0].requirement = "模型自行发明的结局要求";

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("Ending Candidate"),
        }),
      ]),
    );
  });

  it("keeps pre-divergence facts immutable in open mode", () => {
    const invalid = structuredClone(impactPlan);
    invalid.mode = "open";
    invalid.anchors = [];
    invalid.anchorEvaluations = [];
    invalid.divergence.eventId = "event_2";
    invalid.impacts[0].affectedEventId = "event_1";

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("分歧前事实"),
        }),
      ]),
    );
  });

  it("keeps pre-divergence facts immutable in strict mode", () => {
    const invalid = structuredClone(impactPlan);
    invalid.divergence.eventId = "event_2";
    invalid.impacts[0].affectedEventId = "event_1";

    expect(validateImpactPlan(invalid, storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("分歧前事实"),
        }),
      ]),
    );
  });
});

describe("post-generation pre-divergence canon validation", () => {
  /** 分歧事件是 event_2（sequence 2）；event_1 是分歧前、event_2 是分歧点。 */
  const pathState = WorldlineDeltaSchema.parse({
    factsAdded: [
      { key: "generated:branch_1", statement: "许澄暂时没有公开证据。" },
    ],
    factsRemoved: ["event:event_2"],
    characterChanges: [],
    threadsOpened: [],
    threadsClosed: [],
  });

  function evaluate(textFields: string[]) {
    return validateAgainstPreDivergenceCanon({
      textFields: textFields.map((text, index) => ({
        field: `textFields.${index}`,
        text,
      })),
      storyMap,
      divergenceEventId: "event_2",
      pathState,
    });
  }

  function validate(textFields: string[]) {
    return evaluate(textFields).issues;
  }

  it("flags prose that says a locked event did not happen", () => {
    expect(
      validate(["许澄发现证据根本没有发生过，公众始终不知道真相。"]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("发现证据"),
        }),
      ]),
    );
  });

  it("allows rewriting an event that the path removed", () => {
    expect(validate(["公开证据并未发生，许澄从一开始就保持沉默。"])).toEqual([]);
  });

  it("never locks post-divergence events", () => {
    const result = validateAgainstPreDivergenceCanon({
      textFields: [
        { field: "prose", text: "公开证据并未发生，许澄从一开始就保持沉默。" },
      ],
      storyMap,
      divergenceEventId: "event_1",
      pathState: WorldlineDeltaSchema.parse({
        factsAdded: [],
        factsRemoved: [],
        characterChanges: [],
        threadsOpened: [],
        threadsClosed: [],
      }),
    });
    expect(result.issues).toEqual([]);
  });

  it("allows clean prose that mentions a locked event without a cue", () => {
    expect(validate(["许澄发现证据后选择沉默，把副本留在抽屉里。"])).toEqual(
      [],
    );
  });

  it("does not hard-reject a bare negation immediately before a locked title", () => {
    const result = evaluate(["没有发现证据，也没有留下任何记录。"]);
    expect(result.issues).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("does not hard-reject counterfactual or loss-framed sentences", () => {
    for (const text of [
      "如果没有发现证据，两人也不会结仇。",
      "再也没有了发现证据那晚的热闹。",
      "没有发现证据那天的任何记录留下来。",
    ]) {
      const result = evaluate([text]);
      expect(result.issues).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  it("still hard-rejects an explicit occurrence negation", () => {
    for (const text of [
      "发现证据从未发生。",
      "发现证据根本没有发生过。",
      "从来没有发生过发现证据。",
      "发现证据是捏造的。",
    ]) {
      expect(validate([text])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "textFields.0",
            message: expect.stringContaining("发现证据"),
          }),
        ]),
      );
    }
  });

  it("flags a direction premise that rewrites a locked event", () => {
    expect(
      validate([
        "让周岚只做见证",
        "发现证据根本没有发生过，周岚只记录未公开的判断。",
        "独立见证链得到补强。",
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "textFields.1",
          message: expect.stringContaining("发现证据"),
        }),
      ]),
    );
  });

  it("does not hard-reject recollection or causal mentions", () => {
    const result = evaluate([
      "她想起发现证据那晚，从此不再靠近海岸。",
      "他始终没有忘记发现证据时的那声钟响。",
      "因为发现证据，许澄不再公开露面。",
    ]);
    expect(result.issues).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("skips empty and one-character fields", () => {
    expect(validate(["", "证"])).toEqual([]);
  });
});
