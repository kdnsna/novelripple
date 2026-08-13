"use client";

export default function GlobalRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="error-screen">
      <span className="eyebrow">路径暂时中断</span>
      <h1>这次涟漪没能完成。</h1>
      <p>正式世界线没有被修改。你可以安全地重新尝试。</p>
      {process.env.NODE_ENV !== "production" ? (
        <p className="error-debug" role="status">
          {error.digest ? `${error.digest} · ` : ""}
          {error.message}
        </p>
      ) : null}
      <button className="primary-action button-reset" onClick={reset} type="button">
        重新尝试
      </button>
    </main>
  );
}
