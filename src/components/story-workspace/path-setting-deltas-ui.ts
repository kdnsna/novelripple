import type { SceneNode, SceneTree } from "@/domain/continuation/scene-tree";
import {
  SETTING_DELTA_MAX_ACTIVE,
  SETTING_DELTA_MAX_ACTIVE_ROWS_PER_WORLDLINE,
  SETTING_DELTA_MAX_ROWS_PER_WORLDLINE,
} from "@/domain/continuation/setting-delta-limits";
import {
  settingDeltaLifecycleStatuses,
  type PathSettingDelta,
} from "@/domain/continuation/setting-deltas";
import {
  SETTING_DELTA_STATEMENT_MAX_CHARS,
  SETTING_DELTA_TERM_NAME_MAX_CHARS,
  findForbiddenSettingDeltaChar,
  normalizeSettingDeltaText,
  settingDeltaForbiddenCharMessage,
  type SettingDeltaLifecycleV1,
  type SettingDeltaSubject,
  type SettingDeltaV1,
} from "@/domain/schemas";

/**
 * 路径作用域设定增量的纯展示/校验逻辑。
 *
 * 组件只负责状态与调用 Action；标签、作用域文案和输入校验放在这里，
 * 便于在 Vitest 中不挂载 DOM 直接测试。
 */

export type SettingDeltaDraft = {
  subjectKind: "character" | "term";
  characterId: string;
  termName: string;
  statement: string;
};

export type SettingDeltaDraftValidation =
  | { valid: true; subject: SettingDeltaSubject; statement: string }
  | { valid: false; error: string | null };

export function emptySettingDeltaDraft(
  subjectKind: "character" | "term",
): SettingDeltaDraft {
  return { subjectKind, characterId: "", termName: "", statement: "" };
}

/** 分歧点规则显示“自分歧点起”，场景锚点显示“自第 n 幕起”。 */
export function settingDeltaScopeLabel(
  anchorSceneId: string | null,
  tree: SceneTree,
): string {
  if (anchorSceneId === null) return "自分歧点起";
  const anchor = tree.nodes.get(anchorSceneId);
  if (!anchor) {
    throw new Error(`设定增量引用了未知锚点场景：${anchorSceneId}`);
  }
  return `自第 ${anchor.depth} 幕起`;
}

/** 人物显示 Story Map 姓名；术语直接显示读者输入的词条名。 */
export function settingDeltaSubjectLabel(
  subject: SettingDeltaSubject,
  characterNames: ReadonlyMap<string, string>,
): string {
  if (subject.kind === "character") {
    return characterNames.get(subject.characterId) ?? subject.characterId;
  }
  return subject.name;
}

/** 同一主体更早版本的紧凑单行提示；没有历史时返回 null。 */
export function settingDeltaHistoryLabel(
  history: readonly SettingDeltaV1[],
): string | null {
  if (history.length === 0) return null;
  return `此前：${history.map((delta) => delta.statement).join("；")}`;
}

/**
 * 历史行是否包含规则收紧前的禁用字符。
 *
 * 读取与展示保留原样（读者可以自行改写），但进入续写上下文前渲染函数会
 * 移除这些码位；界面据此给出一条非阻断说明。
 */
export function settingDeltaSanitizedNote(
  delta: Pick<SettingDeltaV1, "subject" | "statement">,
): string | null {
  const forbidden =
    findForbiddenSettingDeltaChar(delta.statement) ??
    (delta.subject.kind === "term"
      ? findForbiddenSettingDeltaChar(delta.subject.name)
      : null);
  return forbidden === null ? null : "包含不可见字符，进入续写前已移除";
}

export function settingDeltaStatementRemaining(statement: string): number {
  return Math.max(
    0,
    SETTING_DELTA_STATEMENT_MAX_CHARS -
      normalizeSettingDeltaText(statement).length,
  );
}

/** 当前路径真正生效（非停用/非软删除）的主体数量。 */
export function settingDeltaActiveCount(
  items: readonly Pick<PathSettingDelta, "status">[],
): number {
  return items.filter((item) => item.status === "active").length;
}

