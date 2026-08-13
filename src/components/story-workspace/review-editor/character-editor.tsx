"use client";

import { useState, type FormEvent } from "react";

import type {
  StoryMapArtifact,
  StoryMapRevisionChange,
} from "@/domain/schemas";

type CharacterEditorProps = {
  artifact: StoryMapArtifact;
  characterIds: string[];
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
  showMerge: boolean;
};

export function CharacterEditor({
  artifact,
  characterIds,
  onRevise,
  pending,
  showMerge,
}: CharacterEditorProps) {
  const characters = characterIds
    .map((id) =>
      artifact.storyMap.characters.find((character) => character.id === id),
    )
    .filter((character) => character !== undefined);
  const primary = characters[0] ?? artifact.storyMap.characters[0];

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onRevise({
      type: "update_character",
      characterId: primary.id,
      name: String(data.get("name") ?? ""),
      aliases: String(data.get("aliases") ?? "")
        .split(/[，,\n]/u)
        .map((value) => value.trim())
        .filter(Boolean),
      role: String(data.get("role")) as typeof primary.role,
    });
  }

  return (
    <aside className="workspace-panel review-editor-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Character Review</span>
          <h2>核对人物身份</h2>
        </div>
      </div>
      {characters.map((character) => {
        const confirmed = artifact.review.characterConfirmations.includes(
          character.id,
        );
        return (
          <article className="character-review-card" key={character.id}>
            <strong>{character.name}</strong>
            <span>{roleLabel(character.role)}</span>
            <small>
              {character.aliases.length > 0
                ? `别名：${character.aliases.join("、")}`
                : "无别名"}
            </small>
            <button
              className="secondary-button"
              disabled={confirmed || pending}
              onClick={() =>
                onRevise({ type: "confirm_character", characterId: character.id })
              }
              type="button"
            >
              {confirmed ? "人物已核对" : "确认人物身份"}
            </button>
          </article>
        );
      })}

      <details className="editor-details">
        <summary>修改人物名称、别名或角色</summary>
        <form className="guided-review-form" onSubmit={submit}>
          <label>
            人物
            <select
              aria-label="要修改的人物"
              defaultValue={primary.id}
              disabled
              name="characterId"
            >
              <option value={primary.id}>{primary.name}</option>
            </select>
          </label>
          <label>
            名称
            <input defaultValue={primary.name} name="name" required />
          </label>
          <label>
            别名（逗号分隔）
            <input defaultValue={primary.aliases.join("，")} name="aliases" />
          </label>
          <label>
            角色
            <select defaultValue={primary.role} name="role">
              <option value="protagonist">主角</option>
              <option value="antagonist">对抗者</option>
              <option value="supporting">配角</option>
              <option value="deceased">已故人物</option>
            </select>
          </label>
          <button className="primary-button" disabled={pending} type="submit">
            保存人物 revision
          </button>
        </form>
      </details>

      {showMerge || artifact.storyMap.characters.length >= 2 ? (
        <MergeCharacterForm
          artifact={artifact}
          initialTargetId={primary.id}
          onRevise={onRevise}
          pending={pending}
        />
      ) : null}
    </aside>
  );
}

function MergeCharacterForm({
  artifact,
  initialTargetId,
  onRevise,
  pending,
}: {
  artifact: StoryMapArtifact;
  initialTargetId: string;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
}) {
  const characters = artifact.storyMap.characters;
  const [targetId, setTargetId] = useState(initialTargetId);
  const [mergedId, setMergedId] = useState(() =>
    firstOtherCharacterId(characters, initialTargetId),
  );
  const [error, setError] = useState<string | null>(null);

  // revision 后 artifact 更新：人物集合可能变化，保证两个选择始终有效。
  // 使用“渲染期状态调整”模式避免在 effect 内 setState。
  const characterKey = characters.map((character) => character.id).join(":");
  const [syncedKey, setSyncedKey] = useState(characterKey);
  if (syncedKey !== characterKey) {
    setSyncedKey(characterKey);
    if (!characters.some((character) => character.id === targetId)) {
      setTargetId(characters[0]!.id);
    }
    setMergedId((current) =>
      current === targetId || !characters.some((character) => character.id === current)
        ? firstOtherCharacterId(characters, targetId)
        : current,
    );
  }

  function changeTarget(nextTargetId: string): void {
    setTargetId(nextTargetId);
    setError(null);
    setMergedId((current) =>
      current !== nextTargetId &&
      characters.some((character) => character.id === current)
        ? current
        : firstOtherCharacterId(characters, nextTargetId),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (mergedId === targetId || !mergedId) {
      setError("保留人物与并入人物不能相同，请重新选择。");
      return;
    }
    setError(null);
    onRevise({
      type: "merge_characters",
      targetCharacterId: targetId,
      mergedCharacterIds: [mergedId],
    });
  }

  const mergedOptions = characters.filter(
    (character) => character.id !== targetId,
  );

  return (
    <details className="editor-details">
      <summary>合并两个重复人物</summary>
      <form className="guided-review-form" onSubmit={submit}>
        <label>
          保留人物
          <select
            aria-label="合并后保留人物"
            name="target"
            onChange={(event) => changeTarget(event.target.value)}
            value={targetId}
          >
            {characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          并入人物
          <select
            aria-label="要并入的人物"
            name="merged"
            onChange={(event) => {
              setMergedId(event.target.value);
              setError(null);
            }}
            value={mergedId}
          >
            {mergedOptions.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <p>所有 Event participant 引用会重映射，受影响的 Evidence 确认会失效。</p>
        <button className="danger-button" disabled={pending} type="submit">
          合并并创建 revision
        </button>
      </form>
    </details>
  );
}

function firstOtherCharacterId(
  characters: StoryMapArtifact["storyMap"]["characters"],
  targetId: string,
): string {
  return characters.find((character) => character.id !== targetId)?.id ?? "";
}

function roleLabel(
  role: StoryMapArtifact["storyMap"]["characters"][number]["role"],
): string {
  return {
    protagonist: "主角",
    antagonist: "对抗者",
    supporting: "配角",
    deceased: "已故人物",
  }[role];
}
