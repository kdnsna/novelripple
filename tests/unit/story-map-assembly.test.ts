import { describe, expect, it } from "vitest";

import type {
  Character,
  StoryMapCandidateEdge,
  StoryMapCandidateEnding,
  StoryMapCandidateEvent,
  StoryMapContentCandidate,
  StoryMapEndingPassCandidate,
  StoryMapRosterCandidate,
} from "@/domain/schemas";
import type { EvidenceUnit } from "@/domain/source/evidence-units";
import {
  deriveNameCandidates,
  isCollectiveName,
} from "@/domain/source/name-candidates";
import {
  applyEndingPass,
  applyMerge,
  applyRoster,
  canRejectRosterCandidate,
  CHARACTER_ENDING_PREFIX,
  cleanupCandidateIds,
  dedupeEdges,
  dedupeEndings,
  dropGroupCandidates,
  validateEndingPass,
  validateRoster,
  type StoryMapPool,
} from "@/domain/story-map/assemble-story-map-candidate";

function character(id: string, name: string, aliases: string[] = []): Character {
  return { id, name, aliases, role: "protagonist", initialState: "刚回到港城" };
}

function event(
  id: string,
  unitId: string,
  participants = ["char_lin"],
  sequence = 1,
): StoryMapCandidateEvent {
  return {
    id,
    title: id,
    summary: id,
    sequence,
    participants,
    stateChanges: [],
    evidenceKind: "fact",
    evidenceUnitIds: [unitId],
  };
}

function textUnit(id: string, text: string): EvidenceUnit {
  return { id, sourceId: "source_test", sectionId: "section_01", start: 0, end: text.length, text };
}

