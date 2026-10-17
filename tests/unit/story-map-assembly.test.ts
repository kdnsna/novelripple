import { describe, expect, it } from "vitest";

import type {
  Character,
  StoryMapCandidateEvent,
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
  applyRoster,
  CHARACTER_ENDING_PREFIX,
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

  it("ranks a frequent speaker above a name that only appears in narration", () => {
    const units = [
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
