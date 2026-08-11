"use client";

import { useActionState } from "react";

import {
  generateStoryMapAction,
  type ProjectActionState,
} from "@/app/projects/actions";

const initialState: ProjectActionState = { error: null };

export function StoryMapGenerationForm({
  projectId,
  sourceId,
}: {
  projectId: string;
  sourceId: string;
}) {
  const [state, action, pending] = useActionState(
    generateStoryMapAction.bind(null, projectId, sourceId),
    initialState,
  );

  return (
    <form action={action} className="story-map-generation-form">
      <span className="eyebrow">下一步</span>
      <h3>建立可追溯故事地图</h3>
      <p>模型只提取关键因果骨架；Schema、Evidence 和领域引用失败会整次关闭。</p>
      {state.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="primary-button full-width-button" disabled={pending} type="submit">
        {pending ? "正在生成并校验…" : "生成 Story Map"}
        {!pending ? <span aria-hidden="true">→</span> : null}
      </button>
    </form>
  );
}