/** 世界线未软删除的规则行数（停用仍算行）。 */
export function settingDeltaNonDeletedRowCount(
  deltas: readonly Pick<SettingDeltaV1, "id">[],
  lifecycles: readonly SettingDeltaLifecycleV1[],
): number {
  const statuses = settingDeltaLifecycleStatuses(lifecycles);
  return deltas.filter((delta) => statuses.get(delta.id) !== "deleted").length;
}

/**
 * 添加按钮的禁用原因。
 *
 * 写时上限按当前路径的生效主体计算，因此界面必须在 active ≥ 20 时提示
 * 停用/删除/改写已有主体；存储行数上限包含软删除行，软删除不会腾出总行数
 * 名额（只腾出生效名额）。
 */
export function settingDeltaAddBlockReason(input: {
  activeCount: number;
  activeRowCount: number;
  totalCount: number;
}): string | null {
  if (input.activeCount >= SETTING_DELTA_MAX_ACTIVE) {
    return `本路径已有 ${SETTING_DELTA_MAX_ACTIVE} 条生效规则；请先停用或软删除已有规则，或改写已有主体的说明。`;
  }
  if (input.activeRowCount >= SETTING_DELTA_MAX_ACTIVE_ROWS_PER_WORLDLINE) {
    return `每条 Worldline 最多保存 ${SETTING_DELTA_MAX_ACTIVE_ROWS_PER_WORLDLINE} 条未删除的设定增量；请先删除不再需要的规则。`;
  }
  if (input.totalCount >= SETTING_DELTA_MAX_ROWS_PER_WORLDLINE) {
    return `每条 Worldline 最多保存 ${SETTING_DELTA_MAX_ROWS_PER_WORLDLINE} 条设定增量（含已删除规则），当前已达到上限。`;
  }
  return null;
}

/** 表单提示里的锚点文案；空路径表示分歧点。 */
export function settingDeltaAnchorHint(currentNode: SceneNode | null): string {
  const anchor = currentNode ? `第 ${currentNode.depth} 幕` : "分歧点";
  return `从当前节点（${anchor}）起，只对这条路径及之后的分支生效，不影响兄弟分支；已有内容不会改写。`;
}

/**
 * 校验表单并转换成 Action 需要的 subject / statement。
 *
 * 与 Schema 使用同一组长度常量；空白说明或未选择人物都视为无效，
 * 因此界面可以在提交前禁用按钮，服务端仍会再做一次 Schema 校验。
 */
export function validateSettingDeltaDraft(
  draft: SettingDeltaDraft,
): SettingDeltaDraftValidation {
  const forbiddenStatement = findForbiddenSettingDeltaChar(draft.statement);
  if (forbiddenStatement !== null) {
    return {
      valid: false,
      error: settingDeltaForbiddenCharMessage(forbiddenStatement, "设定说明"),
    };
  }
  const statement = normalizeSettingDeltaText(draft.statement);
  if (statement.length === 0) {
    return { valid: false, error: "请输入设定说明。" };
  }
  if (statement.length > SETTING_DELTA_STATEMENT_MAX_CHARS) {
    return {
      valid: false,
      error: `设定说明不能超过 ${SETTING_DELTA_STATEMENT_MAX_CHARS} 个字符。`,
    };
  }

  if (draft.subjectKind === "character") {
    if (draft.characterId.length === 0) {
      return { valid: false, error: "请选择人物。" };
    }
    return {
      valid: true,
      subject: { kind: "character", characterId: draft.characterId },
      statement,
    };
  }

  const forbiddenTermName = findForbiddenSettingDeltaChar(draft.termName);
  if (forbiddenTermName !== null) {
    return {
      valid: false,
      error: settingDeltaForbiddenCharMessage(forbiddenTermName, "词条名"),
    };
  }
  const termName = normalizeSettingDeltaText(draft.termName);
  if (termName.length === 0) {
    return { valid: false, error: "请输入设定词条名称。" };
  }
  if (termName.length > SETTING_DELTA_TERM_NAME_MAX_CHARS) {
    return {
      valid: false,
      error: `设定词条名称不能超过 ${SETTING_DELTA_TERM_NAME_MAX_CHARS} 个字符。`,
    };
  }
  return {
    valid: true,
    subject: { kind: "term", name: termName },
    statement,
  };
}
