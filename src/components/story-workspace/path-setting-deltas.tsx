"use client";

import {
  type FormEvent,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import { addSettingDeltaAction } from "@/app/projects/actions";
import type { SceneNode, SceneTree } from "@/domain/continuation/scene-tree";
import {
  deriveActiveSettingDeltas,
  type ActiveSettingDelta,
} from "@/domain/continuation/setting-deltas";
import { SETTING_DELTA_MAX_PER_WORLDLINE } from "@/domain/continuation/setting-delta-limits";
import {
  SETTING_DELTA_STATEMENT_MAX_CHARS,
  SETTING_DELTA_TERM_NAME_MAX_CHARS,
  type SettingDeltaArtifact,
  type SettingDeltaV1,
} from "@/domain/schemas";

import {
  emptySettingDeltaDraft,
  settingDeltaAnchorHint,
  settingDeltaHistoryLabel,
  settingDeltaScopeLabel,
  settingDeltaStatementRemaining,
  settingDeltaSubjectLabel,
  validateSettingDeltaDraft,
  type SettingDeltaDraft,
} from "./path-setting-deltas-ui";

type PathSettingDeltasProps = {
  projectId: string;
  worldlineId: string;
  tree: SceneTree;
  currentPath: readonly SceneNode[];
  settingDeltas: readonly SettingDeltaV1[];
  characters: readonly { id: string; name: string }[];
  onArtifactAdded: (artifact: SettingDeltaArtifact) => void;
};

/**
 * 当前路径生效的设定增量：只展示祖先/当前节点上的规则，兄弟分支不可见。
 *
 * 表单写入的是新的不可变 `setting_delta` Artifact；成功后由面板把它追加
 * 到视图，失败只显示错误，不会留下半份规则。
 */
export function PathSettingDeltas({
  projectId,
  worldlineId,
  tree,
  currentPath,
  settingDeltas,
  characters,
  onArtifactAdded,
}: PathSettingDeltasProps) {
  const currentNode = currentPath[currentPath.length - 1] ?? null;
  const currentNodeId = currentNode?.id ?? null;
  const atCap = settingDeltas.length >= SETTING_DELTA_MAX_PER_WORLDLINE;

  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<SettingDeltaDraft>(() =>
    emptySettingDeltaDraft(characters.length > 0 ? "character" : "term"),
  );
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  /** useTransition 的 pending 延迟一帧；ref 同步拦住同一 tick 的重复提交。 */
  const pendingRef = useRef(false);

  const characterNames = useMemo(
    () =>
      new Map(
        characters.map((character) => [character.id, character.name] as const),
      ),
    [characters],
  );

  /**
   * 与路径 Delta / 人物状态相同：派生失败整体 fail closed，不展示半份列表。
   */
  const derivation = useMemo<{
    items: ActiveSettingDelta[];
    error: string | null;
  }>(() => {
    try {
      return {
        items: deriveActiveSettingDeltas({
          tree,
          deltas: settingDeltas,
          path: currentPath,
        }),
        error: null,
      };
    } catch {
      return {
        items: [],
        error: "无法沿当前路径推导设定增量，请刷新或返回 Evidence 后重试。",
      };
    }
  }, [currentPath, settingDeltas, tree]);

  const validation = validateSettingDeltaDraft(draft);

  function openForm(): void {
    if (pendingRef.current || atCap) return;
    setDraft(
      emptySettingDeltaDraft(characters.length > 0 ? "character" : "term"),
    );
    // 每次打开表单都使用新的幂等键；成功后关闭，下次打开即新规则。
    setIdempotencyKey(crypto.randomUUID());
    setFormError(null);
    setFormOpen(true);
  }

  function closeForm(): void {
    if (pendingRef.current) return;
    setFormOpen(false);
    setFormError(null);
  }

  function submitForm(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pendingRef.current || atCap || !idempotencyKey) return;

    const result = validateSettingDeltaDraft(draft);
    if (!result.valid) {
      setFormError(result.error);
      return;
    }

    pendingRef.current = true;
    setFormError(null);
    startTransition(async () => {
      try {
        const saved = await addSettingDeltaAction({
          projectId,
          worldlineId,
          anchorSceneId: currentNodeId,
          subject: result.subject,
          statement: result.statement,
          idempotencyKey,
        });
        if (!saved.ok) {
          setFormError(saved.error);
          return;
        }
        onArtifactAdded(saved.artifact);
        setFormOpen(false);
      } catch {
        setFormError("设定增量保存失败，未写入任何规则。");
      } finally {
        pendingRef.current = false;
      }
    });
  }

  return (
    <section
      className="path-setting-deltas"
      data-testid="path-setting-deltas"
    >
      <div className="path-setting-deltas-heading">
        <h3>设定增量（本路径生效）</h3>
        <button
          className="text-button"
          disabled={atCap || pending}
          onClick={openForm}
          type="button"
        >
          添加设定增量
        </button>
      </div>

      {derivation.error ? (
        <p className="continuation-action-error" role="alert">
          {derivation.error}
        </p>
      ) : derivation.items.length === 0 ? (
        <p className="path-setting-delta-empty">本路径还没有设定增量。</p>
      ) : (
        <ul className="path-setting-delta-list">
          {derivation.items.map((item) => {
            const historyLabel = settingDeltaHistoryLabel(item.history);
            return (
              <li data-testid="path-setting-delta" key={item.active.id}>
                <div className="path-setting-delta-item-heading">
                  <strong>
                    {settingDeltaSubjectLabel(
                      item.active.subject,
                      characterNames,
                    )}
                  </strong>
                  <span>
                    {settingDeltaScopeLabel(item.active.anchorSceneId, tree)}
                  </span>
                </div>
                <p className="path-setting-delta-statement">
                  {item.active.statement}
                </p>
                {historyLabel ? (
                  <p
                    className="path-setting-delta-history"
                    title={historyLabel}
                  >
                    {historyLabel}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {atCap ? (
        <p className="path-setting-delta-cap">
          每条 Worldline 最多保存 {SETTING_DELTA_MAX_PER_WORLDLINE}{" "}
          条设定增量，当前已达到上限；已有规则仍然生效，暂时不能再添加。
        </p>
      ) : null}

      {formOpen ? (
        <form
          className="path-setting-delta-form"
          data-testid="setting-delta-form"
          onSubmit={submitForm}
        >
          <label htmlFor="setting-delta-subject-kind">主体类型</label>
          <select
            id="setting-delta-subject-kind"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                subjectKind: event.target.value as "character" | "term",
              }))
            }
            value={draft.subjectKind}
          >
            <option value="character">人物</option>
            <option value="term">设定词条</option>
          </select>

          {draft.subjectKind === "character" ? (
            <>
              <label htmlFor="setting-delta-character">人物</label>
              <select
                id="setting-delta-character"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    characterId: event.target.value,
                  }))
                }
                value={draft.characterId}
              >
                <option value="">请选择人物</option>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label htmlFor="setting-delta-term">设定词条</label>
              <input
                id="setting-delta-term"
                maxLength={SETTING_DELTA_TERM_NAME_MAX_CHARS}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    termName: event.target.value,
                  }))
                }
                placeholder="例如：旧灯塔"
                value={draft.termName}
              />
            </>
          )}

          <label htmlFor="setting-delta-statement">规则说明</label>
          <textarea
            id="setting-delta-statement"
            maxLength={SETTING_DELTA_STATEMENT_MAX_CHARS}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                statement: event.target.value,
              }))
            }
            placeholder="例如：旧灯塔已被封锁，任何人不得进入。"
            rows={3}
            value={draft.statement}
          />
          <p className="path-setting-delta-counter">
            剩余 {settingDeltaStatementRemaining(draft.statement)} 字
          </p>
          <p className="path-setting-delta-hint">
            {settingDeltaAnchorHint(currentNode)}
          </p>

          {formError ? (
            <p className="setting-delta-error" role="alert">
              {formError}
            </p>
          ) : null}

          <div className="path-setting-delta-form-actions">
            <button
              className="primary-button compact-button"
              disabled={pending || atCap || !validation.valid}
              type="submit"
            >
              {pending ? "正在保存…" : "保存设定增量"}
            </button>
            <button
              className="text-button"
              disabled={pending}
              onClick={closeForm}
              type="button"
            >
              取消
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
