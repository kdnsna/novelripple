/**
 * 设定增量的硬上限。
 *
 * 每条世界线最多保存 `SETTING_DELTA_MAX_ROWS_PER_WORLDLINE` 条不可变规则，
 * **包含软删除的行**：否则“新增 → 删除”的循环会让行数无上界。派生当前路径
 * 时最多保留 `SETTING_DELTA_MAX_ACTIVE` 个生效主体；写入与重新启用会对锚点
 * 子树里的每一条根→节点路径分别检查，超限直接 fail closed。
 * 生效规则按与 Prompt 完全相同的文本渲染后不得超过
 * `SETTING_DELTA_CONTEXT_MAX_CHARS`（UTF-16 字符数），因此可裁剪段
 * `setting_deltas` 有界。
 */
export const SETTING_DELTA_MAX_ROWS_PER_WORLDLINE = 200;
export const SETTING_DELTA_MAX_ACTIVE = 20;
export const SETTING_DELTA_CONTEXT_MAX_CHARS = 2000;
