import { describe, expect, it } from "vitest";

import { buildSceneTree } from "@/domain/continuation/scene-tree";
import {
  SETTING_DELTA_FORBIDDEN_CHAR_MESSAGE,
  SETTING_DELTA_STATEMENT_MAX_CHARS,
  SETTING_DELTA_TERM_NAME_MAX_CHARS,
  SettingDeltaLifecycleV1Schema,
  SettingDeltaV1Schema,
} from "@/domain/schemas";

import {
  emptySettingDeltaDraft,
  settingDeltaActiveCount,
  settingDeltaAddBlockReason,
  settingDeltaAnchorHint,
  settingDeltaHistoryLabel,
  settingDeltaNonDeletedRowCount,
  settingDeltaScopeLabel,
  settingDeltaStatementRemaining,
  settingDeltaSubjectLabel,
  validateSettingDeltaDraft,
  type SettingDeltaDraft,
} from "@/components/story-workspace/path-setting-deltas-ui";
import {
  SETTING_DELTA_MAX_ACTIVE,
  SETTING_DELTA_MAX_ACTIVE_ROWS_PER_WORLDLINE,
  SETTING_DELTA_MAX_ROWS_PER_WORLDLINE,
} from "@/domain/continuation/setting-delta-limits";
import { v2SceneFixture } from "../helpers/continuation-scene-fixtures";

function buildTree() {
  const first = v2SceneFixture({
    id: "scene_1",
    parentSceneId: null,
    depth: 1,
    createdAt: "2026-10-18T00:00:00.000Z",
  });
  const second = v2SceneFixture({
    id: "scene_2",
    parentSceneId: first.id,
    depth: 2,
    createdAt: "2026-10-18T00:01:00.000Z",
  });
  return buildSceneTree([first, second]);
}

function delta(input: {
  id: string;
  statement: string;
  anchorSceneId: string | null;
}) {
  return SettingDeltaV1Schema.parse({
    id: input.id,
    worldlineId: "wl_1",
    anchorSceneId: input.anchorSceneId,
    subject: { kind: "term", name: "旧灯塔" },
    statement: input.statement,
    contentKind: "user",
    createdAt: "2026-10-18T00:00:00.000Z",
  });
}