describe("roster pass", () => {
  const pool: StoryMapPool = {
    characters: [character("char_lin", "林舟"), character("char_lin__c2", "林舟")],
    events: [
      { ...event("event_meet", "u1", ["char_lin"]), chunkIndex: 0 },
      { ...event("event_talk", "u2", ["char_lin__c2"]), chunkIndex: 1 },
    ],
    edges: [],
  };

  it("merges aliases and rewires every participant to the final character", () => {
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_lin",
          name: "林舟",
          aliases: ["阿舟"],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_lin", "char_lin__c2"],
        },
      ],
      rejectedCandidateIds: [],
    };

    expect(validateRoster(roster, pool)).toEqual([]);
    const applied = applyRoster(pool, roster);

    expect(applied.characters).toEqual([
      {
        id: "char_lin",
        name: "林舟",
        aliases: ["阿舟"],
        role: "protagonist",
        initialState: "刚回到港城",
      },
    ]);
    expect(applied.events.map((item) => item.participants)).toEqual([
      ["char_lin"],
      ["char_lin"],
    ]);
  });

  it("unions roster aliases with every merged candidate name and alias in order", () => {
    const unionPool: StoryMapPool = {
      characters: [
        { ...character("char_shen", "沈砚", ["沈公子"]), kind: "individual" },
        { ...character("char_shen__c2", "沈砚", ["砚哥"]), kind: "individual" },
        {
          ...character("char_shen__c3", "沈三", [" 三哥 ", "沈先生", "围观的人群"]),
          kind: "individual",
        },
      ],
      events: [],
      edges: [],
    };
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_shen",
          name: "沈砚",
          aliases: [" 阿砚 ", " 沈公子 ", "沈砚", "", "围观的人群"],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_shen", "char_shen__c2", "char_shen__c3"],
        },
      ],
      rejectedCandidateIds: [],
    };

    expect(applyRoster(unionPool, roster).characters[0]!.aliases).toEqual([
      "阿砚",
      "沈公子",
      "砚哥",
      "沈三",
      "三哥",
      "沈先生",
    ]);
  });

  it("excludes aliases that match the final name after roster normalization", () => {
    const normalizedPool: StoryMapPool = {
      characters: [
        { ...character("char_ab", "Ａ Ｂ", ["ＡＢ"]), kind: "individual" },
        { ...character("char_ab__c2", " A  B ", ["a b"]), kind: "individual" },
      ],
      events: [],
      edges: [],
    };
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_ab",
          name: "Ａ Ｂ",
          aliases: ["a  b", "阿比"],
          role: "supporting",
          initialState: "刚回到港城",
          mergedFrom: ["char_ab", "char_ab__c2"],
        },
      ],
      rejectedCandidateIds: [],
    };

    expect(applyRoster(normalizedPool, roster).characters[0]!.aliases).toEqual(["阿比", "ＡＢ"]);
  });

  it("caps merged aliases at 12, keeping roster-pass aliases first", () => {
    const cappedPool: StoryMapPool = {
      characters: [
        character("char_lin", "林舟", ["候选甲"]),
        character("char_lin__c2", "林舟", ["候选乙", "候选丙"]),
      ],
      events: [],
      edges: [],
    };
    const rosterAliases = Array.from({ length: 12 }, (_, index) => `别名${index + 1}`);
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_lin",
          name: "林舟",
          aliases: rosterAliases,
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_lin", "char_lin__c2"],
        },
      ],
      rejectedCandidateIds: [],
    };

    expect(applyRoster(cappedPool, roster).characters[0]!.aliases).toEqual(rosterAliases);
  });

  it("keeps identities separate when the roster is not certain they are the same person", () => {
    const separatePool: StoryMapPool = {
      characters: [character("char_lin", "林舟"), character("char_lin__c2", "林周")],
      events: [
        { ...event("event_meet", "u1", ["char_lin"]), chunkIndex: 0 },
        { ...event("event_talk", "u2", ["char_lin__c2"]), chunkIndex: 1 },
      ],
      edges: [],
    };
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_lin",
          name: "林舟",
          aliases: [],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_lin"],
        },
        {
          id: "char_lin__c2",
          name: "林周",
          aliases: [],
          role: "supporting",
          initialState: "在码头等人",
          mergedFrom: ["char_lin__c2"],
        },
      ],
      rejectedCandidateIds: [],
    };

    expect(validateRoster(roster, separatePool)).toEqual([]);
    const applied = applyRoster(separatePool, roster);

    expect(applied.characters.map((item) => [item.id, item.name])).toEqual([
      ["char_lin", "林舟"],
      ["char_lin__c2", "林周"],
    ]);
    expect(applied.events.map((item) => item.participants)).toEqual([
      ["char_lin"],
      ["char_lin__c2"],
    ]);
  });

  it("rejects a wrong merge when a candidate name is neither the merged name nor an alias", () => {
    const wrongPool: StoryMapPool = {
      characters: [
        character("char_lin", "林舟"),
        character("char_lin__c2", " 林周 "),
      ],
      events: [],
      edges: [],
    };
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_lin",
          name: "林舟",
          aliases: ["阿舟"],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_lin", "char_lin__c2"],
        },
      ],
      rejectedCandidateIds: [],
    };

    expect(validateRoster(roster, wrongPool)).toEqual([
      {
        path: "characters.0.mergedFrom.1",
        message:
          "合并候选取名不一致：char_lin__c2 的 name 是“ 林周 ”，合并后人物是“林舟”；" +
          "候选名必须等于 name 或出现在 aliases 中",
      },
    ]);

    roster.characters[0]!.aliases = [" 阿舟 ", " 林周 "];
    expect(validateRoster(roster, wrongPool)).toEqual([]);
  });

  it("normalizes full-width, case and inner whitespace before the wrong-merge guard", () => {
    const normalizedPool: StoryMapPool = {
      characters: [
        character("char_ab", "ＡＢ"),
        character("char_ab__c2", " A  B "),
      ],
      events: [],
      edges: [],
    };
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_ab",
          name: "ab",
          aliases: [" A  B "],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_ab", "char_ab__c2"],
        },
      ],
      rejectedCandidateIds: [],
    };

    expect(validateRoster(roster, normalizedPool)).toEqual([]);
  });

  it("rejects unknown candidate IDs and every candidate that is not assigned exactly once", () => {
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_lin",
          name: "林舟",
          aliases: [],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_lin", "char_missing"],
        },
      ],
      rejectedCandidateIds: [],
    };

    expect(validateRoster(roster, pool)).toEqual([
      {
        path: "characters.0.mergedFrom.1",
        message: "mergedFrom 引用了未知人物候选：char_missing",
      },
      {
        path: "characters",
        message: "人物候选没有归入任何人物：char_lin__c2",
      },
    ]);
  });

  it("requires every candidate to be merged or explicitly rejected exactly once", () => {
    const rejectionPool: StoryMapPool = {
      characters: [
        character("char_lin", "林舟"),
        character("char_crowd", "围观的人群"),
        character("char_narrator", "旁白者"),
      ],
      events: [
        { ...event("event_meet", "u1", ["char_lin"]), chunkIndex: 0 },
      ],
      edges: [],
    };
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_lin",
          name: "林舟",
          aliases: [],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_lin"],
        },
      ],
      rejectedCandidateIds: ["char_crowd", "char_narrator"],
    };

    expect(validateRoster(roster, rejectionPool)).toEqual([]);

    expect(
      validateRoster({ ...roster, rejectedCandidateIds: ["char_narrator"] }, rejectionPool),
    ).toEqual([{ path: "characters", message: "人物候选没有归入任何人物：char_crowd" }]);
    expect(
      validateRoster(
        { ...roster, rejectedCandidateIds: ["char_crowd", "char_narrator", "char_crowd"] },
        rejectionPool,
      ),
    ).toEqual([{ path: "characters", message: "人物候选被归入多个人物：char_crowd" }]);
    expect(
      validateRoster(
        {
          characters: [
            roster.characters[0]!,
            {
              id: "char_crowd",
              name: "围观的人群",
              aliases: [],
              role: "minor",
              initialState: "在码头围观",
              mergedFrom: ["char_crowd"],
            },
          ],
          rejectedCandidateIds: ["char_crowd", "char_narrator"],
        },
        rejectionPool,
      ),
    ).toEqual([{ path: "characters", message: "人物候选被归入多个人物：char_crowd" }]);
    expect(
      validateRoster({ ...roster, rejectedCandidateIds: ["char_crowd", "char_narrator", "char_unknown"] }, rejectionPool),
    ).toEqual([
      {
        path: "rejectedCandidateIds.2",
        message: "rejectedCandidateIds 引用了未知人物候选：char_unknown",
      },
    ]);
  });

  it("merges brief, nameless or peripheral individuals as minor instead of rejecting them", () => {
    const minorPool: StoryMapPool = {
      characters: [
        { ...character("char_lin", "林舟"), kind: "individual" },
        { ...character("char_porter", "码头脚夫"), kind: "individual" },
        { ...character("char_crowd", "围观的人群"), kind: "group" },
      ],
      events: [
        {
          ...event("event_meet", "u1", ["char_lin", "char_porter", "char_crowd"]),
          chunkIndex: 0,
        },
      ],
      edges: [],
    };
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_lin",
          name: "林舟",
          aliases: [],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_lin"],
        },
        {
          id: "char_porter",
          name: "码头脚夫",
          aliases: [],
          role: "minor",
          initialState: "在码头搬货",
          mergedFrom: ["char_porter"],
        },
      ],
      rejectedCandidateIds: ["char_crowd"],
    };

    expect(validateRoster(roster, minorPool)).toEqual([]);
    const applied = applyRoster(minorPool, roster);
    expect(applied.characters).toEqual([
      expect.objectContaining({ id: "char_lin", role: "protagonist" }),
      expect.objectContaining({ id: "char_porter", role: "minor" }),
    ]);
    expect(applied.events[0]!.participants).toEqual(["char_lin", "char_porter"]);
  });

  it("demotes a rejected individual to its own minor character instead of failing validation", () => {
    const pool: StoryMapPool = {
      characters: [
        { ...character("char_lin", "林舟"), kind: "individual" },
        { ...character("char_porter", "码头脚夫", ["脚夫"]), kind: "individual" },
        character("char_crowd", "围观的人群"),
        character("char_narrator", "旁白者"),
      ],
      events: [
        { ...event("event_meet", "u1", ["char_lin", "char_porter"]), chunkIndex: 0 },
      ],
      edges: [],
    };
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_lin",
          name: "林舟",
          aliases: [],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_lin"],
        },
      ],
      rejectedCandidateIds: ["char_porter", "char_crowd", "char_narrator"],
    };

    expect(validateRoster(roster, pool)).toEqual([]);

    const applied = applyRoster(pool, roster);
    expect(applied.characters).toEqual([
      expect.objectContaining({ id: "char_lin", role: "protagonist" }),
      expect.objectContaining({
        id: "char_porter",
        name: "码头脚夫",
        aliases: ["脚夫"],
        role: "minor",
      }),
    ]);
    expect(applied.characters.map((item) => item.id)).not.toContain("char_crowd");
    expect(applied.characters.map((item) => item.id)).not.toContain("char_narrator");
    expect(applied.events[0]!.participants).toEqual(["char_lin", "char_porter"]);
  });

  it("drops a rejected mention-only candidate but still demotes event participants", () => {
    const pool: StoryMapPool = {
      characters: [
        { ...character("char_lin", "林舟"), kind: "individual" },
        { ...character("char_porter", "码头脚夫"), kind: "individual" },
        { ...character("char_rumor", "传闻中的船主"), kind: "individual" },
      ],
      events: [
        {
          ...event("event_meet", "u1", ["char_lin", "char_porter"]),
          chunkIndex: 0,
        },
      ],
      edges: [],
    };
    const participants = new Set(
      pool.events.flatMap((item) => item.participants),
    );
    const mentioned = {
      ...character("char_rumor", "传闻中的船主"),
      kind: "individual" as const,
    };
    const porter = {
      ...character("char_porter", "码头脚夫"),
      kind: "individual" as const,
    };
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_lin",
          name: "林舟",
          aliases: [],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_lin"],
        },
      ],
      rejectedCandidateIds: ["char_rumor", "char_porter"],
    };

    expect(canRejectRosterCandidate(mentioned, participants)).toBe(true);
    expect(canRejectRosterCandidate(porter, participants)).toBe(false);
    expect(validateRoster(roster, pool)).toEqual([]);

    const applied = applyRoster(pool, roster);
    expect(applied.characters).toEqual([
      expect.objectContaining({ id: "char_lin", role: "protagonist" }),
      expect.objectContaining({
        id: "char_porter",
        name: "码头脚夫",
        role: "minor",
      }),
    ]);
    expect(applied.characters.map((item) => item.id)).not.toContain(
      "char_rumor",
    );
    expect(applied.events[0]!.participants).toEqual(["char_lin", "char_porter"]);
  });

  it("removes rejected candidates from characters and participants, keeping one only when an event would be empty", () => {
    const rejectionPool: StoryMapPool = {
      characters: [
        character("char_lin", "林舟"),
        character("char_crowd", "围观的人群"),
        character("char_narrator", "旁白者"),
      ],
      events: [
        { ...event("event_meet", "u1", ["char_lin", "char_crowd"]), chunkIndex: 0 },
        { ...event("event_rumor", "u2", ["char_crowd"]), chunkIndex: 1 },
      ],
      edges: [],
    };
    const roster: StoryMapRosterCandidate = {
      characters: [
        {
          id: "char_lin",
          name: "林舟",
          aliases: [],
          role: "protagonist",
          initialState: "刚回到港城",
          mergedFrom: ["char_lin"],
        },
      ],
      rejectedCandidateIds: ["char_crowd", "char_narrator"],
    };

    expect(validateRoster(roster, rejectionPool)).toEqual([]);
    const applied = applyRoster(rejectionPool, roster);

    expect(applied.characters).toEqual([
      {
        id: "char_lin",
        name: "林舟",
        aliases: [],
        role: "protagonist",
        initialState: "刚回到港城",
      },
      {
        id: "char_crowd",
        name: "围观的人群",
        aliases: [],
        role: "protagonist",
        initialState: "刚回到港城",
      },
    ]);
    expect(applied.events.map((item) => item.participants)).toEqual([
      ["char_lin"],
      ["char_crowd"],
    ]);
  });
});

