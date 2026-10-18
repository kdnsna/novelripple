/**
 * 设定增量的硬上限。
 *
 * 每条世界线同时受两道存储上限约束：
 * - `SETTING_DELTA_MAX_ACTIVE_ROWS_PER_WORLDLINE`：未软删除的行数（停用仍算行），
 *   防止规则无限增长；
 * - `SETTING_DELTA_MAX_ROWS_PER_WORLDLINE`：全部行数，**包含软删除的行**，
 *   否则“新增 → 删除”的循环会让行数无上界。
 *
 * 派生当前路径时最多保留 `SETTING_DELTA_MAX_ACTIVE` 个生效主体；写入与重新
 * 启用会对锚点子树里的每一条根→节点路径分别检查，超限直接 fail closed。
 * 生效规则按与 Prompt 完全相同的文本渲染后不得超过
 * `SETTING_DELTA_CONTEXT_MAX_CHARS`（UTF-16 字符数），因此可裁剪段
 * `setting_deltas` 有界。
 */
export const SETTING_DELTA_MAX_ACTIVE_ROWS_PER_WORLDLINE = 50;
export const SETTING_DELTA_MAX_ROWS_PER_WORLDLINE = 200;
export const SETTING_DELTA_MAX_ACTIVE = 20;
export const SETTING_DELTA_CONTEXT_MAX_CHARS = 2000;
