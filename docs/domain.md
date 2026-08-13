# 领域语义

本文件定义 `v0.1.0` 确立、M1 继续沿用的唯一领域语言。TypeScript / Zod Schema 是它的可执行表示；两者不一致时必须在同一变更中修正。M1-04 只扩展现有 Story Map review metadata 与不可变 revision 操作，不改变 Source、最终 Story Map Evidence、Impact Plan、Worldline 或 Continuation 合同。

## 事实层级

| 类型 | 含义 | 是否必须有原文证据 |
| --- | --- | --- |
| `fact` | 原文明确陈述或直接发生 | 是 |
| `inference` | 根据原文推得，但存在解释空间 | 是，并带置信度 |
| `generated` | 分歧后新世界线产生的内容 | 否，但必须追溯到 Divergence / Impact Plan |

## Source

原著及定位信息。保存 `originalText`、`normalizedText`、`contentHash` 和 section 边界。创建后不可修改；需要更换文本时创建新 Source。

## SourceReference / Evidence

`SourceReference` 是 Source 中一段非空原文的稳定定位，必须绑定明确的 Source 和 section。`Evidence` 表示“某项故事理解由哪段原文支持”，把一个或多个 SourceReference 关联到 `fact` 或 `inference`；生成内容不能成为原著 Evidence。

M0 的可执行结构将两者合并为 Evidence Reference，使用规范化文本的 UTF-16 字符偏移：

```json
{
  "sourceId": "source_ripple_001",
  "sectionId": "section_03",
  "start": 3281,
  "end": 3412,
  "excerptHash": "sha256:..."
}
```

必须满足 `0 <= start < end <= normalizedText.length`，且切片 Hash 与 `excerptHash` 相同。Source 不存在、section 不存在、位置越界、范围为空或 Hash 不匹配时，Evidence 无效，依赖它的候选结构不得被确认。

## StoryMap

Story Map 是对 Source 的版本化解释，不是 Source 本身。当前只包含：

- `characters`：稳定 ID、姓名、别名、角色和初始状态；
- `events`：顺序、标题、摘要、参与人物、状态变化、事实层级和证据；
- `edges`：`causes`、`enables`、`foreshadows`；
- `endingCandidates`：可由用户选择为 Anchor 的终局条件。

每个 Story Map 必须绑定唯一 Source 和明确版本；Source 自身以 `contentHash` 保证内容身份。确认或修正地图会创建新版本，旧版本保留；用户确认只对该具体版本有效，Divergence 与 Impact Plan 不得自动漂移到其他版本。

Review Queue 与 Readiness 是当前 Source、Story Map、review metadata 和领域 validator 的纯派生视图，不是数据库事实源。队列按 inference、低置信度、人物 alias / identity 风险、Ending Candidate、高杠杆分叉、重要 Evidence 和软提示排序，不生成不可解释总分。高杠杆分叉由当前 Edge 图的下游可达事件数确定；人物 identity 风险只使用规范化后完全相同的 name / alias，不做模糊合并。

人工确认属于 Story Map Artifact 的 review metadata，只保存 Character / Event / Edge / Ending Candidate 的稳定 ID、原文定位引用，以及产生当前 revision 的 `operation type / timestamp / Story Map version`，不复制 Evidence 正文。每个 revision 只记录自己的一个 operation，完整 Artifact 链就是轻量操作历史，不另建分析平台。

rename / aliases / role、人物 merge、Event 更新/删除/有 Evidence 新增/重排、participant 重指派、Edge 新增/修改/删除以及各类确认都会创建新的 revision Artifact；节点拖动只改变浏览器中的视觉位置，不进入领域数据。Character merge 保留目标 ID、稳定合并别名、重映射全部 Event participant 并失效受影响人物与 Event Evidence 确认。Event 删除同时删除 incident Edge 与以它为目标的 Ending Candidate；Event 重排必须恰好包含当前全部 Event 一次。任何实际语义修改后，新 revision 保持 `draft`，旧 Artifact 与无关确认不变。

新增 Event 和 Edge 必须先从不可变 Source 派生的自然段 Evidence Unit 选择 Evidence；服务端仍只保存现有 `SourceReference[]` 并执行 offset/hash 与引用校验。不存在无 Evidence 新增 Canon Event 的路径。Edge 类型仍只有 `causes`、`enables`、`foreshadows`。