describe("ending pass", () => {
  const pool: StoryMapPool = {
    characters: [character("char_shen", "沈砚")],
    events: [
      { ...event("event_storm", "u1", ["char_shen"]), chunkIndex: 0 },
      { ...event("event_lamp", "u3", ["char_shen"]), chunkIndex: 1 },
    ],
    edges: [],
  };
  const allowedUnitIds = new Set(["u3", "u4"]);

  function validPass(): StoryMapEndingPassCandidate {
    return {
      additionalEvents: [event("event_dawn", "u4", ["char_shen"], 2)],
      endings: [
        {
          id: "ending_tide",
          targetEventId: "event_dawn",
          requirement: "潮水退去",
          evidenceUnitIds: ["u4"],
        },
      ],
      characterEndings: [
        {
          id: "ending_fate_shen",
          characterId: "char_shen",
          targetEventId: "event_dawn",
          fate: "留在灯塔",
          evidenceUnitIds: ["u4"],
        },
      ],
    };
  }

  it("rejects evidence outside the ending units and target events that do not exist", () => {
    const pass = validPass();
    pass.endings.push(
      {
        id: "ending_missing_target",
        targetEventId: "event_missing",
        requirement: "未知的收尾",
        evidenceUnitIds: ["u3"],
      },
      {
        id: "ending_outside",
        targetEventId: "event_storm",
        requirement: "旧事重提",
        evidenceUnitIds: ["u1"],
      },
    );
    pass.characterEndings.push({
      id: "ending_fate_outside",
      characterId: "char_shen",
      targetEventId: "event_lamp",
      fate: "离开港城",
      evidenceUnitIds: ["u1"],
    });

    expect(validateEndingPass(pass, pool, allowedUnitIds)).toEqual([
      {
        path: "endings.1.targetEventId",
        message: "结局候选引用了未知事件：event_missing",
      },
      {
        path: "endings.2.evidenceUnitIds.0",
        message: "Evidence 引用了本阶段未提供的 Unit：u1",
      },
      {
        path: "characterEndings.1.evidenceUnitIds.0",
        message: "Evidence 引用了本阶段未提供的 Unit：u1",
      },
    ]);
  });

  it("applies valid endings and renders character fate with the 【人物结局】 prefix", () => {
    const pass = validPass();
    expect(validateEndingPass(pass, pool, allowedUnitIds)).toEqual([]);

    const applied = applyEndingPass(pool, pass);
    expect(applied.pool.events.map((item) => [item.id, item.chunkIndex])).toEqual([
      ["event_storm", 0],
      ["event_lamp", 1],
      ["event_dawn", 2],
    ]);
    expect(applied.endings).toEqual([
      {
        id: "ending_tide",
        targetEventId: "event_dawn",
        requirement: "潮水退去",
        evidenceUnitIds: ["u4"],
      },
      {
        id: "ending_fate_shen",
        targetEventId: "event_dawn",
        requirement: `${CHARACTER_ENDING_PREFIX}沈砚：留在灯塔`,
        evidenceUnitIds: ["u4"],
      },
    ]);
  });
});

