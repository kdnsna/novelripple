import type { CSSProperties } from "react";

import type { WorldlineTreeRow } from "@/domain/continuation/worldline-tree";

import {
  worldlineTreeRowBadges,
  worldlineTreeRowLabel,
} from "./worldline-tree-ui";

type WorldlineTreeNavProps = {
  rows: readonly WorldlineTreeRow[];
  onMove: (row: WorldlineTreeRow) => void;
  onToggle: (id: string | null) => void;
};

/**
 * 只读世界线树。行本身只负责移动阅读位置，展开/折叠是独立的按钮，
 * 避免同一个按钮同时承担两种动作。
 */
export function WorldlineTreeNav({
  rows,
  onMove,
  onToggle,
}: WorldlineTreeNavProps) {
  return (
    <nav
      aria-label="世界线树"
      className="worldline-tree-nav"
      data-testid="worldline-tree"
    >
      <div className="worldline-tree-heading">
        <span className="panel-kicker">世界线树</span>
        <span className="worldline-tree-count">{rows.length - 1} 个场景</span>
      </div>

      <ul aria-label="世界线树" className="worldline-tree" role="tree">
        {rows.map((row) => {
          const label = worldlineTreeRowLabel(row);
          const badges = worldlineTreeRowBadges(row);
          return (
            <li
              aria-current={row.isCurrent ? "true" : undefined}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              aria-level={row.level + 1}
              aria-selected={row.isCurrent}
              className={`worldline-tree-item ${
                row.onCurrentPath ? "on-path" : ""
              } ${row.isCurrent ? "current" : ""}`}
              data-current={row.isCurrent ? "true" : undefined}
              data-testid="worldline-tree-row"
              key={row.id ?? "root"}
              role="treeitem"
            >
              <div
                className="worldline-tree-row"
                style={{ "--tree-level": row.level } as CSSProperties}
              >
                <button
                  className="worldline-tree-row-button"
                  onClick={() => onMove(row)}
                  type="button"
                >
                  {label}
                </button>
                {badges.length > 0 ? (
                  <span className="worldline-tree-badges">
                    {badges.map((badge) => (
                      <span className="worldline-tree-badge" key={badge}>
                        {badge}
                      </span>
                    ))}
                  </span>
                ) : null}
                {row.hasChildren ? (
                  <button
                    aria-expanded={row.expanded}
                    aria-label={row.expanded ? "折叠" : "展开"}
                    className="worldline-tree-toggle"
                    onClick={() => onToggle(row.id)}
                    type="button"
                  >
                    {row.expanded ? "▾" : "▸"}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="worldline-tree-hint">
        点任意节点即可从那里重开；已有内容不会被覆盖，新内容会成为新的分支。
      </p>
    </nav>
  );
}
