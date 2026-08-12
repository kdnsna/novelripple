# M1 — Real Story 人工评测报告模板

> 严格脱敏：不得粘贴 Source 正文、私人作品标题、人物真名、完整 Prompt、密钥、raw model output、截图、录屏或可恢复正文的长摘要。私人运行的完整 manifest 与本地报告只保存在 `benchmarks/private/` 或 `.data/evals/`；提交到 Git 的报告必须只含稳定 ID、指标、评分和简短理由。

## Story identity

- Story ID：
- Story class：A / B / C
- Visibility：public / private
- Public title（private 填 `redacted`）：
- Rights category：original / public-domain / licensed-public / private
- Rights verification：PASS / FAIL
- Character count：
- Unseen by Prompt authors：yes / no

## Run identity

- Commit SHA：
- Provider / model：
- Structured Output mode：
- Story Map Extractor Prompt version：
- Story Map Reconciler Prompt version：
- Impact Plan Prompt version：
- Continuation Directions Prompt version：
- Continuation Scene Prompt version：
- 自动报告路径（不得提交私人路径细节）：
- 运行时间：

## Story Map extraction metrics

| 指标 | 分子 / 分母 | 结果 | 门槛 | PASS / FAIL |
| --- | --- | --- | --- | --- |
| 核心人物召回 |  |  | 100% |  |
| 总体人物身份 precision |  |  | 记录 |  |
| 总体人物身份 recall |  |  | 记录 |  |
| 总体人物身份 F1 |  |  | 聚合 ≥ 90% |  |
| 关键事件召回 |  |  | 单篇 ≥ 85% |  |
| Evidence validity |  |  | 100% |  |
| 无 Evidence 关键事件 |  |  | 0 |  |
| 核心人物错误 merge |  |  | 0 |  |
| Ending Candidate 召回 |  |  | 100% |  |
| 主要因果 Edge 人工认可 |  |  | ≥ 75% |  |

- 错误 merge 或未匹配项的稳定 ID 与简短理由：
- 不能自动评分、需人工解释的稳定 ID 与简短理由：

## Correction cost

- Size bucket：≤30k / 30k—60k
- Active review time：
- Review time gate：≤15 min / target ≤25 min
- 等待 / 故障时间（不计入 review time）：
- Material revisions（≤30k 门槛 ≤6）：
- 人工新增关键 Event（≤30k 门槛 ≤2）：
- update_event 次数：
- Character correction 次数：
- merge / split 需求次数：
- 删除 Event 数：
- 新增遗漏 Event 数：
- Edge correction 数：
- Evidence correction 数：
- Ending Candidate correction 数：
- 是否必须打开 Source / 数据库 / Prompt 才能完成修正：yes / no；打开项：
- 产品能力缺失导致无法低成本修正：yes / no；稳定 ID 与简短理由：
- 优先核对队列是否覆盖高风险项：PASS / FAIL / not-applicable
- 最高成本的修正类别与简短理由：
- 确认产生新 revision 且旧 Artifact 未变：PASS / FAIL

## Failure diagnosis

只记录观测到的失败及稳定 ID，不在 baseline 报告中直接设计解决方案。每项填写 `none` / count / 简短脱敏证据：

- A. extraction coverage：
- B. character identity：
- C. evidence grounding：
- D. chronology：
- E. causal edges：
- F. ending candidates：
- G. review UX：
- H. Ripple quality：
- I. Continuation quality：
- J. performance/context window：
- K. provider/schema compatibility：

## Ripple quality

每篇至少填写一个 strict 和一个 open case；反馈重新推演时新增一行，不覆盖原行。

| Divergence ID | Mode | 来源（suggested / user） | Direct impacts 认可（≥85%） | Anchor 正确 | Pre-divergence mutation | Feedback 后新 candidate | PASS / FAIL |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  | strict |  |  |  | 0 |  |  |
|  | open |  |  |  | 0 |  |  |

- 3 个 Ripple Suggestions 中有价值的数量：
- 无价值 Suggestion 的稳定 ID 与简短理由：
- 原 Impact Plan candidate 与旧 revision 均未被覆盖：PASS / FAIL

## Continuation quality

- Worldline ID：
- Scene Artifact ID：
- 硬事实冲突：
- 恢复 deleted fact：
- Pre-divergence rewrite：
- Strict Anchor violation：
- Worldline consistency（1—5）：
- Narrative continuity（1—5）：
- 愿意继续阅读：yes / no
- 评分理由（不得复述正文）：
- Source、父/兄弟 Worldline 与旧 Artifact 均未变化：PASS / FAIL

## M1 aggregate summary

只在 Story A、B、C 都完成后填写；不得用聚合结果覆盖任何单篇硬失败。

- Story A / B / C：PASS / FAIL；PASS / FAIL；PASS / FAIL
- 三篇总体人物身份 F1（门槛 ≥90%）：
- 三篇关键事件聚合召回（门槛 ≥90%）：
- 愿意继续阅读的作品数（门槛 ≥2/3）：
- 独立用户观察次数（门槛 ≥3）：
- 不同非开发参与者人数（门槛 ≥2）：

## User observation

每次观察使用匿名参与者 ID；不要记录姓名、联系方式、录屏或原始访谈逐字稿。

| Session ID | Participant type | Story ID | 无代操作完成 First Ripple | Active time | 阻塞点分类 | 脱敏观察 |
| --- | --- | --- | --- | --- | --- | --- |
|  | non-developer / developer |  | yes / no |  |  |  |

## Privacy and immutability audit

- 报告不含 Source 正文或可恢复正文：PASS / FAIL
- 报告不含完整 Prompt、密钥或 raw output：PASS / FAIL
- 私人作品未进入 Git、CI、日志或截图：PASS / FAIL / not-applicable
- 所有 AI 输出先作为 candidate：PASS / FAIL
- 所有用户修正创建不可变 revision：PASS / FAIL
- 旧 Source、Artifact、Worldline 未被覆盖：PASS / FAIL

## Final result

- Story result：PASS / FAIL
- M1 aggregate result（只在三篇完成后填写）：PASS / FAIL / not-applicable
- Reviewer ID：
- Review time：
- FAIL 的硬门禁或相对上次退化项：
