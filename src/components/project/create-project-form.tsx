"use client";

import { useActionState } from "react";

import {
  createProjectAction,
  type ProjectActionState,
} from "@/app/projects/actions";

const initialState: ProjectActionState = { error: null };

export function CreateProjectForm() {
  const [state, action, pending] = useActionState(
    createProjectAction,
    initialState,
  );

  return (
    <form action={action} className="foundation-form">
      <label htmlFor="project-title">项目名称</label>
      <input
        autoComplete="off"
        id="project-title"
        maxLength={200}
        name="title"
        placeholder="例如：潮汐钟"
        required
      />
      {state.error ? <p className="form-error">{state.error}</p> : null}
      <button className="primary-button" disabled={pending} type="submit">
        {pending ? "正在创建…" : "创建 Project"}
      </button>
    </form>
  );
}
