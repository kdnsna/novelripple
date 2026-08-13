# M1-03 Unified Section-First Story Map Extraction
> **状态：已回滚，未进入生产。** 本方案在 M1-03 真实作品回归中三篇均失败（局部逐字 Evidence claim 一次 repair 后仍无效），已按 retention gate 于 commit `7d5226a` 整体撤销；生产管线保持已验证的 v2，Evidence Unit 模块继续被 M1-04 复用。保留本文档仅作决策记录。

日期：2026-08-12  
状态：设计已获确认，待实施  
基线 commit：`4c2114f2cfdd298133196cd860ab924d4c8f3b0d`

## 用户结果与验收场景

M1-03 只解决已经由真实 Benchmark 证明的长文 Story Map coverage 与全书调用成本问题：无论作品长短，生产系统都通过同一条 section-first 管线生成可追溯、可校验、可版本化的 Story Map candidate；短作品只是自然得到一个 Segment，不存在另一条 small-story pipeline。

最小验收场景：

1. 从不可变 Source 的现有 `SourceSection[]` 确定性派生一个或多个 `AnalysisSegment`；
2. 每个 Segment 使用同一版本 Extractor Prompt 独立提取局部人物、事件和 Edge；
3. 每条局部 Evidence 必须是当前 Segment Packet 中声明 Section 的逐字 `exactQuote`，并由服务端唯一精确定位；
4. 只有 Evidence 主体位于 Segment core 的 Event 才能被该 Segment claim；context 只帮助理解边界，不拥有事件；
5. 全部局部候选通过后，Global Reconciler 只读取局部候选、Source Section index 与已经解析的必要 Evidence reference，不再次读取整部 Source；
6. Reconciler 合并别名与重复事件，建立全局顺序和跨 Segment Edge，并生成 Ending Candidate；
7. 服务端把 Reconciler 使用的临时 Evidence reference ID 确定性映射回现有 `SourceReference[]`，再执行现有 Story Map 领域校验；
8. 只有完整候选通过后才创建一个 draft Story Map Artifact；任一 Segment 或 Reconciler 失败时保留 Generation Run，但不保存半成品 Artifact；
9. 使用冻结的 Story A/B/C 与同一 `deepseek-chat`、同一评分口径重跑 baseline；若真实质量没有改善或修正成本明显增加，撤销本架构实现并报告 M1-03 FAIL。

## 前提证据

正式 [`M1-02 架构决策补充`](../../evals/runs/m1-02-architecture-decision-2026-08-12-1882e37.md) 已给出 `M1-02 PASS — SECTION-FIRST REQUIRED`，满足本 Issue 的启动条件。触发证据包括：

- Story B 核心人物召回 9 / 10，单项即触发 section-first 决策门；
- 三篇人物 identity micro-F1 为 87.3%，低于 M1 的 90% 门槛；
- 三篇 Ending Candidate 数量都低于冻结 Gold；
- 当前全书 Extractor + 全书 Reconciler 单篇总 token 为 94,356 / 196,230 / 175,403；
- M1-02A 已隔离证明 Provider 与最终 Evidence grounding 可用，140 / 140 `SourceReference` 有效。

本设计不把 M1-02 的产品质量 FAIL 改写为 PASS，也不处理尚未完成的 Review UX、Ripple、Continuation 或真实用户观察。

## Open-source preflight

检索日期：2026-08-12。只核对官方仓库、官方源代码、官方 Release、Issue 与许可证；不使用博客或第三方摘要作为技术依据。

### Google LangExtract

