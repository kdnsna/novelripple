import { realpathSync } from "node:fs";
import path from "node:path";

import { isPathInside } from "@/evals/benchmark-root";

/**
 * M1 仪表盘报告落盘决策（纯路径判断，不读文件系统）。
 *
 * 私有 benchmark 的 ID 与报告不得进入受版本控制的仓库路径：
 * - 任一篇 manifest 为 `visibility: "private"`，或位于 `NOVELRIPPLE_BENCH_ROOT` /
 *   仓库 `benchmarks/private` 内，整次运行按 private 处理；
 * - private 运行的默认报告与 metrics.json 同目录（`.data/evals/...`）；
 *   `--report-dir` 只能在仓库外，或位于 Git 忽略的仓库内路径；
 * - 报告里的私有 benchmark ID 替换为 `private:<storyClass>`。
 */
export type M1ReportStory = {
  storyClass: string;
  benchmarkId: string;
  /** 已 realpath 的 manifest 路径。 */
  manifestPath: string;
  visibility?: string;
};

export type M1ReportRoutingInput = {
  /** 已 realpath 的仓库根目录。 */
  repositoryRoot: string;
  stories: readonly M1ReportStory[];
  reportDir?: string;
  reportDirProvided?: boolean;
  /** 已 realpath 的 NOVELRIPPLE_BENCH_ROOT。 */
  extraPrivateRoot?: string;
  /**
   * 判断一个已解析路径是否被 Git 忽略；脚本用 `git check-ignore -q` 实现。
   * 未提供时，仓库内路径一律按未忽略处理（fail closed）。
   */
  isGitIgnored?: (path: string) => boolean;
  /**
   * 解析真实路径；默认 `fs.realpathSync`。测试可注入，脚本显式传入。
   * 对不存在的报告目录，会先 realpath 最深的已存在祖先，再拼回剩余部分。
   */
  realpath?: (path: string) => string;
};

export type M1ReportRouting = {
  privateRun: boolean;
  privateStoryClasses: readonly string[];
  /** run-directory：与 metrics.json 同目录；docs-runs：仓库 `docs/evals/runs`。 */
  reportTarget: "run-directory" | "docs-runs";
  redactPrivateBenchmarkIds: boolean;
  /** realpath 后的 --report-dir（若提供）；脚本应使用它落盘。 */
  resolvedReportDir?: string;
};

export type M1ReportRoutingErrorCode =
  | "report_dir_inside_repository_for_private_run";

export class M1ReportRoutingError extends Error {
  constructor(readonly code: M1ReportRoutingErrorCode) {
    super(code);
    this.name = "M1ReportRoutingError";
  }
}

/**
 * realpath 一个可能尚不存在的路径：找到最深的已存在祖先做 realpath，
 * 再把不存在的剩余片段拼回去。这样符号链接无法绕过后续的仓库内/忽略检查。
 */
export function resolveRealpathWithMissingTail(
  candidate: string,
  realpath: (path: string) => string = realpathSync,
): string {
  const absolute = path.resolve(candidate);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpath(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function resolveM1ReportRouting(
  input: M1ReportRoutingInput,
): M1ReportRouting {
  const privateRoots = [
    path.join(input.repositoryRoot, "benchmarks", "private"),
    ...(input.extraPrivateRoot ? [input.extraPrivateRoot] : []),
  ];
  const privateStoryClasses = input.stories
    .filter(
      (story) =>
        story.visibility === "private" ||
        privateRoots.some((root) =>
          isPathInside(root, story.manifestPath),
        ),
    )
    .map((story) => story.storyClass);
  const privateRun = privateStoryClasses.length > 0;
  const reportDirProvided =
    input.reportDirProvided ?? input.reportDir !== undefined;
  // 先 realpath，再做仓库内 / Git ignored 判断：忽略目录里的符号链接
  // 不能指向受版本控制目录，仓库外链接也不能指回仓库内。
  const resolvedReportDir = input.reportDir
    ? resolveRealpathWithMissingTail(
        input.reportDir,
        input.realpath ?? realpathSync,
      )
    : undefined;

  if (privateRun && reportDirProvided && resolvedReportDir) {
    if (
      isPathInside(input.repositoryRoot, resolvedReportDir) &&
      input.isGitIgnored?.(resolvedReportDir) !== true
    ) {
      throw new M1ReportRoutingError(
        "report_dir_inside_repository_for_private_run",
      );
    }
  }

  return {
    privateRun,
    privateStoryClasses,
    reportTarget:
      privateRun || reportDirProvided ? "run-directory" : "docs-runs",
    redactPrivateBenchmarkIds: privateRun,
    ...(resolvedReportDir ? { resolvedReportDir } : {}),
  };
}

/** 私有 benchmark 在报告中的稳定替代标识。 */
export function redactM1BenchmarkId(storyClass: string): string {
  return `private:${storyClass}`;
}
