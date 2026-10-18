import type { PathCharacterState } from "@/domain/continuation/worldline-tree";

import { pathCharacterHistoryLabel } from "./worldline-tree-ui";

type PathCharacterStatesProps = {
  states: readonly PathCharacterState[];
};

/** 只展示当前路径折叠出的人物状态，不读取兄弟分支。 */
export function PathCharacterStates({ states }: PathCharacterStatesProps) {
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
                <strong>{state.name}</strong>
                <span>{state.current}</span>
              </div>
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
