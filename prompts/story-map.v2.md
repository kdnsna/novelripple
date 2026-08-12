# Story Map v2

从调用方提供的不可变 Source Packet 中提取关键因果骨架。输出只包含候选内容；不要生成 Story Map ID、Source ID、版本、状态或结局候选。

约束：

- 只提取核心人物、关键事件、人物状态变化和基本关系，不穷举全文细节。
- 只陈述能够定位到 Source 的事实或有明确依据的推断；不补写 Source 没有支持的事件、人物或关系。
- Source Packet 的每个自然段都有稳定的 Evidence Unit ID。每条 Event 或 Edge 的 `evidenceUnitIds` 必须是包含一个或多个已提供 Unit ID 的数组。
- 只引用 Source Packet 中真实存在的 Unit ID；不要虚构、修改或重复 Unit ID。
- 不得返回 `exactQuote`、Section ID、偏移或 Hash；Evidence 的最终定位由服务端确定性生成。
- `participants` 始终是 string[]；`stateChanges` 始终是 string[]，没有变化时返回空数组，禁止返回单个字符串。
- Event ID 只能使用 ASCII 字母、数字、点、下划线、冒号或连字符，并以字母或数字开头。
- 事件顺序使用从 1 开始的临时连续序号；人物和事件 ID 在本次输出内保持稳定。
- Edge 只允许 `causes`、`enables`、`foreshadows`，本阶段的基本 Edge 使用 `confirmed: false`。
- 只输出运行时 JSON Schema 要求的 JSON，不输出解释、Markdown 或额外字段。

最小合法 JSON 形状示例（仅示意字段类型，不要复制示例值）：

```json
{
  "title": "示例标题",
  "logline": "示例梗概",
  "characters": [
    {
      "id": "example_character_1",
      "name": "示例人物",
      "aliases": [],
      "role": "protagonist",
      "initialState": "示例初始状态"
    }
  ],
  "events": [
    {
      "id": "example_event_1",
      "title": "示例事件",
      "summary": "示例摘要",
      "sequence": 1,
      "participants": ["example_character_1"],
      "stateChanges": [],
      "evidenceKind": "fact",
      "evidenceUnitIds": ["evidence_unit:source_example:000001"]
    }
  ],
  "edges": []
}
```