describe("deterministic dialogue speakers", () => {
  it("counts names before speech verbs and before a dialogue colon, without admitting random words", () => {
    const units = [
      textUnit(
        "u1",
        [
          "林舟说：“先别走。”",
          "他问道：“谁在外面？”",
          "许多说：“我不知道。”",
          "然后：“我们走吧。”",
          "苏晚：“我在这里。”",
          "老王喊道：“等等！”",
          "顾闻舟答道：“知道了。”",
        ].join("\n"),
      ),
    ];

    const candidates = deriveNameCandidates(units);
    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));

    expect([...byName.keys()]).toEqual(
      expect.arrayContaining(["林舟", "苏晚", "老王", "顾闻舟"]),
    );
    for (const name of ["林舟", "苏晚", "老王", "顾闻舟"]) {
      expect(byName.get(name)?.speakerCount).toBe(1);
    }
    expect([...byName.keys()]).not.toEqual(
      expect.arrayContaining(["许多", "然后", "他问", "林舟说", "老王喊"]),
    );
  });

  it("keeps 老板 as a nickname candidate because it can be a character's only name", () => {
    const units = [
      textUnit(
        "u1",
        ["老板进门。", "老板点灯。", "老板坐下。"].join("\n"),
      ),
    ];

    const candidates = deriveNameCandidates(units);

    expect(candidates.map((candidate) => candidate.name)).toContain("老板");
  });

  it("ranks a frequent speaker above a name that only appears in narration", () => {    const units = [
      textUnit(
        "u1",
        [
          "林舟说：“一。”",
          "林舟道：“二。”",
          "林舟问：“三。”",
          "顾远坐下。",
          "顾远抬头。",
          "顾远沉默。",
          "顾远起身。",
          "顾远离开。",
        ].join("\n"),
      ),
    ];

    const candidates = deriveNameCandidates(units);
    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));

    expect(byName.get("林舟")).toMatchObject({ count: 3, speakerCount: 3 });
    expect(byName.get("顾远")).toMatchObject({ count: 5, speakerCount: 0 });
    expect(candidates.findIndex((candidate) => candidate.name === "林舟")).toBeLessThan(
      candidates.findIndex((candidate) => candidate.name === "顾远"),
    );
  });
});

