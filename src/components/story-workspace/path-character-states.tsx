import type { DerivedCharacterStatus } from "@/domain/continuation/character-status";
import type { CharacterStatus } from "@/domain/schemas";

import {
  pathCharacterHistoryLabel,
  pathCharacterStatusLabel,
  pathCharacterStatusSourceLabel,
} from "./worldline-tree-ui";

const STATUS_OPTIONS: CharacterStatus[] = [
  "alive",
  "dead",
  "absent",
  "unknown",
];

type PathCharacterStatesProps = {
  states: readonly DerivedCharacterStatus[];
  pendingCharacterId: string | null;
  onSetStatus: (characterId: string, status: CharacterStatus) => void;
};

/**
 * 只展示当前路径折叠出的人物状态，不读取兄弟分支。
 *
 * 每条变化都可把状态覆盖在当前阅读位置（分歧点时锚点为 null）；
 * 覆盖只追加新行，不修改已有场景或 Impact Plan。
 */
export function PathCharacterStates({
  states,
  pendingCharacterId,
  onSetStatus,
}: PathCharacterStatesProps) {
  return (
    <section
      className="path-character-states"
      data-testid="path-character-states"
    >
      <h3>人物状态（本路径）</h3>
      {states.length === 0 ? (
        <p className="path-character-empty">本路径还没有人物状态变化。</p>
      ) : (
        <ul className="path-character-state-list">
          {states.map((state) => (
            <li data-testid="path-character-state" key={state.characterId}>
              <div className="path-character-state-heading">
                <strong>
                  {state.name}
                  <span
                    className="path-character-status-badge"
                    data-status={state.status}
                    data-testid="path-character-status"
                  >
                    {pathCharacterStatusLabel(state.status)}
                  </span>
                  <span
                    className="path-character-status-source"
                    data-testid="path-character-status-source"
                  >
                    {pathCharacterStatusSourceLabel(
                      state.source,
                      state.sourceDepth,
                    )}
                  </span>
                </strong>
                <span>{state.summary ?? "尚无变化摘要"}</span>
              </div>
              <label className="path-character-status-select">
                <span>覆盖状态</span>
                <select
                  aria-label={`${state.name}的状态`}
                  disabled={pendingCharacterId !== null}
                  onChange={(event) =>
                    onSetStatus(
                      state.characterId,
                      event.target.value as CharacterStatus,
                    )
                  }
                  value={state.status}
                >
                  {STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>
                      {pathCharacterStatusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="path-character-history">
                {state.history.map(pathCharacterHistoryLabel).join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
