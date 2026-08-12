# M1-02 Real Story baseline（FAIL）

> 本报告严格脱敏，只使用 Story A / B / C、稳定 ID、计数和比例。它不包含私人作品标题、人物名、事件摘要、原文摘录、Source 正文、完整 Prompt、raw model output、密钥、截图或录屏。

## Run identity

- 自动 baseline Commit SHA：`37aeb6b52192a27b66537682eba14313d6ecfd70`
- Run ID：`20260812085148247-37aeb6b-5e79e596`
- Provider / model：`openai-compatible / deepseek-chat`
- Structured Output mode：`json_object`
- Prompt versions：`story-map.v2`、`story-map-reconcile.v2`
- 本地脱敏指标：`.data/evals/m1-baseline/20260812085148247-37aeb6b-5e79e596/metrics.json`
- 本地人工复核数据库：同目录 `eval.db`
- 新 runtime dependency：`none`

M1-02A 已证明 Provider 与 Evidence Grounding 兼容；本报告继续评估冻结 Story A / B / C 的实际 Story Map 质量、修正成本、First Ripple 和架构决策门。Gold 字段只用于生成后的评分与人工队列，没有发送给模型。

## Automatic Story Map result

| 指标 | Story A | Story B | Story C | 门槛 |
| --- | ---: | ---: | ---: | ---: |
| 核心人物召回 | 5 / 5（100%） | 9 / 10（90%） | 6 / 6（100%） | 每篇 100% |
| 人物 identity precision | 7 / 7（100%） | 9 / 9（100%） | 8 / 9（88.9%） | 聚合判断 |
| 人物 identity recall | 7 / 8（87.5%） | 9 / 13（69.2%） | 8 / 9（88.9%） | 聚合判断 |
| 人物 identity F1 | 93.3% | 81.8% | 88.9% | 聚合 ≥90% |
| Evidence validity | 45 / 45（100%） | 52 / 52（100%） | 43 / 43（100%） | 每篇 100% |
| 无有效 Evidence Event | 0 | 0 | 0 | 0 |
| Event Gold / Candidate | 10 / 13 | 11 / 14 | 12 / 15 | 人工一对一匹配 |
| Edge Candidate | 10 | 12 | 11 | 人工认可 ≥75% |
| Ending Gold / Candidate | 3 / 1 | 3 / 2 | 4 / 2 | 每篇召回 100% |

三篇人物 identity 聚合计数为 24 个 exact match、30 个 Gold、25 个 Candidate：micro precision 为 96.0%，micro recall 为 80.0%，micro-F1 为 87.3%，未达到 90%。Story B 的核心人物召回为 90%，未达到单篇 100%。

Ending Candidate 采用一对一人工匹配。即使每个 Candidate 都命中不同 Gold，单篇召回上限仍分别只有 A 33.3%、B 66.7%、C 50.0%，因此三篇均不可能达到 100% 门槛。不得通过删除 Gold、让一个 Candidate 重复命中多个 Gold 或修改 Benchmark 来提高结果。

用户人工浏览后表示 Candidate 整体“没有问题”，但没有提交 Event / Edge / Ending 的 Gold ↔ Candidate 稳定 ID 一对一记录，也没有主动操作时间。因此关键 Event recall、主要因果 Edge 认可率和实际 review time 保持 `not scored`，不能用口头整体认可替代精确门禁。

## Correction cost and immutable review

- Story A / B / C 均创建了独立 v2 `confirmed` Story Map revision；原 v1 AI Candidate 和 Source 均保留。
- 三篇 committed material revision：0；一次基于旧 Story A v1 的修改请求被版本门拒绝，没有留下半成品 Artifact。
- 当前 Review UI 只能修改 Event 标题、摘要和 participants，删除 Edge，确认 Evidence；不能新增 / 删除 Event，不能修正 / merge / split Character，不能修改 Evidence 范围或 Ending Candidate。
- Story B 至少存在自动核心人物漏检，三篇均存在 Ending Candidate 数量不足，但现有 UI 无法低成本完成这些必要修正。
- 用户未能理解 strict/open、分叉点选择、Preview 接受和 Continuation 的完成条件，需要开发者逐步解释；review time 未可靠计时，`是否必须打开 Source / 数据库 / Prompt 才能修正` 不能标记为 no。

