import Link from "next/link";

import {
  countProjects,
  listProjects,
} from "@/server/repositories/project-repository";

export const dynamic = "force-dynamic";

const principles = [
  {
    number: "01",
    title: "先理解",
    body: "每个关键事件都能回到原文，不把模型推断伪装成事实。",
  },
  {
    number: "02",
    title: "再推演",
    body: "改变发生前先展示因果路径、人物变化与结局风险。",
  },
  {
    number: "03",
    title: "后写作",
    body: "只有你确认影响，候选计划才会成为一条正式新世界线。",
  },
] as const;

export default function Home() {
  const projects = listProjects(3);
  const projectCount = countProjects();

  return (
    <main className="landing-shell">
      <nav className="landing-nav" aria-label="主导航">
        <Link className="brand-lockup" href="/">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>NovelRipple</strong>
            <small>故事涟漪</small>
          </span>
        </Link>
        <div className="nav-meta">
          <span className="status-dot" />
          M0 · First Ripple
        </div>
      </nav>

      <section className="hero-section">
        <div className="hero-copy">
          <div className="eyebrow">可追溯的分支叙事实验</div>
          <h1>
            改变一个选择，
            <span>先看见它</span>
            <span>如何荡开。</span>
          </h1>
          <p className="hero-lede">
            NovelRipple 把完成的小说变成一张可以核对、分叉和继续的故事地图。
            原著保持只读，每一次改变都先经过证据和因果检查。
          </p>
          <p className="fixture-note" role="status">
            {projectCount === 0
              ? "当前没有故事项目"
              : `当前有 ${projectCount} 个故事项目`}
          </p>
          <div className="hero-actions">
            <Link className="primary-action" href="/projects/new">
              创建故事项目
              <span aria-hidden="true">↗</span>
            </Link>
            <a className="text-action" href="#how-it-works">
              看它如何工作
              <span aria-hidden="true">↓</span>
            </a>
          </div>
          <p className="fixture-note">
            Source 只在本地 SQLite 持久化且不会被生成内容覆盖；生成 Story Map
            时，正文会发送到你配置的模型端点。
          </p>
          {projects.length > 0 ? (
            <div className="recent-projects">
              <span>最近项目</span>
              {projects.map((project) => (
                <Link href={`/projects/${project.id}`} key={project.id}>
                  {project.title}
                </Link>
              ))}
            </div>
          ) : null}
        </div>

        <div className="hero-visual" aria-label="世界线涟漪示意">
          <div className="ripple-orbit ripple-orbit-one" />
          <div className="ripple-orbit ripple-orbit-two" />
          <div className="ripple-orbit ripple-orbit-three" />
          <div className="canon-line">
            <span className="story-dot story-dot-one" />
            <span className="story-dot story-dot-two" />
            <span className="story-dot story-dot-three" />
            <span className="story-dot story-dot-four" />
          </div>
          <div className="branch-line branch-line-a" />
          <div className="branch-line branch-line-b" />
          <div className="divergence-core">
            <small>分歧点</small>
            <strong>一个选择</strong>
          </div>
          <div className="visual-caption visual-caption-canon">
            <span /> 原著世界线
          </div>
          <div className="visual-caption visual-caption-new">
            <span /> 新世界线
          </div>
        </div>
      </section>

      <section className="principles-section" id="how-it-works">
        <div className="section-heading">
          <div>
            <span className="eyebrow">唯一闭环</span>
            <h2>理解不是前置步骤，它就是可信度。</h2>
          </div>
          <p>导入 → 故事地图 → 改变节点 → 涟漪预览 → 新世界线</p>
        </div>
        <div className="principle-grid">
          {principles.map((principle) => (
            <article className="principle-card" key={principle.number}>
              <span>{principle.number}</span>
              <h3>{principle.title}</h3>
              <p>{principle.body}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
