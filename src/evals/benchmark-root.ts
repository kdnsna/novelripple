import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export type BenchmarkRootVisibility = "public" | "private";

export type BenchmarkRootSelection = {
  root: string;
  visibility: BenchmarkRootVisibility;
};

export type BenchmarkRootErrorCode =
  | "benchmark_root_not_found"
  | "benchmark_root_not_directory";

export class BenchmarkRootError extends Error {
  constructor(readonly code: BenchmarkRootErrorCode) {
    super(code);
    this.name = "BenchmarkRootError";
  }
}

/**
 * 纯路径判断：只比较路径，不读文件系统。调用方应先 realpath。
 */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * 纯根选择：入参均应为 realpath 结果；不读 env、不做 I/O。
 * public 优先于 private，避免额外的 private 根覆盖公开作品的分类。
 */
export function selectBenchmarkRoot(input: {
  manifestPath: string;
  publicRoot?: string;
  privateRoot?: string;
  extraPrivateRoot?: string;
}): BenchmarkRootSelection | null {
  if (
    input.publicRoot &&
    isPathInside(input.publicRoot, input.manifestPath)
  ) {
    return { root: input.publicRoot, visibility: "public" };
  }
  if (
    input.privateRoot &&
    isPathInside(input.privateRoot, input.manifestPath)
  ) {
    return { root: input.privateRoot, visibility: "private" };
  }
  if (
    input.extraPrivateRoot &&
    isPathInside(input.extraPrivateRoot, input.manifestPath)
  ) {
    return { root: input.extraPrivateRoot, visibility: "private" };
  }
  return null;
}

/**
 * 解析各根目录的 realpath 后交给纯选择器。
 * 仓库内 private 根缺失仍是合法状态；显式提供的额外 private 根缺失或不是目录则报错。
 */
export async function resolveBenchmarkRoot(input: {
  manifestPath: string;
  publicRoot: string;
  privateRoot: string;
  extraPrivateRoot?: string;
}): Promise<BenchmarkRootSelection | null> {
  let publicRoot: string;
  try {
    publicRoot = await realpath(input.publicRoot);
  } catch {
    throw new BenchmarkRootError("benchmark_root_not_found");
  }

  let privateRoot: string | undefined;
  try {
    privateRoot = await realpath(input.privateRoot);
  } catch {
    // A missing private directory is a valid repository state.
  }

  const extraPrivateRoot = await resolveExtraPrivateRoot(
    input.extraPrivateRoot,
  );

  return selectBenchmarkRoot({
    manifestPath: input.manifestPath,
    publicRoot,
    ...(privateRoot ? { privateRoot } : {}),
    ...(extraPrivateRoot ? { extraPrivateRoot } : {}),
  });
}

async function resolveExtraPrivateRoot(
  value: string | undefined,
): Promise<string | undefined> {
  const requested = value?.trim();
  if (!requested) return undefined;

  let resolved: string;
  try {
    resolved = await realpath(path.resolve(requested));
  } catch {
    throw new BenchmarkRootError("benchmark_root_not_found");
  }

  const entry = await stat(resolved).catch(() => null);
  if (!entry) {
    throw new BenchmarkRootError("benchmark_root_not_found");
  }
  if (!entry.isDirectory()) {
    throw new BenchmarkRootError("benchmark_root_not_directory");
  }
  return resolved;
}
