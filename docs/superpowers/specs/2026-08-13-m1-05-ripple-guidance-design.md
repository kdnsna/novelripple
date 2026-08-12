# M1-05 Ripple Suggestions 与反馈重生成设计

日期：2026-08-13  
Issue：M1-05  
状态：已采用（用户授权默认选择推荐方案）

## 用户结果

confirmed Story Map 的读者不必先理解整张图：系统先给出最多三个带理由的候选分叉。读者仍可从完整图手选任意 Event。若当前 Ripple candidate 有一个关键判断不对，读者提交一条明确反馈即可得到完整重生成且重新校验的新 candidate；旧 candidate、Divergence、模式和 Anchor 保持可追踪且不可变。

## 边界

本 Issue 只实现：Ripple Suggestions、Impact Plan Preview 的领域差异视图、单条明确反馈驱动的完整 candidate 重生成与 lineage。它不做聊天、会话记忆、自动循环、预生成 Worldline、复杂 Timeline、多 Agent、RAG、向量/图数据库、模型路由或新服务。

## 方案比较与决定

1. **采用：复用 Artifact、Generation Run、Zod 与现有 Ripple 校验管线。** Suggestions 使用一个新的 `ripple_suggestions` Artifact kind；反馈重生成仍调用同一个 Impact Plan 生成函数，只增加冻结合同与 lineage。差异视图由领域对象确定性派生。该方案能覆盖完整用户路径且没有新 runtime dependency。
2. 只用确定性图排序生成建议。它能找到高下游可达节点，却不能可靠生成 `instruction`、`whyInteresting` 和人物/Anchor 风险，不满足真实作品推荐质量。
3. 引入 JSON diff 或状态机库。通用 diff 无法表达 `reasonPath`、Anchor 和 pre-divergence 语义；当前表单状态也不足以证明需要状态机。新增依赖会扩大维护面而不减少领域代码，因此拒绝。

## Open-source preflight

检索日期：2026-08-13。仅核对官方仓库、官方文档与许可证；不复制候选代码。

| 候选 | 官方来源 | 许可证 | 维护与适配结论 | 决策 |
| --- | --- | --- | --- | --- |
| OpenAI Node | https://github.com/openai/openai-node | Apache-2.0 | 官方 TypeScript SDK，支持当前 Node 22；仓库已锁定 `openai@7.4.0` 并封装 provider 边界 | 复用现有依赖与边界，不升级 |
| Zod | https://github.com/colinhacks/zod | MIT | 官方包为零依赖 Schema validator；仓库已锁定 `zod@4.4.3` | 复用现有 Schema / JSON Schema / fail-closed 验证 |
| jsondiffpatch | https://github.com/benjamine/jsondiffpatch | MIT | 维护活跃且支持对象/数组 diff，但输出是通用结构差异，不是故事因果差异 | 不引入；用小型领域派生函数 |
| XState | https://github.com/statelyai/xstate | MIT | 成熟的状态机/actor 库；本 Issue 只有表单、candidate、accepted 三个既有界面状态 | 不引入；现有 React state 足够 |
| NovelRipple Artifact / Generation Run / validator | 当前仓库 | 仓库自身 | 已验证不可变候选、一次 repair、Anchor、reasonPath、Worldline 写入门 | 最小扩展，作为唯一事实源 |

新增依赖：none。

## 领域与持久化

### RippleSuggestion

模型输出一至三个候选，每项严格包含：

- `eventId`
- `divergenceType`: `prevent | choice | outcome`
- `instruction`
- `whyInteresting`
- `affectedCharacterIds`
- `anchorRisk`: `low | medium | high`

服务端要求 Event 与 Character 均属于同一个 confirmed Story Map，候选 Event 不是最后一个 Event、具有实际下游 Event，且不得重复推荐同一 Event。任何一项非法即拒绝整组输出；不裁剪第四项、不丢弃坏项、不自动修补。

`RippleSuggestionsArtifact` 保存于现有 `artifacts` 表：`kind=ripple_suggestions`、`basedOnArtifactId=confirmed Story Map Artifact ID`、`generationRunId=成功的 ripple_suggestions Run`。生成建议不写 Worldline、Impact Plan 或 Source。

