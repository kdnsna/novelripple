# M1-04 Guided Review 真实候选回归（FAIL）

日期：2026-08-13  
实现与派生指标 commit：`afd432b5477a9af6c4f32e09903041f7fc4a28be`  
本地 run-id：`20260813-afd432b`  
原始指标：`.data/evals/m1-review/20260813-afd432b/metrics.json`（Git ignored，不公开）

> 隐私边界：本报告只使用 Story A/B/C、结构计数与门禁状态；不包含私人作品标题、人物名、Event 内容、Evidence 摘录、Source 正文、路径、截图、Prompt、raw model output 或密钥。评测数据库是 M1-02 正式 baseline 数据库的新本地副本，旧 run、Source 和 Artifact 均未修改。

## 结论

M1-04 的确定性产品能力已经实现并通过公开原创 fixture 的领域与浏览器回归，但本 Issue 规定的三篇真实作品 correction-cost gate 没有取得有效人工观察数据：主动 review time、material revision count 和 manual Event additions 都仍为 `null`。

此前对旧界面的操作没有可靠计时，且操作者明确表示“不知道要做什么”。这些点击不能追认成有效 Guided Review 观察，也不能用自动派生队列或开发者测试代替语义核对。因此本报告必须保持：

**M1-04 FAIL**

这不是生成管线或 Artifact 完整性失败；它表示“真实用户是否能在门槛时间内把三篇 Story Map 核对可信”尚无合格数据。不能进入下一 Issue，也不能用缺失值宣称 correction-cost PASS。

## 实际产品合同

- Review Queue 是 `Source + StoryMapArtifact + review metadata + validator` 的纯派生视图，不新增表或事实源；
- 优先级覆盖 inference、低置信度 Event/Edge、多别名人物、确定性 identity collision、Ending Candidate、高杠杆分叉、重要 Evidence 与软 advisory；没有总分；
- Readiness 明确显示 Event Evidence、核心人物、Ending、非法引用、悬空 Edge、重要 Evidence 与 Ripple 放行状态；服务端在最新 revision 上重新计算；
- rename / aliases / role / merge、Event update/delete/evidenced add/reorder、participant reassign、Edge add/update/delete/evidence confirmation 全部创建不可变 revision；
- Character / Event 变化使受影响确认失效；Event 删除级联 incident Edge 与 Ending；任何失败不保存半成品；
- 每个 revision 在既有 `review_json` 中只记录一个 `correction type / timestamp / Story Map version`；revision 链可确定性汇总 material correction 与 Event addition，不建立分析平台；
- Character split 未实现，因为 M1-02 没有确认哪一篇存在真实 split correction；“能力曾缺失”不等于已有真实需求证据。

## 私人三篇派生回归

三篇都从 M1-02 正式 baseline 的初始 candidate Artifact 派生；Golden 没有进入生成或 Review Queue。`待核队列项`可能由同一次人物确认同时解决多个 alias / identity 提示，因此它不是点击次数；`最少必要确认操作`只计 readiness 所需的核心人物、Ending 与重要 Evidence 确认，不包含任何尚待人工判断的 material correction。

| Story | Event | Character | Edge | Ending | 待核队列项 | 折叠 advisory | 最少必要确认操作 | 人工 review time | material revisions | 新增 Event |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| Story A | 13 | 7 | 10 | 1 | 7 | 14 | 7 | 未测量 | 未测量 | 未测量 |
| Story B | 14 | 9 | 12 | 2 | 13 | 26 | 9 | 未测量 | 未测量 | 未测量 |
| Story C | 15 | 9 | 11 | 2 | 17 | 29 | 11 | 未测量 | 未测量 | 未测量 |

Story A/B 没有 inference / 低置信度 Evidence blocker；Story C 有 5 处重要 Evidence 需要显式核对。高杠杆建议、Ending 自身确认和结构合法但未确认的 Edge 不再强迫用户重复逐条确认 Evidence，避免再次出现“点了很多但不知道目的”的机械操作；它们仍保留为可解释队列或折叠 advisory。

## Correction-cost gate

