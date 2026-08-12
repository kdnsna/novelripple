# Story Map Reconcile v3 — Global Reconciler

根据全部已校验的 Segment Candidates、Section 索引和临时 Evidence Reference，生成一个全局 Story Map 内容候选。输入不含整部 Source 正文；不得要求或臆造缺失正文。

约束：

- 合并明确属于同一人物的别名；不确定时保留独立人物，禁止猜测性 merge。
- 去除跨 Segment 重复事件，建立全局 chronology，并把 `sequence` 调整为从 1 开始且连续。
- 保留有支持的局部 Edge，并补充必要的跨 Segment `causes`、`enables`、`foreshadows`；不得产生悬空关系。
- 生成关键 `endingCandidates`，每个候选必须指向已保留的 Event。
- Event、Edge、Ending Candidate 的 `evidenceReferenceIds` 必须是一个或多个输入中真实存在且不重复的临时引用 ID；不得返回 exactQuote、正文、Section ID、偏移或 Hash。
- `participants` 始终为 string[]；`stateChanges` 始终为 string[]，没有变化时返回空数组，禁止返回单个字符串。
- 正式 Character、Event 与 Ending Candidate ID 只能使用 ASCII 字母、数字、点、下划线、冒号或连字符，并以字母或数字开头。
- 不修改 Source，不生成 Story Map ID、Source ID、版本或确认状态。
- 只输出运行时 JSON Schema 要求的 JSON，不输出解释、Markdown 或额外字段。

最小合法 JSON 形状示例（仅示意字段类型，不要复制示例值）：

```json
{
  "title": "示例标题",
  "logline": "示例梗概",
  "characters": [
    {
      "id": "character_1",
      "name": "示例人物",
      "aliases": [],
      "role": "protagonist",
      "initialState": "示例初始状态"
    }
  ],
  "events": [
    {
      "id": "event_1",
      "title": "示例事件",
      "summary": "示例摘要",
      "sequence": 1,
      "participants": ["character_1"],
      "stateChanges": [],
      "evidenceKind": "fact",
      "evidenceReferenceIds": ["evidence_ref:source_example:section_01:0:8"]
    }
  ],
  "edges": [],
  "endingCandidates": [
    {
      "id": "ending_1",
      "targetEventId": "event_1",
      "requirement": "示例条件",
      "evidenceReferenceIds": ["evidence_ref:source_example:section_01:0:8"]
    }
  ]
}
```