describe("deterministic junk filter and non-surname nicknames", () => {
  it("drops surname fragments followed by particles or speech verbs and stop-word lookalikes", () => {
    const units = [
      textUnit(
        "u1",
        [
          "顾的推开门。",
          "顾的又停下。",
          "顾的说：“走吧。”",
          "顾的走了。",
          "顾说：“一。”",
          "顾说：“二。”",
          "顾说：“三。”",
          "何苦再试。何苦如此。何苦呢。",
          "张望四周。张望门口。张望窗外。",
          "钱财散尽。钱财无用。钱财难得。",
        ].join("\n"),
      ),
    ];

    const names = deriveNameCandidates(units).map((candidate) => candidate.name);

    expect(names).not.toContain("顾的");
    expect(names).not.toContain("顾说");
    expect(names).not.toContain("何苦");
    expect(names).not.toContain("张望");
    expect(names).not.toContain("钱财");
  });

  it("finds 阿/小/老 + one Han character or ASCII letter after two occurrences", () => {
    const units = [
      textUnit(
        "u1",
        [
          "阿某走进院子。",
          "阿某坐下。",
          "小A笑了笑。",
          "小A点头。",
          "老师来了。",
          "老师走了。",
          "老周来了。",
          "老周走了。",
        ].join("\n"),
      ),
    ];

    const names = deriveNameCandidates(units).map((candidate) => candidate.name);

    expect(names).toEqual(expect.arrayContaining(["阿某", "小A", "老周"]));
    expect(names).not.toContain("老师");
  });
});