Readiness 至少要求：Event Evidence 合法、核心人物已核对、Ending Candidate 已核对、无非法引用、无悬空 Edge，以及 inference / 低置信度 Event 与低置信度 Edge 的重要 Evidence 已核对。服务端基于最新 revision 重新计算；未 ready 或 stale 的确认请求 fail closed。历史 confirmed Artifact 不迁移或覆盖，新的 draft 必须通过该门才能创建 confirmed revision。

## Character

Story Map 中可被事件引用的人物实体。Character 在所属 Story Map 版本内有唯一 ID。当前不在 Character 上复制独立 Evidence：可作为剧情事实使用的人物状态必须写入带 Evidence 的 Event；`role` 与 `initialState` 只用于地图浏览和提取定向，不能脱离相关 Event 充当 Canon 事实。别名可以归到同一 Character，但不确定的合并不得静默发生。Character split 只有真实 benchmark 记录明确需求后才实现；M1-04 没有取得该证据。

## Event

原著中已经发生或被明确叙述的故事事件。Event 在所属 Story Map 版本内有唯一 ID、事实层级和 Evidence；同一版本不得出现重复 Event ID。每个 `participant` 都必须引用该版本中存在的 Character。

## Edge

同一 Story Map 版本中两个 Event 之间的有向关系。起点和终点都必须存在，不得悬空。只允许：

- `causes`：上游事件对下游事件的发生具有实质因果作用；
- `enables`：上游事件让下游事件成为可能，但本身不足以导致它发生；
- `foreshadows`：上游事件在叙事上预示下游事件，不主张因果关系。

无法可靠归入这三类的关系不进入 Story Map，M1 不增加其他 Edge 类型。

## Divergence

新世界线首次偏离父世界线的声明。它只能指向用户已确认 StoryMap 版本中的一个 Event，并记录该版本；Divergence 本身不修改 Source、StoryMap 或已有 Worldline。

```json
{
  "eventId": "event_07",
  "type": "prevent",
  "instruction": "许澄没有交出红色账簿"
}
```

类型只有：

- `prevent`：事件不发生；
- `choice`：人物做出不同选择；
- `outcome`：事件发生但结果不同。

## Anchor

严格模式中由用户选择的终局条件。开放模式的 `anchors` 为空，但分歧前历史和未被改变的世界规则仍然有效。

严格模式和开放模式共用同一套“Divergence → 因果影响 → Anchor 评估 → Impact Plan”推演模型。开放模式只是没有结局 Anchor，不是没有因果约束。

Anchor 评估状态：

- `preserved`：路径和结果基本不变；
- `rerouted`：结果可保留，但必须经过新路径；
- `threatened`：现有信息不足或风险较高；
- `incompatible`：分歧与 Anchor 不能同时成立。

`incompatible` 必须阻止创建严格模式世界线，除非用户改变分歧、修改 Anchor 或切换开放模式。

## ImpactPlan

模型或夹具提出的结构化候选，至少包含：

- 直接、下游与结局影响（`direct`、`downstream`、`ending`）；
- 每项影响的起始事件 `fromEventId`、受影响事件 `affectedEventId`、`reasonPath`、说明和置信度；
- 人物状态与线索变化；
- Anchor 评估；
- 不确定项。

ImpactPlan 是提案，不是 Worldline 中已经成立的事实。模型只输出影响与评估；ID、Story Map 版本、Divergence、模式、Anchor 和状态由服务端绑定。严格与开放计划不得通过改标签互换；开放模式必须没有 Anchor 和 Anchor evaluation。

`reasonPath` 是当前 confirmed Story Map 中 Event ID 组成的有序因果路径，不是相关事件或替代前提的无序列表。每条路径必须满足：

- 只引用当前 confirmed Story Map 中存在的 Event，且同一条路径不得重复 Event；
- 每项 Impact 的路径都包含 Divergence Event，`fromEventId` 等于路径第一个节点；`direct` Impact 必须从 Divergence Event 开始；
- `affectedEventId` 非空时，路径最后一个节点等于该 Event；
- 每项 Anchor Evaluation 的路径从 Divergence Event 开始，并以对应 Anchor 的 `targetEventId` 结束；
- 原作中的替代前提若不是实际因果路径节点，只写入 `explanation`，不得用语义不清的 ID 列表冒充路径。

Divergence 是父世界线的首次偏离，因此无论严格或开放模式，ImpactPlan 都不得把 `modified` / `removed` 作用于分歧点之前的 Event。分歧前事实只能作为因果前提被引用，不能被倒改。

