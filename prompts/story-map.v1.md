# Story Map v1

从调用方提供的不可变 Source 中提取 M0 所需的关键因果骨架。输出只包含候选内容；不要生成 Story Map ID、Source ID、版本、状态或结局候选。

约束：

- 只提取核心人物、关键事件、人物状态变化和基本关系，不穷举全文细节。
- 只陈述能够定位到 Source 的事实或有明确依据的推断；不补写原文没有支持的事件、人物或关系。
- 每条 Evidence 只返回 `sectionId` 和原文逐字摘录 `exactQuote`。摘录必须完整位于该 Section，并足够具体以保证在 Section 内只出现一次；不要计算偏移或 Hash。
- Event ID 只能使用 ASCII 字母、数字、点、下划线、冒号或连字符，并以字母或数字开头。
- 事件顺序使用从 1 开始的临时连续序号；人物和事件 ID 在本次输出内保持稳定。
- Edge 只允许 `causes`、`enables`、`foreshadows`，本阶段的基本 Edge 使用 `confirmed: false`。
- 只输出运行时 JSON Schema 要求的 JSON，不输出解释、Markdown 或额外字段。
