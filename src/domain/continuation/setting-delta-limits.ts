/**
 * 设定增量的硬上限。
 *
 * 每条世界线最多保存 `SETTING_DELTA_MAX_PER_WORLDLINE` 条不可变规则；派生
 * 当前路径时最多保留 `SETTING_DELTA_MAX_ACTIVE` 个生效主体。单条 statement
 * 上限 200 字、术语名上限 40 字，因此必需上下文中的设定增量有界
 * （≤ 20 × 约 260 字），不需要进入裁剪阶梯。
 */
export const SETTING_DELTA_MAX_PER_WORLDLINE = 50;
export const SETTING_DELTA_MAX_ACTIVE = 20;