describe("path setting delta presentation helpers", () => {
  it("labels divergence and scene anchors", () => {
    const tree = buildTree();
    expect(settingDeltaScopeLabel(null, tree)).toBe("自分歧点起");
    expect(settingDeltaScopeLabel("scene_1", tree)).toBe("自第 1 幕起");
    expect(settingDeltaScopeLabel("scene_2", tree)).toBe("自第 2 幕起");
    expect(() => settingDeltaScopeLabel("scene_missing", tree)).toThrow(
      "设定增量引用了未知锚点场景",
    );
  });

  it("shows the Story Map name for characters and the term text otherwise", () => {
    const names = new Map([["char_xucheng", "许澄"]]);
    expect(
      settingDeltaSubjectLabel(
        { kind: "character", characterId: "char_xucheng" },
        names,
      ),
    ).toBe("许澄");
    expect(
      settingDeltaSubjectLabel(
        { kind: "character", characterId: "char_unknown" },
        names,
      ),
    ).toBe("char_unknown");
    expect(
      settingDeltaSubjectLabel(
        { kind: "term", name: "旧灯塔" },
        new Map(),
      ),
    ).toBe("旧灯塔");
  });

  it("formats earlier versions as one compact history line", () => {
    expect(settingDeltaHistoryLabel([])).toBeNull();
    expect(
      settingDeltaHistoryLabel([
        delta({ id: "delta_1", statement: "旧灯塔还能通行。", anchorSceneId: null }),
        delta({
          id: "delta_2",
          statement: "旧灯塔只在退潮时开放。",
          anchorSceneId: "scene_1",
        }),
      ]),
    ).toBe("此前：旧灯塔还能通行。；旧灯塔只在退潮时开放。");
  });

  it("counts remaining statement characters without going negative", () => {
    expect(settingDeltaStatementRemaining("")).toBe(
      SETTING_DELTA_STATEMENT_MAX_CHARS,
    );
    expect(settingDeltaStatementRemaining("旧灯塔")).toBe(
      SETTING_DELTA_STATEMENT_MAX_CHARS - 3,
    );
    expect(
      settingDeltaStatementRemaining(
        "灯".repeat(SETTING_DELTA_STATEMENT_MAX_CHARS + 5),
      ),
    ).toBe(0);
  });

  it("describes the current anchor in the form hint", () => {
    const tree = buildTree();
    expect(settingDeltaAnchorHint(null)).toContain("（分歧点）");
    expect(settingDeltaAnchorHint(tree.nodes.get("scene_2")!)).toContain(
      "（第 2 幕）",
    );
    expect(settingDeltaAnchorHint(tree.nodes.get("scene_2")!)).toContain(
      "已有内容不会改写。",
    );
  });

  it("validates and trims term and statement input", () => {
    const draft = emptySettingDeltaDraft("term");
    draft.termName = "  旧灯塔 ";
    draft.statement = "  旧灯塔已被封锁。 ";
    expect(validateSettingDeltaDraft(draft)).toEqual({
      valid: true,
      subject: { kind: "term", name: "旧灯塔" },
      statement: "旧灯塔已被封锁。",
    });
  });

  it("requires a character when the character subject is selected", () => {
    const draft = emptySettingDeltaDraft("character");
    draft.statement = "旧灯塔已被封锁。";
    expect(validateSettingDeltaDraft(draft)).toEqual({
      valid: false,
      error: "请选择人物。",
    });

    draft.characterId = "char_xucheng";
    expect(validateSettingDeltaDraft(draft)).toEqual({
      valid: true,
      subject: { kind: "character", characterId: "char_xucheng" },
      statement: "旧灯塔已被封锁。",
    });
  });

  it("rejects blank, overlong statements and overlong term names", () => {
    const termDraft: SettingDeltaDraft = {
      subjectKind: "term",
      characterId: "",
      termName: "旧灯塔",
      statement: "   ",
    };
    expect(validateSettingDeltaDraft(termDraft)).toEqual({
      valid: false,
      error: "请输入设定说明。",
    });

    termDraft.statement = "灯".repeat(SETTING_DELTA_STATEMENT_MAX_CHARS + 1);
    expect(validateSettingDeltaDraft(termDraft)).toEqual({
      valid: false,
      error: `设定说明不能超过 ${SETTING_DELTA_STATEMENT_MAX_CHARS} 个字符。`,
    });

    termDraft.statement = "旧灯塔已被封锁。";
    termDraft.termName = "灯".repeat(SETTING_DELTA_TERM_NAME_MAX_CHARS + 1);
    expect(validateSettingDeltaDraft(termDraft)).toEqual({
      valid: false,
      error: `设定词条名称不能超过 ${SETTING_DELTA_TERM_NAME_MAX_CHARS} 个字符。`,
    });

    termDraft.termName = "   ";
    expect(validateSettingDeltaDraft(termDraft)).toEqual({
      valid: false,
      error: "请输入设定词条名称。",
    });
  });

  it("rejects control, invisible, malformed and private-use characters in both fields", () => {
    const forbidden = [
      "\n",
      "\u0001",
      "\u2028",
      "\u200B",
      "\u200D",
      "\uFEFF",
      "\u00AD",
      "\u200E",
      "\u202E",
      "\u2066",
      "\uD800",
      "\uDC00",
      "\u{E0001}",
      "\u{E0041}",
      "\uFE0F",
      "\u{E0100}",
      "\uE000",
    ];
    for (const value of forbidden) {
      expect(
        validateSettingDeltaDraft({
          subjectKind: "term",
          characterId: "",
          termName: "旧灯塔",
          statement: `旧灯塔${value}已被封锁`,
        }),
      ).toEqual({ valid: false, error: SETTING_DELTA_FORBIDDEN_CHAR_MESSAGE });
      expect(
        validateSettingDeltaDraft({
          subjectKind: "term",
          characterId: "",
          termName: `旧灯${value}塔`,
          statement: "旧灯塔已被封锁。",
        }),
      ).toEqual({ valid: false, error: SETTING_DELTA_FORBIDDEN_CHAR_MESSAGE });
    }
  });

  it("stores NFC-composed text, preserves full-width punctuation, and measures the stored length", () => {
    // U+1100 U+1161 U+11A8 经 NFC 也组合成 U+AC01（각）。
    const composed = "\u1100\u1161\u11A8";
    expect(
      validateSettingDeltaDraft({
        subjectKind: "term",
        characterId: "",
        termName: "  " + composed + "  ",
        statement: "  " + composed + "  ",
      }),
    ).toEqual({
      valid: true,
      subject: { kind: "term", name: "\uAC01" },
      statement: "\uAC01",
    });

    // NFC 保留中文全角标点与 ①，不把它们改写成 ASCII。
    const punctuation = "，！？：（）；…①";
    expect(punctuation.normalize("NFC")).toBe(punctuation);
    expect(
      validateSettingDeltaDraft({
        subjectKind: "term",
        characterId: "",
        termName: punctuation,
        statement: `旧灯塔${punctuation}`,
      }),
    ).toEqual({
      valid: true,
      subject: { kind: "term", name: punctuation },
      statement: `旧灯塔${punctuation}`,
    });
  });

  it("warns and blocks adding when active rules on the current path reach the cap", () => {
    expect(
      settingDeltaActiveCount([
        { status: "active" },
        { status: "deactivated" },
        { status: "active" },
      ]),
    ).toBe(2);
    expect(
      settingDeltaAddBlockReason({
        activeCount: 19,
        activeRowCount: 19,
        totalCount: 19,
      }),
    ).toBeNull();
    expect(
      settingDeltaAddBlockReason({
        activeCount: SETTING_DELTA_MAX_ACTIVE,
        activeRowCount: SETTING_DELTA_MAX_ACTIVE,
        totalCount: SETTING_DELTA_MAX_ACTIVE,
      }),
    ).toContain("停用或软删除已有规则");
    expect(
      settingDeltaAddBlockReason({
        activeCount: 1,
        activeRowCount: SETTING_DELTA_MAX_ACTIVE_ROWS_PER_WORLDLINE,
        totalCount: SETTING_DELTA_MAX_ACTIVE_ROWS_PER_WORLDLINE,
      }),
    ).toContain("未删除");
    expect(
      settingDeltaAddBlockReason({
        activeCount: 1,
        activeRowCount: 1,
        totalCount: SETTING_DELTA_MAX_ROWS_PER_WORLDLINE,
      }),
    ).toContain("每条 Worldline 最多保存");
  });

  it("counts non-deleted rows separately from all rows", () => {
    const deltas = ["delta_1", "delta_2", "delta_3"].map((id) =>
      delta({ id, statement: "旧灯塔还能通行。", anchorSceneId: null }),
    );
    const lifecycle = (id: string, status: "deleted" | "deactivated") =>
      SettingDeltaLifecycleV1Schema.parse({
        id: `lifecycle_${id}`,
        worldlineId: "wl_1",
        targetDeltaId: id,
        status,
        contentKind: "user",
        createdAt: "2026-10-18T00:00:00.000Z",
      });
    expect(settingDeltaNonDeletedRowCount(deltas, [])).toBe(3);
    expect(settingDeltaNonDeletedRowCount(deltas, [lifecycle("delta_1", "deleted")])).toBe(2);
    // 停用仍占未删除行名额。
    expect(
      settingDeltaNonDeletedRowCount(deltas, [
        lifecycle("delta_1", "deleted"),
        lifecycle("delta_2", "deactivated"),
      ]),
    ).toBe(2);
  });
});