Ripple Preview 只保存 `candidate` Impact Plan Artifact 与对应 Generation Run，并从 confirmed Story Map 构造只读 Canonical 上下文；它不写入 Canonical 或子 Worldline。只有用户明确接受后，候选计划才能产生新的 `accepted` revision，原 candidate 保留不变。

## Ripple Suggestions 与反馈谱系

Ripple Suggestions 是分叉点推荐候选，只允许基于 confirmed Story Map 生成一至三个 `RippleSuggestion`，每个建议引用一个存在 `causes` / `enables` 出边的 Event（服务端先确定性筛出 `eligibleEventIds` 再交给模型）。建议只预填 Event、`prevent | choice | outcome` 与 instruction，不自动生成 Impact Plan、Worldline 或分支；未知、重复、无后续因果空间的事件与未知/重复人物都整组 fail closed。建议作为 `ripple_suggestions` Artifact 保存，绑定对应 Generation Run。

Impact Plan 反馈重生成是完整的新 Generation Run 与完整 `ImpactPlanModelOutput`，不是局部 patch 或聊天。每次反馈产生新的不可变 `candidate` revision，并保存 `lineage`：父 candidate Artifact、反馈文本、新 Generation Run、同一 Story Map Artifact、同一 Divergence、同一 mode 与同一 Anchors。这些字段由服务端从父 candidate 冻结，客户端不可替换；原 candidate 与任何已接受版本保持不变。只有用户明确接受的一个候选谱系才能创建 Worldline。

## Worldline

Worldline 采用“不可变基线 + 增量”：

```text
Source → Story Map version → Divergence → accepted Impact Plan → Worldline delta
```

子世界线必须显式引用：

- `parentWorldlineId`；
- `baseStoryMapArtifactId`；
- `divergence`；
- `anchors`；
- `acceptedImpactPlanId`；
- `idempotencyKey`。

同一项目内相同 `idempotencyKey` 只能创建一次。兄弟世界线不得共享分歧后的可变状态。

每个派生 Worldline 只保存父世界线、基线与 accepted Impact Plan 引用，不复制整部故事。M0 由 accepted Impact Plan 确定性派生该分支的 `Delta`：被阻止或改写的 Canon Event 使用 `event:<id>` 标记删除，新分歧与影响分别使用 `divergence:<id>`、`impact:<id>` 标记新增；人物和线索变化直接来自已接受提案。这样只保留一个 Delta 权威来源，不在 Worldline 行内复制第二份可漂移状态。Source、Canon、父世界线和兄弟世界线都不得被反向修改。

接受操作必须在同一事务中按顺序写入：`accepted Impact Plan revision → 幂等 Canonical Worldline → 子 Worldline`。Canonical 和子分支都使用确定性幂等标识；重复接受必须返回同一组记录。任一校验、Anchor 或写入失败时整个事务回滚。

## Continuation

Continuation 分为两个固定阶段，不是 Agent：

1. 基于当前 Worldline 有效状态提出恰好三个方向，每个方向包含标题、前提、受影响人物与预期后果；
2. 用户选择一个方向后生成一个完整场景及 `statePatch`。

`statePatch` 只包含 `factsAdded`、`factsRemoved`、`characterChanges`、`threadsOpened` 和 `threadsClosed`。新增事实只能使用 `generated:` key，不得占用 `event:` / `impact:` / `divergence:` 命名空间；删除事实不得删除 accepted Impact Plan 派生的 Delta、严格模式 Anchor 目标或越过 Divergence 倒改分歧前 Canon。人物和线索必须存在于当前状态。方向和场景分别保存为 `continuation` Artifact，均绑定该 Worldline、accepted Impact Plan 与对应 Generation Run；场景还绑定方向 Artifact 和用户选择。M0 每条 Worldline 只允许一个场景，同一选择重试返回原 Artifact，更换选择必须明确失败。

模型只读取相关 Canon Event、对应 Source Evidence、accepted Impact Plan 和当前 Delta，不拼接整部 Source。Continuation 属于 `generated` 内容，不改变 Source，也不能充当原著 Evidence。

## 状态转换与确认门

```text
Source
→ Story Map（明确版本）
→ 用户确认该 Story Map 版本
→ Divergence
→ Impact Plan（提案并评估 Anchor）
→ 用户接受当前 Impact Plan
→ Worldline（父世界线 + Delta）
→ Continuation（一个后续场景）
```

Impact Plan 被接受前不得创建或改变 Worldline。所有模型结构化输出只有同时通过 Schema、Evidence、引用完整性和领域不变量校验，才能成为下一步输入；失败时拒绝完整候选并停止状态推进。
