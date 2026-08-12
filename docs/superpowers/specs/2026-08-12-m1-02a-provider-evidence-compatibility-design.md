# M1-02A Provider & Evidence Grounding Compatibility

日期：2026-08-12
状态：已获设计方向确认，待实现
基线 commit：`7ccc1b45d4b5d650f2d7aba904dd1e58f7fef3a2`

## 用户结果与最小验收场景

M1-02A 只解决 DeepSeek 的结构化输出与 Evidence grounding 兼容性：同一 `deepseek-chat` 模型必须通过显式 `json_object` 模式返回可由 NovelRipple 本地 Schema、Evidence 和领域不变量验证的 Story Map candidate，而不降低最终 `SourceReference` 契约、不增加 repair 次数，也不改变故事理解架构。

最小验收场景：

1. 从不可变 Source 的现有 Section 和自然段确定性派生 Evidence Unit；
2. Extractor 和 Reconciler 读取带稳定 Unit ID 的 Source Packet；
3. 模型只返回 `evidenceUnitIds: string[]`，不重抄原文；
4. 服务端把 Unit ID 确定性解析为现有 `SourceReference[]`；
5. Candidate 只有通过 Zod、Unit 归属、重复引用、Evidence offset/hash、引用完整性和 Story Map 领域不变量后才创建 draft Artifact；
6. 用冻结的 Story A/B/C 和同一 `deepseek-chat` 重跑 baseline，记录每阶段首轮/repair、Evidence validity、Artifact、tokens 和 duration。

## 范围与非目标

本 Issue 只包含：

- 新增显式 `json_object` Structured Output mode；
- DeepSeek baseline 固定使用 `json_object`；
- Evidence Unit 派生、Source Packet、Candidate Schema 和确定性 Evidence resolution；
- Extractor / Reconciler Prompt 升版及格式示例；
- baseline 兼容性指标；
- 对应单元、合约、全量回归与真实三篇 baseline。

本 Issue 不包含 section-first、chunking、RAG、向量数据库、图数据库、Python、多 Agent、后台队列、模型路由、capability detection、自动 fallback、模糊匹配、字符串相似度、embedding search、本地 Schema coercion 或额外 repair。M1-02 baseline 暂停，M1-03 不启动。

## Open-source preflight

问题边界是“让现有 TypeScript/OpenAI-compatible Provider 显式使用端点支持的 JSON 协议，并把模型生成原文摘录改为模型选择服务端已定位的证据单元”。不需要引入新的运行时、Provider 系统或 grounding 平台。

