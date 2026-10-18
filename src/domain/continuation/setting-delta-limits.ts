/**
 * 设定增量的硬上限。
 *
 * 每条世界线最多保存 `SETTING_DELTA_MAX_PER_WORLDLINE` 条不可变规则
 * （软删除释放名额）；派生当前路径时最多保留 `SETTING_DELTA_MAX_ACTIVE`
 * 个生效主体，并在写入时按锚点路径检查，超限直接 fail closed。
 * 生效规则序列化后不得超过 `SETTING_DELTA_CONTEXT_MAX_CHARS`（按 NFKC +
 * 控制字符规范化后的 UTF-16 字符数），因此可裁剪段 `setting_deltas` 有界。
 */
export const SETTING_DELTA_MAX_PER_WORLDLINE = 50;
export const SETTING_DELTA_MAX_ACTIVE = 20;
export const SETTING_DELTA_CONTEXT_MAX_CHARS = 2000;