- 官方仓库：[google/langextract](https://github.com/google/langextract)
- 许可证：[Apache-2.0](https://github.com/google/langextract/blob/main/LICENSE)
- 当前官方 Release：[v1.6.0](https://github.com/google/langextract/releases/tag/v1.6.0)，2026-07-02 发布；官方仓库当日约 38.3k Stars、2.7k Forks，并持续存在活跃 Release、Issue 与 Pull Request。
- 运行边界：Python 3.10+；基础安装包含 Google Provider、网络、存储、数据处理和可视化相关依赖，另有 Provider/plugin 体系。
- 长文方法：官方 README 与 `annotation.py` 展示了按字符缓冲分块、批量/并行推理、可选多次 extraction pass、前一块上下文和按字符区间处理重复结果。
- Grounding 方法：模型返回原文 extraction text，Resolver 将其对齐回 Source character interval；官方实现支持 exact、partial 与 fuzzy alignment，无法对齐的 extraction 没有 `char_interval`。
- 安全/隐私：官方 v1.3.0 将 URL fetching 改为显式 opt-in；框架仍引入另一套 Provider、文件输出与可视化边界，直接采用会扩大真实作品正文的处理面。

决定：**不引入 LangExtract、不增加 Python runtime、不复制其代码。** 只借鉴以下方法：

1. 长文先分成可独立推理的局部范围；
2. 局部推理可有限并发；
3. 相邻前文只作为上下文，不改变原始全局 offset；
4. extraction 必须回到明确 Source character interval；
5. overlap/dedupe 以已解析的位置与明确所有权为依据；
6. 多个局部 extraction 的结果在独立全局阶段统一对账。

NovelRipple 不采用以下 LangExtract 行为：

- 不按 token、句子或任意字符切割；只在已有 `SourceSection` 边界切分；
- 不进行同一 Segment 的多次召回 pass；每个 Segment 只有一次初始调用和既有的一次完整 repair；
- 不接受 partial 或 fuzzy grounding；只接受 Section 内唯一的逐字精确匹配；
- 不跳过失败 chunk；任一 Segment 失败即使整次 Story Map 失败；
- 不采用 Provider/plugin、批处理、后台任务、URL fetch、文件输出或可视化系统。

### 仓库内候选

| 候选 | 适配判断 | 决定 |
| --- | --- | --- |
| NovelRipple 现有 Source Section、Generation Run、一次 repair、Story Map Validator 与 Artifact revision | 已拥有不可变 Source、全局 offset、结构校验、失败记录和原子 Artifact 写入；只缺 Segment 派生、局部候选与全局对账装配 | **复用并最小扩展** |
| M1-02A Evidence Unit ID candidate 路径 | 对 DeepSeek 避免逐字重抄有效，但本次明确要求局部 Extract 返回 `exactQuote`，且 Global Reconciler 不应再次读取正文 | **替换生产 candidate 协议**；不保留双轨 |
| M0 v1 `exactQuote` resolver | 已验证 Section 内唯一精确匹配与 offset/hash 生成，但旧实现面向全书 candidate | **复用规则，不复制旧整条管线**；收敛为局部 Evidence 解析模块 |

新 runtime dependency：**none**。

## 唯一生产数据流

```text
Source
→ derive AnalysisSegment[]
→ local extraction（每段同一 Prompt，最多并发 2）
→ exact Evidence claim resolution + core ownership validation
→ deterministic positional dedupe
→ global reconcile（不含整部 Source）
→ temporary Evidence reference resolution
→ existing deterministic Story Map validation
→ one versioned Story Map Artifact
```

现有“全书 Extractor → 全书 Reconciler”实现被替换。不得按字符数保留旧路径，也不得增加 feature flag、自动 fallback 或兼容 shim。短 Source 通过同一 `deriveAnalysisSegments` 自然返回一个 Segment。

## AnalysisSegment

`AnalysisSegment` 是 Source 的纯派生值，不进入数据库：

```ts
type AnalysisSegment = {
  id: string;
  sourceId: string;
  sectionIds: string[];
  coreStart: number;
  coreEnd: number;
  contextStart: number;
  contextEnd: number;
};
```

唯一派生算法：

1. 按 `SourceSection.start` 排序，并拒绝越界、空范围、重叠或非递增 Section；
2. 从第一个未分配 Section 开始连续累加 core；目标为约 8,000 个 UTF-16 code units；
3. core 未达到 6,000 时继续加入下一个完整 Section；加入下一个 Section 会超过 10,000 时，若当前 core 已达到 6,000，则结束当前 Segment；
4. 单个 Section 自身超过 10,000 时仍作为一个完整 core，不把 Section 切开；这属于可观测的 oversize Segment，而不是建立任意字符切割；
5. Source 剩余不足 6,000 时，只有在与前一个 core 合并后不超过 10,000 才并入前一个 Segment，否则保留为一个较短尾段；如果整部 Source 不足 6,000，则仍返回一个 Segment；
6. Segment 的 `sectionIds` 只包含 core Section；`coreStart/coreEnd` 分别取首尾 core Section 的原始 Source offset；
7. 第一个 Segment 没有额外 context，`contextStart/coreStart` 与 `contextEnd/coreEnd` 相同；后续 Segment 最多附带紧邻的前一个 `SourceSection`，因此 `contextStart` 可早于 `coreStart`，`contextEnd` 始终等于 `coreEnd`；
8. ID 使用 Source-scoped ordinal，例如 `analysis_segment:<sourceId>:0001`；同一不可变 Source 重复派生必须完全一致。

采用“仅前一个相邻 Section”是因为局部事件的主体 Evidence 位于当前 core 时，前文最能帮助称谓、代词与跨边界前因解析，同时严格满足“最多一个相邻 Section”。

## 局部 Candidate 与 Evidence

局部 Extractor 使用 `story-map.v3`，所有 Segment 使用完全相同的 Prompt 和 Zod Schema。模型输出：

- 局部人物；
- 局部事件；
- Segment 内 Edge；
- `sectionId + exactQuote` Evidence；
- 仅在本 Segment 内有效的 `localId`，不生成正式 Character/Event/Edge ID；
- `participants` 与 `stateChanges` 始终为 `string[]`。

Source Packet 只包含：

- Segment identity；
- core 与 context 的全局边界；
- core Section ID 列表；
- 按 Source 原顺序排列的 context/core Section 文本，并明确标记 ownership；
- 不包含 Gold、其他 Segment 正文或整部 Source。

服务端对每个 Evidence claim 执行：

1. Section 必须出现在当前 Segment Packet 中；
2. `exactQuote` 必须在声明 Section 内逐字出现且只出现一次；
3. 计算得到的 `start/end` 必须保持原 Source UTF-16 offset，Hash 使用现有 `sha256`；
4. 不 trim、不改写、不做 Unicode 二次归一化、不做 fuzzy/partial/相似度 fallback；
5. 同一 evidence 数组内重复引用直接拒绝，不静默去重；
6. Event 的第一条 Evidence 是主体 Evidence，必须完整位于 `[coreStart, coreEnd)`；其余 Evidence 可以来自唯一的相邻 context Section；
7. context-only Character 可以进入局部候选以帮助 alias reconcile；context-only Event/Edge 不得被当前 Segment claim。

解析成功后，服务端为每个不同 `SourceReference` 生成仅在本次 Story Map 运行内有效的临时 Evidence reference ID。Global Reconciler 只引用这些 ID，不再复制 `exactQuote`。

## 并发与 repair

Segment 按 Source 顺序分成最多两个一组，每组使用 `Promise.all` 并发执行；上一组完成后才进入下一组。这里没有持久化队列、后台 worker、重试调度器或新的任务系统。

每个 Segment 调用现有 `generateStructured`，因此预算保持为：

- 一次 initial response；
- initial 的 Schema、Evidence 或 core ownership 校验失败时，最多一次完整 repair response；
- repair 仍失败则该 Segment Generation Run 标记 failed。

并发组中一个 Segment 失败时，同组已经发出的另一个调用允许完成并保留自己的 Generation Run；系统停止后续 Segment 和 Global Reconcile，不创建 Story Map Artifact。

## 去重与 Global Reconcile

Global Reconciler 使用 `story-map-reconcile.v3`，输入只包含：

- ordered Segment identity 与 core offset；
- 各 Segment 已通过局部校验的 Character/Event/Edge candidate；
- Source Section index，仅含 `id/title/start/end`；
- 本次局部候选实际引用的临时 Evidence reference ID 与 `sectionId/start/end`；
- 不包含 Source 正文、未引用 Evidence 文本、Gold 或历史 Artifact。

进入 Reconciler 前先执行最小确定性 dedupe：

- 同一 `SourceReference` 主体区间、相同 normalized event title 的局部 Event 只保留 Source 顺序最早者；
- 同一局部 Event pair、Edge type 与相同 Evidence reference 集合的 Edge 只保留一个；
- Character 不做基于字符串相似度的强制合并，只去除同 Segment 内相同 `localId` 的非法重复；alias identity 交给 Reconciler 判断；
- 不用 dedupe 掩盖 context-only ownership 违规，后者必须先 fail closed。

Reconciler 负责：

- 合并明确属于同一人物的姓名、别名和称谓；不确定时保留独立人物；
- 合并跨 Segment 重复事件，并把 `sequence` 重排为从 1 开始连续；
- 建立跨 Segment 的 `causes/enables/foreshadows`；
- 生成完整 Ending Candidate；
- 输出正式 Story Map candidate ID 与临时 Evidence reference ID。

Reconciler candidate 通过 Zod 后，服务端将临时 Evidence reference ID 映射为现有 `SourceReference[]`。未知、重复、未在局部阶段解析、属于其他 Source 或指向已删除 Event 的引用全部拒绝。随后继续执行现有 `StoryMapContentSchema`、`StoryMapSchema` 与 `validateStoryMap`。

## 数据与失败语义

不新增表、migration、Artifact kind 或 Provider：

- `AnalysisSegment`、局部 candidate 和临时 Evidence reference 全部只存在于当前请求内存；
- Source、Section、最终 `SourceReference`、Story Map schemaVersion、Artifact schemaVersion 与 revision 规则不变；
- 最终 Artifact 的 `generationRunId` 继续绑定 Global Reconciler Run；所有 Segment Extract Run 可通过项目 Generation Run 列表追踪；
- 任一 Segment、Evidence、Reconciler 或领域校验失败时，不保存局部 candidate、半成品 Story Map 或部分 Artifact；
- 已存在的 M0/M1-02A Story Map Artifact 无需迁移，读取和 Ripple/Worldline/Continuation 逻辑不变；
- 错误、终端摘要与公开报告只能包含 stage、Segment ID、计数与脱敏 failure code，不包含 Prompt、正文、`exactQuote` 或 raw output。

## Prompt 与 Candidate 协议替换

新增：

- `prompts/story-map.v3.md`；
- `prompts/story-map-reconcile.v3.md`。

v1/v2 Prompt 文件作为历史版本保留，但生产只调用 v3。现有 M1-02A `evidenceUnitIds` candidate schema、resolver 和生产 Source Packet 调用方被新的局部 exactQuote + 全局临时 reference ID 协议替换；没有生产调用方后删除 Evidence Unit 实现与过时测试，避免第二套 candidate evidence 系统。

Prompt 只提供合成的最小 JSON shape 示例，明确 array 类型、局部 ID、core ownership 和 Evidence 字段；不加入 Benchmark Gold 或真实作品信息。因为 Prompt 发生变化，本 Issue 必须产生新的真实 A/B/C Eval 报告。

## Baseline 可观测性

现有 `npm run eval:m1:baseline` 继续是唯一 M1 runner，不建立第二套 Eval。脱敏 JSON 增加或调整以下可确定指标：

- `analysisSegmentCount`；
- 每个 Segment 的脱敏 ID、core/context 字符数、Generation Run 状态、first-pass/repair 结果；
- Global Reconciler first-pass/repair；
- 总调用数、repair 数、input/output/total tokens 与 wall-clock；
- Story Map character/event/edge/ending counts；
- 现有 Character recall/identity、Evidence validity 与人工 Event/Edge/Ending 队列；
- Artifact 是否创建与脱敏 review target。

报告不得包含 private title、人物名、事件摘要、Section title、原文、`exactQuote`、Prompt 或 raw output。现有 M1-02 run 和报告保持不可变；M1-03 每次使用新 run-id。

## 测试设计

按测试先行逐项实现：

1. 单个 Segment：短 Source 通过同一派生器得到一个 Segment；
2. 多 Segment：只在 Section 边界切分，core 接近 6k—10k，尾段正确合并；
3. boundary Event：当前 Segment 能读取前一相邻 Section，但主体 Evidence 必须在 core；
4. overlapping context dedupe：context-only Event 被拒绝，位置相同的重复候选在 Reconcile 前只保留一个；
5. alias across segments：不同 local ID/称谓由 Reconciler 输出一个 Character；
6. cross-segment causal edge：Global Reconciler 可建立跨 Segment Edge，最终引用不悬空；
7. failure rollback：任一 Segment repair 失败时 Generation Run 保留、Reconciler 不运行、Artifact 为零；
8. Evidence offsets unchanged：含 surrogate pair 的 Source 中，最终 offset/hash 仍精确匹配原 `normalizedText`；
9. unique exactQuote：未知 Section、缺失 quote、重复 quote、重复 reference 与跨 Source ID 全部 fail closed；
10. concurrency：任意时刻最多两个 Segment provider call，并且不会建立后台队列；
11. repair：每个 Segment 和 Reconciler 都最多一次 repair；
12. one pipeline：不存在基于 Source 长度分支到旧全书实现；
13. baseline privacy/metrics：报告包含 Segment、token、duration 和 validation 状态，但不含私有内容；
14. M0 fixture、Story Map revision、Ripple、Worldline、Continuation、Live Eval 和浏览器旅程全部不回归。

## 真实 Benchmark 回归与保留条件

在全部确定性门禁通过后，用冻结 Story A/B/C、与 M1-02 相同的 `openai-compatible / deepseek-chat / json_object` 重跑生产 baseline。Gold 仍只在生成结束后评分，不进入 Prompt。

与正式 M1-02 run `20260812085148247-37aeb6b-5e79e596` 比较：

- 至少消除 Story B 核心人物漏检，或以独立人工 Event/Ending 一对一结果证明另一个真实 coverage 失败得到实质改善；
- Evidence validity 必须继续为 100%，无有效 Evidence Event 为 0；
- 三篇都必须创建完整 Story Map Artifact；
- 人物 identity micro-F1 应达到或接近 90%，并报告所有错误 merge；
- Event、Edge、Ending 仍需人工稳定 ID 复核，不用 Candidate 数量冒充 recall；
- material revision 与人工新增 Event 不得相对 M1-02 明显增加；若缺少可比较的主动 review time，必须标记 `not measured`，不得推断 PASS；
- Token 与 wall-clock 分篇报告；section-first 不要求调用更少，但必须证明 coverage 收益足以偿还新增调用，并且不出现不可接受的成本退化。

只有真实改善与不回归证据同时成立才保留实现。若三篇生成失败、Evidence 退化、coverage 没有改善或 correction cost 明显上升，则使用可追踪的 revert commit 撤销生产架构，保留脱敏失败报告，并给出 `M1-03 FAIL`。

## 非目标

本 Issue 不实现或修改：

- RAG、向量数据库、图数据库、Python、多 Agent、后台队列或模型路由；
- 任意字符/token chunking、重复 extraction pass、无限 retry 或自动 Provider fallback；
- Story Map 最终 Schema、Source/Artifact/Worldline revision model；
- Guided Review、Character/Event/Ending 编辑能力；
- Ripple Suggestions、Impact Plan feedback regeneration 或 Continuation；
- Benchmark、Gold 或 M1 门槛。

## 完成门禁

实现后必须依次运行并记录：

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm test
npm run build
CI=1 npm run test:e2e
```

然后运行新的 A/B/C baseline，完成脱敏自动指标与必要人工复核。只有上述证据支持保留架构时，最终结论才是 `M1-03 PASS`；否则为 `M1-03 FAIL`。完成后停止，不进入下一 Issue。