| 门禁 | 本次结果 |
| --- | --- |
| 不超过 30k 字 median review time `<= 15 min` | **Story A 7 分钟达标；B/C 未测量 / FAIL** |
| 每篇 material revisions `<= 6` | **Story A 16 次超限（全部集中于 edge_01）；B/C 未测量 / FAIL** |
| 每篇人工新增关键 Event `<= 2` | **Story A 0 个达标；B/C 未测量 / FAIL** |
| 30k—60k 优先核对队列 | 已实现；本轮对应作品规模仍须正式计时 |
| 无需源码 / 数据库 / Prompt 完成修正 | 公开 E2E 证明能力完整；私人作品 A 已有独立观察结论，B/C 尚无 |

下一次有效观察必须由读者从初始 candidate 开始，用秒表记录主动操作时间，并只在其理解后记录必要语义修正。等待、休息和环境故障不计时；开发者不得代操作或事后猜数。

## 真人计时观察（2026-08-13，部分完成）

- Story A：主动耗时 **7 分钟**；material revisions **16 次**；新增 Event **0 个**。16 次 material revision 全部集中在一条边（edge_01）：类型在 foreshadows / enables 之间翻转 3 次、证据片段前后尝试了 7 段不同原文后才定稿。时长与新增事件两项达标，material revisions 超出每篇 ≤6 的上限。
- Story B / C：观察者跳过，未测量。
- 真实发现（观察者实际操作，非推导）：修正"一条边的类型 + 证据"的实际操作成本显著——为一条边反复挑选证据片段 7 次才满意。这是 correction-cost 之外的交互成本信号，列为 M1-06 前的待改进观察点（证据选择器的候选排序 / 预览便利性）。
- 由于 B/C 未测量，correction-cost gate 仍不能得出完整结论；A 篇实测数据如实记录如上。

## Open-source preflight

检索日期：2026-08-13。只核对官方来源与许可证，未复制候选代码。

| 候选 | 官方来源 | 许可证 | 决策 |
| --- | --- | --- | --- |
| xyflow / React Flow | [xyflow/xyflow](https://github.com/xyflow/xyflow)、[官方无障碍文档](https://reactflow.dev/learn/advanced-use/accessibility) | MIT | 复用仓库已有 `@xyflow/react@12.11.2`，只保留为次级图视图 |
| dnd-kit | [clauderic/dnd-kit](https://github.com/clauderic/dnd-kit) | MIT | 不引入；上移/下移已满足可访问的最小顺序修正，避免拖拽状态与依赖 |
| React Hook Form | [react-hook-form/react-hook-form](https://github.com/react-hook-form/react-hook-form) | MIT | 不引入；现有 React、原生表单、Server Action 与 Zod 已覆盖小表单 |
| NovelRipple 现有 revision / Evidence Unit / validator | 当前仓库事实源 | 仓库自身 | 采用并最小扩展；不新增数据库、Provider、Artifact 或 Eval 系统 |

新增依赖：**none**。没有新增 Python、Promptfoo、BookNLP、Ink、RAG、向量/图数据库、多 Agent、模型路由或后台队列。Prompt 与生产 Story Map generation pipeline 未修改。

## 验证状态

实现阶段已完成：

- 领域与公开 fixture 单元集合：26 files / 173 tests PASS；
- Guided Review 聚焦 E2E：2 tests PASS，覆盖默认队列、完整图次级入口、Character merge、Event add with Evidence/delete/reorder、Edge add/change/delete、确认失效、stale revision、final confirmed 与 refresh recovery。

最终全仓库七项确定性门禁结果：

- `npm run lint`：PASS；
- `npm run typecheck`：PASS；
- `npm run test:unit`：25 files / 169 tests PASS；
- `npm run test:contract`：1 file / 4 tests PASS；
- `npm test`：26 files / 173 tests PASS；
- `npm run build`：PASS；
- `CI=1 npm run test:e2e`：8 tests PASS。

确定性门禁全部通过不替代真人 correction-cost 数据；2026-08-13 已完成 Story A 真人计时观察（B/C 未测量，A 的 material revisions 超限且暴露证据选择交互成本），本报告仍保持 `M1-04 FAIL`。
