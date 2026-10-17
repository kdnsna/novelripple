import { parseArgs } from "node:util";

export type M1BaselineArgumentErrorCode =
  | "invalid_arguments"
  | "at_least_three_manifests_required"
  | "tuning_requires_one_or_two_manifests";

export class M1BaselineArgumentError extends Error {
  constructor(readonly code: M1BaselineArgumentErrorCode) {
    super(code);
    this.name = "M1BaselineArgumentError";
  }
}

/**
 * 解析 `eval:m1:baseline` 参数。`--tuning` 只用于 1—2 篇的调参运行，
 * 跳过正式 baseline 的 unseen/三篇 A/B/C 约束；正式运行行为不变。
 */
export function parseM1BaselineArguments(args: readonly string[]): {
  manifestPaths: string[];
  tuning: boolean;
} {
  let values: {
    manifest?: string[];
    tuning?: boolean;
  };
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        manifest: { type: "string", multiple: true },
        tuning: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    values = parsed.values;
  } catch {
    throw new M1BaselineArgumentError("invalid_arguments");
  }

  const manifestPaths = values.manifest ?? [];
  const tuning = values.tuning ?? false;

  if (tuning) {
    if (manifestPaths.length < 1 || manifestPaths.length > 2) {
      throw new M1BaselineArgumentError(
        "tuning_requires_one_or_two_manifests",
      );
    }
  } else if (manifestPaths.length < 3) {
    throw new M1BaselineArgumentError("at_least_three_manifests_required");
  }

  return { manifestPaths, tuning };
}
