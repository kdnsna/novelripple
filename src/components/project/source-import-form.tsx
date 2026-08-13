"use client";

import { useActionState } from "react";

import {
  importProjectSourceAction,
  type ProjectActionState,
} from "@/app/projects/actions";

const initialState: ProjectActionState = { error: null };

export function SourceImportForm({ projectId }: { projectId: string }) {
  const actionWithProject = importProjectSourceAction.bind(null, projectId);
  const [state, action, pending] = useActionState(
    actionWithProject,
    initialState,
  );

  return (
    <form action={action} className="foundation-form source-import-form">
      <label htmlFor="source-file">故事文件</label>
      <input
        accept=".txt,.md,text/plain,text/markdown"
        id="source-file"
        name="sourceFile"
        required
        type="file"
      />
      <p className="form-help">仅支持 UTF-8 编码的 .txt / .md，最大 512 KB。</p>
      {state.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="primary-button" disabled={pending} type="submit">
        {pending ? "正在导入…" : "导入 Source"}
      </button>
    </form>
  );
}
