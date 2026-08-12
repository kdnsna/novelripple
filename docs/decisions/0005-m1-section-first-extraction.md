# 0005：M1 统一 Section-first 提取

- 状态：Accepted
- 日期：2026-08-13
- 范围：M1 — Real Story / M1-03

## 问题与证据

[`M1-02 架构决策补充`](../evals/runs/m1-02-architecture-decision-2026-08-12-1882e37.md)已根据冻结真实作品数据得出 `SECTION-FIRST REQUIRED`：Story B 存在核心人物漏检，三篇人物 identity micro-F1 未达 M1 门槛，Ending coverage 不足，双全书调用 token 最高达到 196,230。M1-02A 已独立证明 Provider wire mode 与最终 Evidence validity 可用，因此本决策只处理长文提取覆盖与全书重复调用，不改写 M1-02 的产品质量 FAIL。

产品范围仍由 [`docs/mvp.md`](../mvp.md) 所有，质量阈值仍由 [`docs/evals.md`](../evals.md) 所有；完整接口和失败边界见 [M1-03 设计](../superpowers/specs/2026-08-12-m1-03-section-first-extraction-design.md)。

## 决定

Story Map generation 只有一条生产路径：

```text
Source
→ deterministic AnalysisSegment
→ local extraction
→ exact Evidence resolution
→ positional dedupe
→ global reconcile
→ deterministic validation
→ Story Map Artifact
```

- `AnalysisSegment` 只从不可变 Source 的既有 `SourceSection` 边界确定性派生，不增加数据库表。目标 core 为约 6k—10k 中文字符；短作品产生一个 Segment；非首段最多携带一个前置 Section 作为 context。
- 局部 Extractor 统一使用 `story-map.v3`。Event / Edge 只有第一条 Evidence 完整位于 core 时才可由该 Segment claim；context 只提供边界理解和补充 Evidence。
- 局部 Candidate 返回 `{sectionId, exactQuote}`。服务端只接受指定 Section 内逐字且唯一的匹配，确定 UTF-16 offset 与 Hash，并转成临时 Evidence Reference ID；不做 fuzzy match、相似度搜索或本地 coercion。
- 重叠 context 造成的同位置 Event / Edge 在全局调用前按确定性位置键去重。Global Reconciler 使用 `story-map-reconcile.v3`，只接收 Segment Candidate、Section 索引和临时 Evidence Reference，不再次接收整部 Source 正文；它负责 alias merge、全局 chronology、跨段 Edge 与 Ending Candidate。
- 最终 `SourceReference[]`、Story Map revision、Artifact、Impact Plan、Worldline 与 Continuation 合同不变；既有 M0 Artifact 不迁移。
- Segment 调用用简单成对执行控制并发上限为 2，不引入 queue。每个 Segment 与 Global Reconciler 都沿用现有最多一次 repair；任一 Segment 失败时保留 Generation Run，但不运行 Global Reconciler、不保存半成品 Artifact。
- 旧 Evidence Unit Candidate 路径被删除，不保留 small / large 双轨或 fallback。

## Open-source preflight

检索日期：2026-08-13。只核对 Google LangExtract 的[官方仓库](https://github.com/google/langextract)、[官方文档](https://github.com/google/langextract#readme)、[官方 Release](https://github.com/google/langextract/releases/tag/v1.6.0)与 [Apache-2.0 LICENSE](https://github.com/google/langextract/blob/main/LICENSE)。维护与采用数字是检索日快照，只作风险信号。

| 核对项 | 官方事实与适配判断 | 决定 |
| --- | --- | --- |
| 许可与维护 | Apache-2.0；`v1.6.0` 于 2026-07-02 发布；约 38.3k Stars / 2.7k Forks，项目仍在维护 | 许可清晰，但本次不复制或改编代码 |
| segmentation / multi-pass | 官方实现将长文分块，可并行和多轮抽取，并可携带前文上下文 | 只借鉴“Section 边界分段、最多 2 并发、单一路径”的方法；不照搬调度与多轮框架 |
| precise grounding | 官方强调把抽取结果定位回原文字符区间 | 复用 NovelRipple 既有 UTF-16 offset / Hash Validator；局部 exact claim 由服务端确定性解析 |
| overlap / dedupe | 官方对 chunk overlap 的重复抽取进行合并 | 只实现当前 Event / Edge 所需的位置去重；人物语义合并交给单次 Global Reconcile，不引入通用聚类平台 |
| 依赖与隐私 | 官方包要求 Python ≥3.10，并带来额外模型 Provider、数据处理和可携带正文的产物面 | 不引入 Python、LangExtract runtime 或其依赖；不新增正文日志、JSONL 或可视化产物 |

仓库现有 TypeScript、Zod、OpenAI-compatible Provider、Generation Run 与 Artifact 边界足以实现该最小切片。新依赖为 **none**。

## 明确拒绝

本决策不引入 RAG、向量数据库、图数据库、Python 服务、多 Agent、后台队列、模型路由、多模型投票、第二套 Provider / Artifact / Eval 系统、模糊 Evidence 定位或短长作品双轨。若冻结 Story A/B/C 回归没有改善真实失败、Evidence 退化或修正成本明显增加，必须按 M1-03 retention gate 撤销该生产架构，不能因代码已经完成而保留。