| 候选 | 官方依据与许可证 | 维护/适配判断 | 决策 |
| --- | --- | --- | --- |
| NovelRipple 现有 Provider、Source offset/hash 与一次 repair | 当前仓库事实源；仓库现有实现 | 已覆盖 Generation Run、Zod、领域校验、SourceReference 和 fail-closed；差距仅为一个显式 output mode 与 candidate evidence 协议 | **采用并最小扩展** |
| DeepSeek JSON Output | [官方 JSON Output](https://api-docs.deepseek.com/guides/json_mode)、[官方 Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion)；这是远端 API 协议，不复制代码，软件许可证不适用 | 官方要求 `response_format={"type":"json_object"}`、Prompt 包含 JSON 指令和格式示例；只能保证合法 JSON，不能代替本地 Schema 校验 | **采用官方 wire protocol**；不加 SDK、不做自动探测 |
| OpenAI Structured Outputs / JSON mode | [官方 Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create)；现有 `openai` npm SDK 来自 [openai/openai-node](https://github.com/openai/openai-node)，Apache-2.0 | 官方明确区分 `json_schema` 与 `json_object`；现有 SDK 已能发送两种 wire shape | **保留 `json_schema`，新增 `json_object`**；不新增依赖 |
| Google LangExtract | [google/langextract](https://github.com/google/langextract)，Apache-2.0；官方仓库仍有活跃 Issue/PR 与发布 | precise source grounding 方法相关，但它是 Python 库，并带来另一套 provider、分段、multi-pass、存储/可视化概念；超出本 Issue | **仅借鉴“模型输出引用、服务端定位、未定位即拒绝”方法**；不复制代码、不引入依赖 |

结论：新增依赖为 **none**。最小总复杂度方案是在现有单一 Provider 和 Story Map pipeline 内增加显式模式，并以一个纯派生 TypeScript 模块拥有 Evidence Unit 规则。

隐私影响不变：真实正文仍只发送到用户明确配置的 Provider；Unit ID 不包含正文，但 Source Packet 中的 Unit `text` 是生成所需正文。正文、Unit text、raw output、密钥和校验错误细节不得进入公开日志或报告。

## 方案选择

考虑过三种 Unit ID：

1. Source-scoped ordinal；
2. 内容 Hash + ordinal；
3. Section ID + paragraph ordinal。

采用用户确认的方案 1：

```text
evidence_unit:<sourceId>:000001
```

Source ID 提供跨 Source 隔离，六位全局 ordinal 按 Source 内位置提供简单稳定顺序。Source 创建后不可变，因此对同一 Source 重复派生得到相同 ID。内容 Hash ID 会增加长度和认知成本；仅 Section-scoped ID 会在不同 Source 间碰撞，无法证明 Unit 属于当前 Source。

## 数据结构与派生规则

Evidence Unit 是运行时派生值，不进入数据库：

```ts
type EvidenceUnit = {
  id: string;
  sourceId: string;
  sectionId: string;
  start: number;
  end: number;
  text: string;
};
```

派生算法只有一个所有者：

1. 按 SourceSection 的 Source offset 顺序遍历；
2. 每个 Section 内按空行边界 `\n[ \t]*\n+` 分成自然段候选；
3. 去掉候选首尾空白，跳过空候选；中间字符保持与 `normalizedText` 完全相同；
4. `start` / `end` 使用现有 UTF-16 offset，并且范围必须完整位于当前 Section；
5. `text = normalizedText.slice(start, end)`；
6. 按全 Source 顺序从 1 分配六位 ordinal；
7. 同一 Source 派生结果必须无重复 ID、无重叠范围，且每个 Unit 非空。

Markdown 标题若与正文之间没有空行，会与该自然段处于同一 Unit；本 Issue 不增加 Markdown 语法分词器。纯文本导入时现有 SourceSection 已按自然段划分，通常一个 Section 对应一个 Unit。

## Source Packet 与 Candidate 合同

Source Packet 保留 Section index，但以 Evidence Unit 列表替代未标注 ID 的整块 `normalized_text`：

```text
<immutable_source id="source_...">
<sections>[...]</sections>
<evidence_units>[{"id":"evidence_unit:source_...:000001","sectionId":"section_01","text":"..."}]</evidence_units>
</immutable_source>
```

Packet 不发送 Unit 的 `sourceId/start/end`，因为模型不负责计算或回传这些字段；服务端保留完整 Unit 用于解析。Unit `text` 只在请求上下文存在，不进入日志。

Candidate Event、Edge 与 Ending Candidate 统一使用：

```ts
evidenceUnitIds: string[] // min(1)，元素非空
```

原 `EvidenceClaim { sectionId, exactQuote }` 从 Story Map model candidate 契约删除。最终 Event、Edge 与 Ending Candidate 的字段仍为现有 `evidence: SourceReference[]`，`StoryMapContentSchema`、`StoryMapSchema`、Artifact 数据和数据库完全不改。

## 确定性 Evidence resolution

服务端以当前 Source 派生的 `Map<EvidenceUnit.id, EvidenceUnit>` 解析每组 `evidenceUnitIds`：

- 未知 ID：拒绝整个 Candidate；
- 另一个 Source 的合法 Unit ID：因不在当前 Source map 中而拒绝；
- 同一组内重复 ID：拒绝，不静默去重；
- 空数组或错误类型：由 Zod 拒绝；
- 合法 ID：生成 `sourceId / sectionId / start / end / excerptHash`，Hash 使用现有 `sha256(unit.text)`；
- 生成后继续执行现有 `StoryMapContentSchema` 与 `validateStoryMap`，不跳过任何 offset/hash、participant、Edge、Ending Candidate 或 sequence 规则。

不解析模型文本、不做 fuzzy match、不搜索最相似段落、不合并相邻 Unit，也不做任何 coercion。特别是 `stateChanges: string` 继续由 Zod 拒绝，不能本地转换成数组。

## Structured Output mode

`StructuredOutputMode` 明确包含：

```text
json_schema | json_object | prompt_json
```

三种模式均由配置显式选择：

- `json_schema`：保持现有 `{type:"json_schema", json_schema:{name,strict:true,schema}}`；
- `json_object`：发送且只发送 `{type:"json_object"}`；system prompt 仍包含 JSON Schema 与“只返回一个 JSON value”约束；
- `prompt_json`：保持现有不发送 `response_format` 的行为，用于明确选择该模式的其他端点。

不存在 Provider 名称分支、capability detection、自动 fallback 或失败后换模式。DeepSeek 本次 `.env.local` 和 baseline 使用 `json_object`；`.env.local` 仍被 Git 忽略。

## Prompt 版本与格式示例

新增并切换至：

- `story-map.v2`；
- `story-map-reconcile.v2`。

v1 文件保留为历史 Prompt 版本，不覆盖。两个 v2 Prompt 都必须：

- 明确只能从当前 Source Packet 复制 `evidenceUnitIds`；
- 明确 `participants` 和 `stateChanges` 始终是数组；没有状态变化时输出 `[]`；
- 明确 Event、Edge、Ending Candidate 的 Evidence 使用一个或多个 Unit ID；
- 给出不含真实作品信息的最小格式示例；示例 ID 和文本只展示 JSON shape，并显著说明不得复制示例值；
- 不包含 benchmark Gold、真实作品标题、人物、事件、Ending Candidate 或 divergence。

Prompt 变更必须由本次真实 A/B/C Eval 结果验证；确定性夹具只能验证协议，不能代替 M1 baseline。

## Pipeline 与失败语义

生产路径仍是现有统一顺序：

```text
Source
→ derive Evidence Units
→ Extractor
→ Reconciler
→ resolve Unit IDs
→ deterministic validation
→ draft Story Map Artifact
```

仍是全书 Extractor + 全书 Reconciler，不实现 section-first。Extractor 或 Reconciler 首轮校验失败时只允许一次完整响应 repair；repair 后仍失败则 Generation Run 标记 failed，不创建半成品 Artifact。既有 Artifact、Source 和 Worldline 不修改。

## Baseline 可观测性

脱敏 `metrics.json` 在现有 provider/model/prompt/tokens/duration/call 信息外，必须能直接记录：

- `structuredOutputMode`；
- Extractor / Reconciler 各自的 `firstPassValidation`：`passed`、`failed`、`not_run` 或 Provider 在取得候选前失败时的 `not_observed`；这里的 validation 与生产放行门一致，同时包含 Zod Schema 与该阶段配置的确定性校验；
- 每阶段 `repair` 是 `not_needed`、`succeeded`、`failed` 或阶段 `not_run`；
- Evidence validity；
- Story Map Artifact 是否创建；
- 后续人工复核目标位置。

这些字段从 Provider observations、Generation Run 状态和已创建 Artifact 确定性派生。报告不保存正文、标题、人物名、摘录、raw output 或详细 Provider error。每次重跑创建新的 run-id，不覆盖 M1-02 已有失败运行。

## 测试设计

TDD 按以下行为逐项红绿实现：

1. `json_object` 实际发送 `response_format:{type:"json_object"}`；
2. `json_schema` wire shape 不回归；`prompt_json` 仍无 `response_format`；未知模式拒绝；
3. runtime config 接受 `json_object`，baseline 不做 fallback；
4. Evidence Unit 的段落边界、跨 Section 顺序、UTF-16 offset、text 与 Hash 正确；
5. 同一 Source 重复派生 ID 稳定；其他 Source ID、未知 ID、重复 ID fail closed；
6. Candidate 只携带 Unit ID，不需要逐字重抄 Source；
7. `stateChanges:string` 与 `participants:string` 继续被 Zod 拒绝；
8. Extractor / Reconciler 一次 repair 预算不变，repair 失败不创建 Artifact；
9. Prompt 版本与 Source Packet 中 Unit ID 可见，旧 exactQuote candidate 路径不再被生产调用；
10. baseline 报告记录首轮/repair、Evidence、Artifact、tokens、duration 且保持脱敏；
11. M0 fixture、Story Map revision、Ripple、Worldline、Continuation 和全量 E2E 不回归。

实现完成后运行：

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm test
npm run build
CI=1 npm run test:e2e
```

随后将 `.env.local` 明确设为 `OPENAI_STRUCTURED_OUTPUT_MODE=json_object`，用冻结的三份 private manifest 和同一 `deepseek-chat` 执行一次新 baseline。只有三篇都创建可验证 Story Map Artifact、Evidence validity 为 100%，并进入 `awaiting_human_review`，M1-02A 才标记 PASS。Story Map 召回等 Gold/人工质量指标仍属于恢复后的 M1-02 baseline 决策，不在 M1-02A 内偷换结论。

## 交付与停止条件

- **M1-02A PASS**：协议、Evidence Unit、测试和三篇真实运行均满足上述兼容性门，明确可以继续 M1-02 baseline；
- **M1-02A FAIL**：任一确定性门禁失败，或任一真实作品没有有效 Artifact / Evidence validity 100% / 人工复核目标；停止并报告脱敏根因。

无论 PASS/FAIL，完成后都停止，不进入 M1-03。