describe("group filtering before the roster pass", () => {
  it("drops groups, cleans participants and keeps a group only when an event would have none", () => {
    const pool: StoryMapPool = {
      characters: [
        { ...character("char_lin", "林舟"), kind: "individual" },
        { ...character("char_crowd", "围观的人群"), kind: "individual" },
        { ...character("char_soldiers", "士兵和警察"), kind: "group" },
        { ...character("char_gu", "顾家"), kind: "individual" },
        { ...character("char_xu", "徐府"), kind: "individual" },
        { ...character("char_old", "老人们"), kind: "individual" },
      ],
      events: [
        { ...event("e1", "u1", ["char_lin", "char_crowd"]), chunkIndex: 0 },
        { ...event("e2", "u2", ["char_soldiers"]), chunkIndex: 0 },
        { ...event("e3", "u3", ["char_lin", "char_gu", "char_xu", "char_old"]), chunkIndex: 0 },
      ],
      edges: [],
    };

    const filtered = dropGroupCandidates(pool);

    expect(filtered.characters.map((item) => item.id)).toEqual([
      "char_lin",
      "char_soldiers",
    ]);
    expect(filtered.events.map((item) => item.participants)).toEqual([
      ["char_lin"],
      ["char_soldiers"],
      ["char_lin"],
    ]);
    // 确定性群体特征：人群、们、姓氏+家/府；普通姓名不误伤。
    expect(isCollectiveName("围观的人群")).toBe(true);
    expect(isCollectiveName("老人们")).toBe(true);
    expect(isCollectiveName("顾家")).toBe(true);
    expect(isCollectiveName("徐府")).toBe(true);
    expect(isCollectiveName("林舟")).toBe(false);
  });
});

