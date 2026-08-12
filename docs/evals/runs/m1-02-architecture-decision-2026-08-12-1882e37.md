# M1-02 架构决策补充（SECTION-FIRST REQUIRED）

> 本报告是对 [`M1-02 Real Story baseline（FAIL）`](m1-baseline-2026-08-12-37aeb6b.md) 的后续架构决策，不覆盖或改写原始运行报告。原报告继续是产品质量、人工复核完整度和 First Ripple 可用性的事实记录。

## Decision identity

- 决策日期：2026-08-12
- 被评测生产管线 Commit SHA：`37aeb6b52192a27b66537682eba14313d6ecfd70`
- 原始 Run ID：`20260812085148247-37aeb6b-5e79e596`
- 决策接受前 main SHA：`1882e37f2de896cdeb7bad503e06a18b17635abe`
- Provider / model：`openai-compatible / deepseek-chat`
- Structured Output mode：`json_object`
- Prompt versions：`story-map.v2`、`story-map-reconcile.v2`
- 新 runtime dependency：`none`

本报告严格脱敏，不包含私人作品标题、人物名、事件摘要、原文摘录、Source 正文、完整 Prompt、raw model output、密钥、截图或录屏。

## Scope distinction

M1-02 的产品质量 baseline 仍然是 FAIL：人工一对一 Event / Edge / Ending 评分不完整，First Ripple 未完成，Ripple / Worldline / Continuation 数据为 0。这些失败不得被本决策改写为产品质量 PASS，也不得用于 `v0.2.0` 放行。

M1-02 的架构决策门目标是回答“是否需要统一 section-first extraction”。用户已明确接受现有真实失败数据作为该决策的充分证据，因此本补充只关闭架构选择，不修改 Benchmark、Gold、Prompt、Schema 或运行数据。

## Required evidence

原始 M1-02 合同规定，出现以下任一证据即可推荐 section-first：

- 任一作品关键 Event recall 低于 80%；
- 核心人物漏检；
- Evidence grounding 明显下降；
- context window failure；
- frequent timeout；
- 30k+ 作品质量明显下降；
- 当前双全书调用成本 / Token 不可接受。

正式 baseline 已得到多项独立证据：

1. Story B 核心人物召回为 9 / 10（90%），存在明确核心人物漏检，单项即触发决策门；
2. Story B 的人物 identity recall 为 69.2%，明显低于 Story A 的 87.5%；三篇 micro-F1 为 87.3%，低于 M1 的 90% 门槛；
3. Story A / B / C 的 Ending Candidate 数量相对冻结 Gold 分别为 1 / 3、2 / 3、2 / 4，coverage 在三篇均明显不足；
4. 当前全书 Extractor + Reconciler 的单篇总 token 分别为 94,356、196,230、175,403，Story B 的双全书调用成本显著增加；
5. Provider 与 Evidence Grounding 已由 M1-02A 隔离验证：三篇 Artifact 均创建，140 / 140 SourceReference 有效。因此上述 coverage 失败不能归因于 Provider wire mode 或 Evidence 定位协议。

没有发生 context-window failure 或 Provider timeout；这不抵消已经满足的核心人物漏检条件。

## Architecture consequence

后续 M1-03 只有在用户另行明确授权后才能实现。其范围必须继续遵守已定义边界：

- 建立一条统一的 `Source → Analysis Segments → local extraction → global reconcile → Evidence resolution → deterministic validation → Story Map Artifact` 路径；
- 短作品只产生一个 Segment，不保留 small / large 双轨；
- 不引入 RAG、向量数据库、图数据库、Python 服务、多 Agent 或后台队列；
- 不改变 Source immutability、最终 SourceReference、Story Map revision、Impact Plan、Worldline 或 Continuation 合同；
- 必须用同一 Story A / B / C、同一 Provider / model 和相同质量口径回归；若没有改善，不得因为已实现新架构就保留。

本决策不授权在当前任务中编码，也不授权顺带修复 Review UX、Ripple Suggestions 或 Continuation。

## Historical status

- 原始 [`M1-02 Real Story baseline（FAIL）`](m1-baseline-2026-08-12-37aeb6b.md)：保持不可变，继续代表产品质量和完整用户旅程未通过；
- 本报告：作为 M1-02 的正式架构决策结论；
- M1-03：尚未开始，等待独立明确授权。

## Verification

本次只记录架构决策，没有修改产品行为、依赖、Prompt、Schema、生产管线或数据库，因此不产生新的 Open-source preflight 选型。完成前重新运行全部确定性门禁：

- `npm run lint`：PASS
- `npm run typecheck`：PASS
- `npm run test:unit`：24 files / 156 tests PASS
- `npm run test:contract`：1 file / 4 tests PASS
- `npm test`：25 files / 160 tests PASS
- `npm run build`：PASS
- `CI=1 npm run test:e2e`：7 tests PASS

## Final architecture conclusion

**M1-02 PASS — SECTION-FIRST REQUIRED**
