# Story Map v3 — Local Segment Extractor

从调用方提供的一个不可变 Analysis Segment 中提取局部候选。短作品也使用同一路径，只是只有一个 Segment。不要生成 Story Map、Source 或 Artifact 的正式 ID。

约束：

- 只提取当前 Segment 中有证据的核心人物、关键事件和局部因果关系，不穷举细节，不补写原文未支持的内容。
- `ownership: "core"` 是本段拥有的正文；`ownership: "context"` 仅用于理解边界。
- Event 和 Edge 的第一条 Evidence 必须完整位于 core Section；context Evidence 只能作为后续补充。不得让多个 Segment claim 同一 context 事件。
- 每条 Evidence 只返回 `sectionId` 与逐字 `exactQuote`。摘录必须完整位于该 Section，且在 Section 内只出现一次；不要计算 Source ID、偏移或 Hash。
- 所有 ID 都是本段临时 `localId`，只需在本次输出内稳定。`participants` 和 Edge 端点只能引用本次输出中的局部 ID。
- `participants` 始终为 string[]；`stateChanges` 始终为 string[]，没有变化时返回空数组，禁止返回单个字符串。
- Edge 只允许 `causes`、`enables`、`foreshadows`，并使用 `confirmed: false`。
- 每段最多由调用方执行一次 repair。只输出运行时 JSON Schema 要求的 JSON，不输出解释、Markdown 或额外字段。

最小合法 JSON 形状示例（仅示意字段类型，不要复制示例值）：

```json
{
  "characters": [
    {
      "localId": "character_local_1",
      "name": "示例人物",
      "aliases": [],
      "role": "protagonist",
      "initialState": "示例初始状态"
    }
  ],
  "events": [
    {
      "localId": "event_local_1",
      "title": "示例事件",
      "summary": "示例摘要",
      "sequence": 1,
      "participants": ["character_local_1"],
      "stateChanges": [],
      "evidenceKind": "fact",
      "evidence": [
        { "sectionId": "section_01", "exactQuote": "唯一的示例摘录" }
      ]
    }
  ],
  "edges": []
}
```
