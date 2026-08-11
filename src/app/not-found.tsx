import Link from "next/link";

export default function NotFound() {
  return (
    <main className="error-screen">
      <span className="eyebrow">404 · 未知世界线</span>
      <h1>这里还没有故事。</h1>
      <p>返回原著基线，重新选择一个分歧点。</p>
      <Link className="primary-action" href="/">
        返回首页
      </Link>
    </main>
  );
}
