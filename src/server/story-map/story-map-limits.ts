/**
 * Story Map 分块管线的调用上限。
 *
 * 预计基础调用 = 2 × 块数 + 3（每块抽取、每块补抽、人名、结局、合并）；
 * 每个结构化调用最多 repair 一次，所以最坏情况是基础调用的两倍。
 * 上限在任何模型调用前检查，运行中再按真实尝试（含 repair）计数。
 */
export const DEFAULT_STORY_MAP_MAX_CHUNKS = 50;
export const DEFAULT_STORY_MAP_MAX_MODEL_CALLS = 120;

export type StoryMapLimits = {
  maxChunks: number;
  maxModelCalls: number;
};

export function resolveStoryMapLimits(
  override: Partial<StoryMapLimits> = {},
): StoryMapLimits {
  return {
    maxChunks:
      override.maxChunks === undefined
        ? readPositiveInteger(
            "STORY_MAP_MAX_CHUNKS",
            DEFAULT_STORY_MAP_MAX_CHUNKS,
          )
        : assertPositiveInteger("limits.maxChunks", override.maxChunks),
    maxModelCalls:
      override.maxModelCalls === undefined
        ? readPositiveInteger(
            "STORY_MAP_MAX_MODEL_CALLS",
            DEFAULT_STORY_MAP_MAX_MODEL_CALLS,
          )
        : assertPositiveInteger(
            "limits.maxModelCalls",
            override.maxModelCalls,
          ),
  };
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return assertPositiveInteger(name, value);
}

/** 显式 limits 与环境变量共用同一校验：NaN/0/负数/小数/Infinity 都在模型调用前失败。 */
function assertPositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}
