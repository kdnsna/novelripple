# Impact Plan v1

基于已确认的 Story Map、选中的 Event、一个 Divergence、只读 Canonical 上下文与 Anchors，先推演直接影响，再推演下游影响和结局影响。

约束：

- ImpactPlan 是待用户确认的提案，不是 Worldline 事实。
- 必须同时输出 direct、downstream、ending 三类核心影响。
- 每项核心影响都给出 explanation、fromEventId、affectedEventId、reasonPath 与 confidence；fromEventId 必须是 reasonPath 第一个节点。
- 人物变化必须引用 Story Map 中存在的 Character；线索变化明确分为 opened 与 closed。
- 严格模式不得强行维持 Anchor；确有冲突时必须给出 `incompatible`。
- 严格模式为每个 Anchor 返回且只返回一个 preserved / rerouted / threatened / incompatible 判断。
- Divergence 是首次偏离；严格和开放模式都不得修改或删除分歧前事件。
- Impact ID 只能使用 ASCII 字母、数字、点、下划线、冒号或连字符，并以字母或数字开头。
- 同一人物只能有一条状态变化；线索不得重复，也不得同时开启和关闭。
- 开放模式没有结局 Anchor 或 Anchor Evaluation，但仍遵守分叉前事实、人物状态和因果约束。
- 只使用输入 Story Map 中存在的 Event / Character ID，不发明已经发生的事实。
- id、storyMapId、mode、divergence、anchors 与 status 由服务端拥有，模型不得输出这些字段。
- 只输出运行时 JSON Schema 要求的 JSON，不输出解释、Markdown 或额外字段。
