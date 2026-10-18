/**
 * 设定增量的类型化错误。
 *
 * 仓储与领域检查只抛这一种错误；Server Action 按实例直接透传其中文
 * `message`，不再维护一份易漂移的字符串白名单。`code` 用于测试与调用方
 * 分支判断，不展示给读者。
 */
export type SettingDeltaErrorCode =
  | "forbidden_char"
  | "invalid_statement_length"
  | "invalid_idempotency_key"
  | "invalid_lifecycle_idempotency_key"
  | "worldline_not_found"
  | "story_map_not_confirmed"
  | "invalid_anchor"
  | "unknown_character"
  | "idempotency_conflict"
  | "lifecycle_idempotency_conflict"
  | "delta_not_found"
  | "deleted_terminal"
  | "path_active_limit"
  | "path_text_limit"
  | "worldline_active_rows_limit"
  | "worldline_total_rows_limit"
  | "artifact_write_failed"
  | "lifecycle_write_failed";

export class SettingDeltaError extends Error {
  readonly code: SettingDeltaErrorCode;

  constructor(code: SettingDeltaErrorCode, message: string) {
    super(message);
    this.name = "SettingDeltaError";
    this.code = code;
  }
}

export function isSettingDeltaError(value: unknown): value is SettingDeltaError {
  return value instanceof SettingDeltaError;
}
