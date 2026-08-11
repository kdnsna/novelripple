import Link from "next/link";

import { CreateProjectForm } from "@/components/project/create-project-form";

export const metadata = { title: "创建故事项目" };

export default function NewProjectPage() {
  return (
    <main className="foundation-shell">
      <nav className="foundation-nav">
        <Link className="brand-lockup" href="/">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>NovelRipple</strong>
            <small>故事涟漪</small>
          </span>
        </Link>
        <Link className="quiet-link" href="/">
          返回首页
        </Link>
      </nav>
      <section className="foundation-card narrow-card">
        <span className="eyebrow">First Ripple · Step 01</span>
        <h1>创建故事项目</h1>
        <p>项目用于保存原著的不可变 Source。创建后再导入故事文件。</p>
        <CreateProjectForm />
      </section>
    </main>
  );
}
