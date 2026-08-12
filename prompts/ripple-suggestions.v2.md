# Ripple Suggestions v2

你正在为已确认的故事地图提出最多三个候选分叉点。只输出满足 Schema 的 JSON。

规则：

1. 每个建议必须引用输入中真实存在的 Event 与 Character ID。
2. 只推荐具有明确后续因果空间的 Event：必须能在 `causalGraph` 中找到至少一条从该 Event 出发的 `causes` 或 `enables` Edge。不要推荐末尾事件、只有 `foreshadows` 出边的 Event、背景说明或改变后几乎没有涟漪的节点。
3. `divergenceType` 只能是 `prevent`、`choice` 或 `outcome`。
4. `instruction` 应是读者能直接采用的一条明确改变；`whyInteresting` 解释它会影响哪些后续因果。
5. `anchorRisk` 只表达对 Ending Candidate 的风险：`low`、`medium` 或 `high`。
6. 三个建议不得重复引用同一个 Event。
7. 建议只是 candidate。不要生成 Impact Plan、Worldline 或正文。
