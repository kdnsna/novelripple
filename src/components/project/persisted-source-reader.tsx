import type { Source } from "@/domain/schemas";

export function PersistedSourceReader({ source }: { source: Source }) {
  return (
    <article className="persisted-source">
      <header>
        <div>
          <span className="eyebrow">不可变 Source</span>
          <h2>{source.title}</h2>
        </div>
        <span className="immutable-badge">只读</span>
      </header>
      <dl className="source-metadata">
        <div>
          <dt>导入时间</dt>
          <dd>{new Date(source.createdAt).toLocaleString("zh-CN")}</dd>
        </div>
        <div>
          <dt>内容 Hash</dt>
          <dd title={source.contentHash}>{source.contentHash.slice(0, 23)}…</dd>
        </div>
      </dl>
      <pre data-testid="source-reader">{source.originalText}</pre>
    </article>
  );
}
