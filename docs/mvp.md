# M1 — Real Story

## 阶段状态

> **2026-10-17 更新（Phase 0）**：M1-07 聚合评测曾判 FAIL 并按旧规则停止开发。现在评测改为**质量仪表盘**：四条硬规则（原文不被覆盖、证据可溯源、世界线隔离、坏输出被拒绝）和默认 CI 继续阻塞，召回率、修正成本、人工评分和真人观察只作为质量目标记录、不阻塞。真人观察可选，作者自评有效。见 [`0005`](decisions/0005-eval-dashboard-not-gate.md)。P0 的 Story Map 召回修复、场景节点树与分段上下文组装已经落地（Continuation 见 [`0007`](decisions/0007-scene-node-tree-and-context-assembly.md)）；下一步进入读者优先流程。

`v0.1.0` 是已冻结的 **M0 — First Ripple** 基线；M0 的正式封版状态见 [`M0 封版报告`](evals/runs/2026-08-12-v0.1.0-m0-release-pass.md)，历史合同以该 tag 为准。当前 `main` 的开发合同是 **M1 — Real Story**，目标发布版本为 `v0.2.0`。M1 在现有 M0 闭环上验证真实作品，不重写 Source、Artifact、Worldline 或已有领域不变量。

## 用户结果

用户可以导入一篇权利清晰、非专门为 NovelRipple 编写的真实中短篇，在不需要理解 Prompt、Schema、Agent 或数据库的情况下完成：

```text
导入作品
→ 系统理解真实故事
→ 直接开始涟漪（默认；不要求先做 Guided Review）
→ 从 3 个“值得改变的瞬间”中选一个，或自己从时间线上选一个事件
→ 选择“保留原结局”或“让故事自由发展”
→ 查看 Ripple 影响预览
→ 必要时反馈并重新推演
→ 创建 Worldline
→ 阅读一个值得继续的新场景
```

读者优先是默认路径：生成 candidate Story Map 后，用户可以一键快速确认并立即看到 3 个推荐分叉点。“核对、改人物、改边、补证据”保留为可选的**精修模式**；低置信度节点和结局用“待核对”角标提示，未精修不会阻止进入 Ripple，但会记录在不可变 revision 的 operation 中。普通确认（`confirm_story_map`）仍要求 readiness 通过。严格 / 开放模式的内部枚举不变，读者界面分别显示为“保留原结局”和“让故事自由发展”。

所有 AI 输出仍先作为 candidate；人工修正、确认和反馈必须创建不可变 revision，旧 Source、Artifact 与 Worldline 不得被覆盖。

## M1 要回答的问题

1. 真实作品理解是否可靠；
2. 人工修正成本是否足够低；
3. 新世界线是否值得继续阅读。

M1 的成功不是“能跑一次 Prompt”，而是三类真实作品在 [`docs/evals.md`](evals.md) 的质量仪表盘上持续改进、四条硬规则零违反，并且读者能顺利完成 First Ripple。质量目标用来决定优先级，不是停止开发的门禁。

## 最小验收场景

对 [`benchmarks/m1/`](../benchmarks/m1/) 中的 Story A、B、C 分别执行：

1. 核对权利、字符数、未见作品声明和脱敏边界；
2. 导入作品并生成 candidate Story Map；
3. （可选）通过 Guided Review 精修人物身份、关键事件、Evidence、主要 Edge 与 Ending Candidate；
4. 直接快速确认 candidate Story Map 进入 Ripple；或只做最小必要修正后走普通确认，新的 Story Map revision 仍不可变；
5. 从 3 个 Ripple Suggestions 中选择有价值的分叉点，或由用户从时间线指定分叉点；
6. 对每篇至少运行一个“保留原结局”（strict）和一个“让故事自由发展”（open）分歧；
7. 必要时对 candidate Impact Plan 提交反馈并生成新的 candidate revision；
8. 接受一个 Impact Plan，创建隔离的 Worldline；
9. 生成并阅读一个符合 Canon、Delta 与 Anchor 的完整场景；
10. 将自动指标、人工评分（作者自评有效）、修正成本和（可选）用户观察写入脱敏 M1 质量仪表盘。

