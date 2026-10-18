export const DEFAULT_CONTINUATION_CONTEXT_MAX_CHARS = 24_000;
export const CONTINUATION_CONTEXT_MAX_CHARS_ENV =
  "CONTINUATION_CONTEXT_MAX_CHARS";

/**
 * 读取上下文预算。未配置时使用默认值；配置值必须是正整数，
 * 否则 fail closed（不做字符串截取或回退到默认值的猜测）。
 */
export function readContinuationContextMaxChars(): number {
  const raw = process.env[CONTINUATION_CONTEXT_MAX_CHARS_ENV];
  if (raw === undefined) return DEFAULT_CONTINUATION_CONTEXT_MAX_CHARS;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(
      `${CONTINUATION_CONTEXT_MAX_CHARS_ENV} 必须是正整数：${raw}`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `${CONTINUATION_CONTEXT_MAX_CHARS_ENV} 必须是安全正整数：${raw}`,
    );
  }
  return parsed;
}