### Impact Plan lineage

普通 candidate 仍直接基于 confirmed Story Map。反馈 candidate 的 Artifact 增加不可为空的 lineage：

- `priorCandidateArtifactId`
- `feedback`
- `newGenerationRunId`
- `sameStoryMapArtifactId`
- `sameDivergence`
- `sameMode`
- `sameAnchors`

反馈 candidate 的 `basedOnArtifactId` 指向父 candidate。服务端从父 candidate 读取并冻结 Story Map Artifact、Divergence、mode 与 Anchors；Action 不接收可替换这些字段的客户端参数。Schema 同时要求 lineage 快照与新 candidate 相等。旧 v1 Impact Plan Artifact 保持可读，无需迁移。

每次反馈都启动新的完整 Generation Run，模型返回完整 `ImpactPlanModelOutput`。结果重新经过 Zod、Event/Character 引用、reasonPath、Anchor 和 pre-divergence invariants；不对父 JSON 作局部 patch。失败只保留 failed Generation Run。

接受操作只接收一个明确 candidate Artifact ID；accepted Artifact 的 `basedOnArtifactId` 指向该选中 candidate，因此只有被选中的 lineage 产生 Worldline。

## 模型上下文

Suggestions 不发送 Source 正文或 Golden，只发送 confirmed Story Map 的最小投影：Event ID/顺序/标题/摘要/participants，Character ID/role，causal Edge 与 Ending Candidate。模型没有写入权限。

Impact Plan 继续使用现有最小 Ripple context。反馈重生成额外发送父 candidate 的结构化计划和用户的一条反馈，不引入聊天历史。Prompt 明确要求重新输出完整 JSON，并保持冻结的 Divergence、mode 与 Anchor；真正约束仍由服务端而非 Prompt 承担。

## Preview 差异

新增纯派生 `ImpactPlanComparison`，不持久化第二份事实。它从 Story Map 与当前 candidate 生成：

- 原路径：candidate reasonPath 涉及的 Canon Event，按原序排列；
- 新路径：Impact summary；
- 删除、修改、新增、保持不变的关键事实：按 `ImpactItem.changeType` 分组。

界面只展示这些可解释分组，不实现 Timeline 引擎或通用 JSON diff。

## 用户流程

confirmed Story Map 进入 Ripple 后，首先显示“生成推荐分叉点”。建议生成后最多展示三个卡片；选择卡片只预填 Event、type 与 instruction，不生成 Preview。完整图与手动 Event 选择始终可用。

生成 candidate 后展示差异分组与单个反馈输入框。提交反馈只生成一个新 candidate，界面切换到新 candidate 并标明父版本；不出现聊天气泡、消息历史或自动追问。用户可再次提交新反馈，每次形成下一条不可变 lineage。

## 失败语义与隐私

- 非 confirmed Story Map、未知/无下游 Event、重复 Event、未知 Character、超过三个建议全部 fail closed；
- 反馈为空、父 Artifact 非 candidate、跨项目/跨 Source、冻结字段不一致全部 fail closed；
- regenerated output 任一 Schema、引用、reasonPath、Anchor 或 pre-divergence 校验失败时不得保存 Artifact 或 Worldline；
- Prompt、Source 正文、私人作品内容、raw model output 和 feedback 原文不得进入日志、公开报告或公开 fixture；feedback 只存在本地 Artifact；
- 测试使用现有公开原创 fixture；真实 Benchmark 只输出 Story A/B/C 与计数/判断。

## 验证

单元/合约覆盖：建议数量上限、非法 Event/Character、无 Worldline 写入、Artifact 绑定、反馈新 candidate、父 candidate 不变、冻结 Divergence/Anchor、非法重生成 fail closed、选择一个 lineage 接受。

E2E 覆盖：生成并选择建议但不自动生成 Preview、完整图手动选点、Preview 五类差异、反馈后新 candidate 与父版本提示、接受当前 candidate 后只创建一个 Worldline。

三篇私人 Benchmark 每篇生成最多三个建议并由人工评判至少两个值得探索；每篇至少提交一条反馈，确认问题解决且无硬违规。缺少真实人工判断时不得以模型自评或自动结构通过冒充 M1-05 PASS。