任一 Evidence、Schema、引用、分歧前历史、Anchor 或 Worldline 隔离校验失败，都必须 fail closed；不得部分采用、静默修补或覆盖旧版本。

## M1 必须完成

- 至少 3 篇真实作品 Benchmark；
- 覆盖 1 万—6 万中文字符作品；
- 验证 Story Map 对真实作品的泛化能力；
- Guided Review（可选精修模式）；
- 人物、事件与 Edge 的最小必要修正；
- Ripple Suggestions；
- Impact Plan feedback regeneration；
- 每篇至少一个真实高质量 Continuation scene；
- M1 质量仪表盘；
- 真实用户观察（可选）；
- `v0.2.0` 发布检查。

这些项目定义 M1 的交付范围，不代表 M1-01 已实现对应业务能力。每项实现必须由后续单一 Issue 承担，并由 Benchmark 数据证明必要性。

## Benchmark 合同

M1 使用三种互补作品验证，而不是用为 Prompt 量身编写的夹具替代真实泛化：

| 类型 | 规模与人物 | 必须覆盖的难点 |
| --- | --- | --- |
| **Story A：清晰线性故事** | 10k—25k 中文字符；4—6 名核心人物 | 明确冲突、转折与结局，验证基本结构召回 |
| **Story B：复杂人物和时间** | 25k—45k 中文字符；8—12 名核心人物 | 别名、称谓、回忆、时间跳跃；至少一组容易错误合并的人物 |
| **Story C：软因果与开放结局** | 15k—35k 中文字符 | 动机存在解释空间、结局开放，并包含非简单“删除事件”型分叉 |

至少一篇必须是真正未见作品：在当前 Prompt 版本冻结前，NovelRipple Prompt 作者没有读过该正文，也没有用它调试 Prompt、Schema、模型配置或阈值。Story C 的“软性 Anchor”只描述人工评测中的解释空间，不增加第二套生产 Anchor 类型或状态。

公共仓库只能保存原创、公版或明确许可公开的作品。私人作品只允许存在于被 Git 忽略的 `benchmarks/private/`，不得进入 Git、日志、截图、错误报告或 GitHub Actions。详细目录和 manifest 规则见 [`benchmarks/m1/README.md`](../benchmarks/m1/README.md)。

## Non-goals

- PDF、EPUB、DOCX；
- 百万字长篇；
- 无限续写；
- 多 Agent；
- RAG；
- 向量数据库；
- 图数据库；
- 模型路由；
- 多模型投票；
- 用户系统；
- 云同步；
- 多人协作；
- 世界线合并；
- 社交分享；
- 角色聊天；
- Prompt 编辑器；
- 插件系统；
- 复杂后台任务系统。

M1-01 还明确不修改 AI Prompt、Story Map Schema、生产 pipeline，不做 chunking、Review UI、Ripple Suggestion 或 Continuation 改造，也不新增 runtime dependency。

## `v0.2.0` 发布检查

发布 `v0.2.0` 需要：

1. 三类 Benchmark 均有权利记录、manifest 与独立脱敏报告，且至少一篇满足真正未见作品条件；
2. 附最新 M1 质量仪表盘：四条硬规则零违反；Story Map、人工修正成本、Ripple、Continuation（与可选的真实用户观察）的达标情况如实列出，未达标项不阻塞发布，但要写进发布说明；
3. M0 的 Source 不可变、candidate-first、revision 不可变、Evidence、Anchor、Worldline 隔离与 fail-closed 门禁没有退化；
4. 当前仓库的 lint、typecheck、unit、contract、完整测试、build 与 Chromium E2E 全部通过；
5. Prompt 如在后续 Issue 发生变化，必须有对应真实 M1 Eval 结果；
6. Release、日志、截图、夹具和报告均不包含私人作品正文、密钥、完整 Prompt 或 raw model output。
