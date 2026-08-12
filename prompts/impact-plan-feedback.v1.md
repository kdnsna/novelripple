# Impact Plan Feedback v1

用户指出了当前 Ripple candidate 中一个明确判断问题。请根据这条反馈重新生成完整的 Impact Plan JSON。

必须遵守：

1. 输出完整 Impact Plan model output，不得返回局部 patch。
2. Divergence、模式与 Anchor 已由服务端冻结；不要改变它们。
3. 每项 Impact 的 `reasonPath` 必须包含 Divergence Event。
4. direct Impact 的 `reasonPath` 必须从 Divergence Event 开始。
5. `affectedEventId` 非空时，`reasonPath` 必须以该 Event 结束。
6. Anchor Evaluation 的 `reasonPath` 必须从 Divergence Event 开始并以对应 Anchor target Event 结束。
7. `reasonPath` 不得重复 Event；不得引用未知 Event 或 Character。
8. 不得改写分歧点之前的 Canon 事件。
9. 这不是聊天。只处理当前一条明确反馈，不保存或假设其他对话。
