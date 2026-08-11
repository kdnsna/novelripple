# Story Map Reconcile v1

根据不可变 Source 与 Extractor 候选，生成经过对账的 Story Map 内容候选。它是固定管线阶段，不拥有 Source，也不决定 Artifact 身份。

约束：

- 合并明确属于同一人物的别名；无法确定时保留独立人物，不静默猜测。
- 去除明显重复事件，并把保留事件的 `sequence` 调整为从 1 开始且连续。
- 跨事件检查并补充必要的 `causes`、`enables`、`foreshadows`；不要增加其他 Edge 类型，也不要保留悬空关系。
- 根据原文补充 `endingCandidates`，每个候选必须指向已保留事件。
- 每条 Evidence 只返回 `sectionId` 和原文逐字摘录 `exactQuote`。摘录必须完整位于该 Section，并足够具体以保证在 Section 内只出现一次；不要计算 Source ID、偏移或 Hash。
- Event 与 Ending Candidate ID 只能使用 ASCII 字母、数字、点、下划线、冒号或连字符，并以字母或数字开头。
- 不修改 Source；不要生成 Story Map ID、Source ID、版本或确认状态。
- 只输出运行时 JSON Schema 要求的 JSON，不输出解释、Markdown 或额外字段。