因此人工修正成本门不能通过。确认操作本身证明 revision 不可变合同有效，但不能抵消缺失的修正能力和测量数据。

## Ripple / Worldline / Continuation audit

正式 `eval.db` 的只读结构审计结果：

| Story | strict Candidate | open Candidate | accepted Impact Plan | active Worldline | Directions Artifact | Scene Artifact |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 0 | 0 | 0 | 0 | 0 | 0 |
| B | 0 | 0 | 0 | 0 | 0 | 0 |
| C | 0 | 0 | 0 | 0 | 0 | 0 |

数据库中没有 `impact_plan`、Ripple / Continuation Generation Run、Worldline 或 Continuation Artifact。用户曾表示“已完成”，但随后说明自己点击了很多且不知道目标；数据库事实优先，因此不得记录 Ripple、Anchor、pre-divergence、Continuation 或“愿意继续阅读”为 PASS。

这次观察构成真实的 Review / First Ripple 可用性失败：界面没有让用户清楚知道应选择哪个分叉点、strict 与 open 的用户结果区别、哪些步骤必须接受，以及何时完成一个场景。用户没有在无需开发者代操作的情况下完成 First Ripple。

## Failure diagnosis A—K

- A. extraction coverage：Story B 自动核心人物漏检；三篇 Ending Candidate 数量均低于 Gold，Story Map 门禁失败。
- B. character identity：聚合 micro-F1 87.3%，低于 90%；Story B 核心人物召回 90%。
- C. evidence grounding：140 / 140 SourceReference 有效，PASS。
- D. chronology：未提交稳定 ID 人工判断，not scored。
- E. causal edges：未提交 Gold ↔ Candidate 人工映射，not scored。
- F. ending candidates：单篇召回上限为 33.3% / 66.7% / 50.0%，硬失败。
- G. review UX：用户不知道要完成什么；必要 Character / Event / Evidence / Ending 修正能力缺失；First Ripple 未完成。
- H. Ripple quality：0 个 strict、0 个 open Candidate，not evaluated。
- I. Continuation quality：0 个 Scene Artifact，not evaluated。
- J. performance/context window：Story Map 单篇 wall-clock 为 58,283 / 68,359 / 78,803 ms；总 token 为 94,356 / 196,230 / 175,403。未发生 context-window 或 Provider call failure，但全书双阶段成本已记录。
- K. provider/schema compatibility：三篇均在 `json_object` 与限定一次 repair 内创建 Story Map Artifact；M1-02A PASS。部分阶段首轮 Schema 失败后 repair 成功。

## Privacy observation

人工审阅最初错误地使用 Next development server；一次 Server Action 的私人 Candidate 字段被框架开发日志打印到本机任务终端。发现后立即停止 development server，未将内容提交到 Git、公开报告、截图或 CI，并改用 production server。该事件不包含密钥，也没有改变 Source / Artifact，但说明真实作品评测不得在会序列化 Action 参数的开发日志环境中进行。公开报告不复述该字段。

## Architecture decision gate

M1-03 section-first 的推荐条件已经出现：

1. Story B 存在核心人物漏检；
2. Story B 是 27k 字作品，人物 identity recall 明显低于 A；
3. 三篇 Ending Candidate coverage 均显著不足；
4. 当前全书 Extractor + Reconciler 单篇总 token 最高达到 196,230，成本需要被后续基线比较。

这些数据支持“当前全书管线不足，需要评估统一 section-first extraction”，但本次 M1-02 本身没有完成规定的人工一对一评分、strict/open Ripple 和 Continuation，因此不能伪装成 `M1-02 PASS — SECTION-FIRST REQUIRED`。M1-03 在当前结果下仍不得自动开始；应先由新的明确 Issue 接受本报告中的失败范围和隐私 / UX 前置条件。

## Deterministic gates

- `npm run lint`：PASS
- `npm run typecheck`：PASS
- `npm run test:unit`：24 files / 156 tests PASS
- `npm run test:contract`：1 file / 4 tests PASS
- `npm test`：25 files / 160 tests PASS
- `npm run build`：PASS
- `CI=1 npm run test:e2e`：7 tests PASS

## Final result

**M1-02 FAIL**