describe("deterministic edge and ending dedupe", () => {
  function edge(
    id: string,
    from: string,
    to: string,
    type: StoryMapCandidateEdge["type"],
    evidenceUnitIds: string[],
  ): StoryMapCandidateEdge {
    return {
      id,
      from,
      to,
      type,
      explanation: id,
      confidence: 1,
      confirmed: false,
      evidenceUnitIds,
    };
  }

  function ending(
    id: string,
    targetEventId: string,
    requirement: string,
    evidenceUnitIds: string[],
  ): StoryMapCandidateEnding {
    return { id, targetEventId, requirement, evidenceUnitIds };
  }

  it("collapses edges by (from, to, type), keeps the first label and unions evidence", () => {
    const edges = [
      edge("edge_a", "e1", "e2", "causes", ["u1"]),
      edge("edge_b", "e1", "e2", "enables", ["u2"]),
      edge("edge_c", "e1", "e2", "causes", ["u3"]),
      edge("edge_self", "e1", "e1", "foreshadows", ["u1"]),
      edge("edge_d", "e2", "e3", "causes", ["u4"]),
    ];

    expect(dedupeEdges(edges)).toEqual([
      { ...edges[0]!, evidenceUnitIds: ["u1", "u3"] },
      edges[1],
      edges[4],
    ]);
  });

  it("drops edges whose endpoints became the same event after event merge", () => {
    const edges = [edge("edge_a", "e2", "e2__c2", "causes", ["u1"])];
    const resolve = (id: string) => (id === "e2__c2" ? "e2" : id);

    expect(dedupeEdges(edges, resolve)).toEqual([]);
  });

  it("collapses story endings only when target and normalized requirement match", () => {
    const endings = [
      ending("end_story_a", "e1", "潮水  退去", ["u1"]),
      ending("end_story_b", "e1", " 潮水 退去。 ", ["u2"]),
      ending("end_story_c", "e1", "账簿归档", ["u3"]),
      ending("end_story_d", "e2", "潮水  退去", ["u4"]),
    ];

    expect(dedupeEndings(endings)).toEqual([
      { ...endings[0]!, evidenceUnitIds: ["u1", "u2"] },
      endings[2],
      endings[3],
    ]);
  });

  it("collapses character endings by character name, regardless of target or wording", () => {
    const endings = [
      ending("end_fate_a1", "e1", `${CHARACTER_ENDING_PREFIX}甲：留在港城`, ["u1"]),
      ending("end_fate_a2", "e2", `${CHARACTER_ENDING_PREFIX}甲：再次留在港城`, ["u4"]),
      ending("end_fate_b", "e2", `${CHARACTER_ENDING_PREFIX}乙：离开港城`, ["u3"]),
    ];

    expect(dedupeEndings(endings)).toEqual([
      { ...endings[0]!, evidenceUnitIds: ["u1", "u4"] },
      endings[2],
    ]);
  });

  it("applies duplicateEndingGroups: keeps the kept requirement and unions member evidence", () => {
    const pool: StoryMapPool = {
      characters: [character("char_a", "甲")],
      events: [
        { ...event("e1", "u1", ["char_a"]), chunkIndex: 0 },
        { ...event("e2", "u2", ["char_a"]), chunkIndex: 1 },
      ],
      edges: [],
    };
    const endings = [
      ending("end_dup", "e1", "另一种说法", ["u1"]),
      ending("end_keep", "e2", "保留的结局", ["u2"]),
      ending("end_dup2", "e1", "第三种说法", ["u4"]),
    ];

    const result = applyMerge(pool, endings, {
      title: "T",
      logline: "L",
      duplicateEventGroups: [],
      duplicateEndingGroups: [
        { keepEndingId: "end_keep", duplicateEndingIds: ["end_dup", "end_dup2"] },
      ],
      edges: [],
    });
    if (!result.success) throw new Error(JSON.stringify(result.issues));

    expect(result.candidate.endingCandidates).toEqual([
      {
        id: "end_keep",
        targetEventId: "e2",
        requirement: "保留的结局",
        evidenceUnitIds: ["u2", "u1", "u4"],
      },
    ]);
  });

  it("rejects duplicateEndingGroups that reference unknown or reused ending ids", () => {
    const pool: StoryMapPool = {
      characters: [character("char_a", "甲")],
      events: [{ ...event("e1", "u1", ["char_a"]), chunkIndex: 0 }],
      edges: [],
    };
    const endings = [
      ending("end_a", "e1", "结局甲", ["u1"]),
      ending("end_b", "e1", "结局乙", ["u1"]),
    ];

    const result = applyMerge(pool, endings, {
      title: "T",
      logline: "L",
      duplicateEventGroups: [],
      duplicateEndingGroups: [
        { keepEndingId: "end_a", duplicateEndingIds: ["end_b"] },
        { keepEndingId: "end_b", duplicateEndingIds: ["end_missing"] },
      ],
      edges: [],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "duplicateEndingGroups.1.keepEndingId",
        "duplicateEndingGroups.1.duplicateEndingIds",
      ]),
    );
  });
});

