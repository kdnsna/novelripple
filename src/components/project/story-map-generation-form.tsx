"use client";

import { useActionState } from "react";

import {
  startStoryMapGenerationAction,
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
    // 首次生成没有可复用任务，显式 fresh 与自然新 group 语义一致。
    startStoryMapGenerationAction.bind(null, projectId, sourceId, "fresh"),
    initialState,
  );

  return (
    <form action={action} className="story-map-generation-form">
      <span className="eyebrow">下一步</span>
      <h3>建立可追溯故事地图</h3>
      <p>
        生成在后台运行并持续显示进度；Schema、Evidence 和领域引用失败会整次关闭。
      </p>
      {state.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="primary-button full-width-button" disabled={pending} type="submit">
        {pending ? "正在启动后台任务…" : "生成 Story Map"}
        {!pending ? <span aria-hidden="true">→</span> : null}
      </button>
    </form>
  );
}
