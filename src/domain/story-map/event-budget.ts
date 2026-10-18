/**
 * Story Map 事件预算：参考标注随正文长度次线性增长，约每 √核心字符数
 * 0.20 个事件。预算只用于合并轮的粒度提示，不改变 Schema、Evidence 或
 * 事件语义。
 */

/** 长度预算系数：expectedEvents ≈ 0.20 × √coreTextChars。 */
export const EVENT_BUDGET_PER_SQRT_CHAR = 0.2;

/** 折叠触发系数：事件数超过 0.25 × √coreTextChars 时才启用同情节连续步骤折叠。 */
export const EVENT_FOLD_TRIGGER_PER_SQRT_CHAR = 0.25;

/** expectedEvents 与 foldAbove 的下限，避免极短文本把预算压到 1–2 个事件。 */
export const EVENT_BUDGET_FLOOR = 3;

export interface StoryMapEventBudget {
  coreTextChars: number;
  eventCount: number;
  expectedEvents: number;
  foldAbove: number;
  foldRequired: boolean;
}

/**
 * 计算合并轮的确定性事件预算。
 *
 * - `expectedEvents`：由核心文本长度推导的目标事件数；
 * - `foldAbove`：事件数超过该值时才允许把同一情节的连续步骤折叠；
 * - `foldRequired`：`eventCount > foldAbove`，即是否启用更激进的折叠规则。
 */
export function computeEventBudget(
  coreTextChars: number,
  eventCount: number,
): StoryMapEventBudget {
  const sqrtChars = Math.sqrt(coreTextChars);
  const expectedEvents = Math.max(
    EVENT_BUDGET_FLOOR,
    Math.round(EVENT_BUDGET_PER_SQRT_CHAR * sqrtChars),
  );
  const foldAbove = Math.max(
    EVENT_BUDGET_FLOOR,
    Math.round(EVENT_FOLD_TRIGGER_PER_SQRT_CHAR * sqrtChars),
  );
  return {
    coreTextChars,
    eventCount,
    expectedEvents,
    foldAbove,
    foldRequired: eventCount > foldAbove,
  };
}