describe("final ID cleanup", () => {
  it("strips trailing __c chunk suffixes and rewrites every reference on collision", () => {
    const candidate: StoryMapContentCandidate = {
      title: "T",
      logline: "L",
      characters: [
        character("char_a", "甲"),
        character("char_a__c2", "甲"),
        character("char_a__c3", "甲"),
      ],
      events: [
        { ...event("event_x", "u1", ["char_a__c2"]), sequence: 1 },
        { ...event("event_x__c2", "u2", ["char_a__c3"]), sequence: 2 },
        { ...event("event_x__c3", "u3", ["char_a"]), sequence: 3 },
      ],
      edges: [
        {
          id: "edge__c2",
          from: "event_x",
          to: "event_x__c2",
          type: "causes",
          explanation: "x",
          confidence: 1,
          confirmed: false,
          evidenceUnitIds: ["u1"],
        },
      ],
      endingCandidates: [
        {
          id: "ending__c2",
          targetEventId: "event_x__c2",
          requirement: "结局",
          evidenceUnitIds: ["u2"],
        },
      ],
    };

    const cleaned = cleanupCandidateIds(candidate);

    expect(cleaned.characters.map((item) => item.id)).toEqual([
      "char_a",
      "char_a-2",
      "char_a-3",
    ]);
    expect(cleaned.events.map((item) => item.id)).toEqual([
      "event_x",
      "event_x-2",
      "event_x-3",
    ]);
    expect(cleaned.events.map((item) => item.participants)).toEqual([
      ["char_a-2"],
      ["char_a-3"],
      ["char_a"],
    ]);
    expect(cleaned.edges).toEqual([
      {
        id: "edge",
        from: "event_x",
        to: "event_x-2",
        type: "causes",
        explanation: "x",
        confidence: 1,
        confirmed: false,
        evidenceUnitIds: ["u1"],
      },
    ]);
    expect(cleaned.endingCandidates[0]).toMatchObject({
      id: "ending",
      targetEventId: "event_x-2",
    });
    const referenceIds = [
      ...cleaned.characters.map((item) => item.id),
      ...cleaned.events.flatMap((item) => [item.id, ...item.participants]),
      ...cleaned.edges.flatMap((item) => [item.id, item.from, item.to]),
      ...cleaned.endingCandidates.flatMap((item) => [item.id, item.targetEventId]),
    ];
    expect(referenceIds.join("|")).not.toContain("__c");
  });

  it("is idempotent for ids that already have no chunk suffix", () => {
    const candidate: StoryMapContentCandidate = {
      title: "T",
      logline: "L",
      characters: [character("char_a", "甲")],
      events: [{ ...event("event_x", "u1", ["char_a"]), sequence: 1 }],
      edges: [],
      endingCandidates: [
        { id: "ending_x", targetEventId: "event_x", requirement: "结局", evidenceUnitIds: ["u1"] },
      ],
    };

    expect(cleanupCandidateIds(cleanupCandidateIds(candidate))).toEqual(candidate);
  });

  it("reserves unsuffixed ids first so a legitimate a-2 keeps its exact id", () => {
    const candidate: StoryMapContentCandidate = {
      title: "T",
      logline: "L",
      characters: [
        character("char_a__c2", "甲"),
        character("char_a", "甲"),
        character("char_a-2", "甲"),
      ],
      events: [{ ...event("event_x__c2", "u1", ["char_a__c2"]), sequence: 1 }],
      edges: [],
      endingCandidates: [
        { id: "ending_x", targetEventId: "event_x__c2", requirement: "结局", evidenceUnitIds: ["u1"] },
      ],
    };

    const cleaned = cleanupCandidateIds(candidate);

    expect(cleaned.characters.map((item) => item.id)).toEqual([
      "char_a-3",
      "char_a",
      "char_a-2",
    ]);
    expect(cleaned.events[0]).toMatchObject({
      id: "event_x",
      participants: ["char_a-3"],
    });
    expect(cleaned.endingCandidates[0]).toMatchObject({
      targetEventId: "event_x",
    });
  });
});
