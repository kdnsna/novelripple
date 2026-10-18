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

- `characters`：稳定 ID、姓名、别名、角色（主角 / 对抗者 / 配角 / 次要 / 已故）和初始状态；
- `events`：顺序、标题、摘要、参与人物、状态变化、事实层级和证据；
- `edges`：`causes`、`enables`、`foreshadows`；
- `endingCandidates`：可由用户选择为 Anchor 的终局条件。

每个 Story Map 必须绑定唯一 Source 和明确版本；Source 自身以 `contentHash` 保证内容身份。确认或修正地图会创建新版本，旧版本保留；用户确认只对该具体版本有效，Divergence 与 Impact Plan 不得自动漂移到其他版本。

Review Queue 与 Readiness 是当前 Source、Story Map、review metadata 和领域 validator 的纯派生视图，不是数据库事实源。队列按 inference、低置信度、人物 alias / identity 风险、Ending Candidate、高杠杆分叉、重要 Evidence 和软提示排序，不生成不可解释总分。高杠杆分叉由当前 Edge 图的下游可达事件数确定；人物 identity 风险只使用规范化后完全相同的 name / alias，不做模糊合并。

人工确认属于 Story Map Artifact 的 review metadata，只保存 Character / Event / Edge / Ending Candidate 的稳定 ID、原文定位引用，以及产生当前 revision 的 `operation type / timestamp / Story Map version`，不复制 Evidence 正文。每个 revision 只记录自己的一个 operation，完整 Artifact 链就是轻量操作历史，不另建分析平台。

rename / aliases / role、人物 merge、Event 更新/删除/有 Evidence 新增/重排、participant 重指派、Edge 新增/修改/删除以及各类确认都会创建新的 revision Artifact；节点拖动只改变浏览器中的视觉位置，不进入领域数据。Character merge 保留目标 ID、稳定合并别名、重映射全部 Event participant 并失效受影响人物与 Event Evidence 确认。Event 删除同时删除 incident Edge 与以它为目标的 Ending Candidate；Event 重排必须恰好包含当前全部 Event 一次。任何实际语义修改后，新 revision 保持 `draft`，旧 Artifact 与无关确认不变。

新增 Event 和 Edge 必须先从不可变 Source 派生的自然段 Evidence Unit 选择 Evidence；服务端仍只保存现有 `SourceReference[]` 并执行 offset/hash 与引用校验。不存在无 Evidence 新增 Canon Event 的路径。Edge 类型仍只有 `causes`、`enables`、`foreshadows`。

Readiness 至少要求：Event Evidence 合法、核心人物已核对、Ending Candidate 已核对、无非法引用、无悬空 Edge，以及 inference / 低置信度 Event 与低置信度 Edge 的重要 Evidence 已核对。服务端基于最新 revision 重新计算；未 ready 或 stale 的普通确认请求 fail closed。历史 confirmed Artifact 不迁移或覆盖。读者优先流程允许不经过该门直接确认，见下方“快速确认”；它仍受 Source、Evidence、Schema 与不可变性约束。

### 快速确认与“未精修”

`quick_confirm_story_map` 是 Story Map review operation 之一，只服务读者优先入口。它从最新 draft 通过与其它 revision 相同的 `createRevisionFromLatest` 路径创建**新的** confirmed revision：仍执行 Source、Evidence、Story Map Schema 和 review metadata 校验，旧 revision 与旧确认保持不变；区别只是不检查 readiness，也不改写 review confirmations。因此该 revision 的 operation 记录“它是被快速确认的”，而 confirmations 记录“它还没有经过精修”。已经 confirmed 的 revision 重复快速确认幂等返回同一行；普通 `confirm_story_map` 仍需 readiness 通过，语义不变。

Divergence、Impact Plan、Ripple Suggestions 与 Worldline 仍然只能绑定 `status === "confirmed"` 的不可变 Story Map revision。快速确认不会放宽这些仓库与生成器的 confirmed 检查，也不会自动创建 Worldline。

“未精修”是纯派生的 UI 状态：当前 revision 为 `confirmed` 且 readiness 尚未满足。它不依赖最新 operation 类型——快速确认后继续修正、只要 readiness 仍未满足，提示就仍然成立；`quickConfirmed` 另行记录当前 confirmed revision 的 operation 是否为 `quick_confirm_story_map`。需要“待核对”的 Event / Edge / Ending Candidate 直接复用 Review Queue 的 pending 项及其优先级，不引入第二套置信度或总分。界面在这些节点、边、结局与队列项上显示“待核对”角标，并显示“未精修 · 可随时进入精修模式”；进入精修模式只改变当前视图。之后的修正仍创建新的不可变 revision，精修完成后走普通确认。

### Edge 的“不确定”标记

Edge 的“不确定”是 review metadata，不是新的 Edge 类型：`review.uncertainEdgeIds`（缺省 `[]`，旧 review JSON 仍可解析）只保存 Edge 稳定 ID，不复制证据或原文，`StoryMap.edges[].type` 仍只有 `causes` / `enables` / `foreshadows`。Ripple Suggestions 与 Worldline Delta 不读取该标记；Impact Plan 读取它来区分确定与不确定的因果关系，但仍只把它当作可能性，不写入 Canon 或分支状态。Continuation 不直接读取 Story Map review，只读取 accepted Impact Plan 上服务端派生的 `uncertainImpactIds` 来提示“可能”。

`mark_edge_uncertain` / `clear_edge_uncertain` 走既有 `createRevisionFromLatest` 路径：实际改变状态时创建新的不可变 draft revision 并记录 operation；重复标记或重复清除幂等返回当前 Artifact，不新增 revision。删除 Edge（或通过删除 Event 级联删除 Edge）时同步清理对应标记。`uncertainEdgeIds` 必须唯一且引用当前版本存在的 Edge，否则 fail closed。

不确定 Edge 仍显示在 Review Queue 中并保持 pending，同时显示“不确定”角标；它不阻塞 `quick_confirm_story_map`（快速开始本来就不检查 readiness）。普通 `confirm_story_map` 的 readiness 将该标记视为“人工已经看过”：不再要求该 Edge 的重要 Evidence confirmation，因此可以正常确认；这不会伪造 Evidence confirmation，移除标记后旧要求重新生效。Evidence 选择器对 Edge 按到两个端点 Event 现有 Evidence Unit 的最小距离排序，对 Event 先按到当前 Evidence 的距离、再按参与人物姓名/别名的文本命中排序；排序是纯函数、确定性且不调用模型。

### Story Map 生成管线（Phase 1 分块召回）

Story Map 由一条确定性的分块召回管线生成，取代此前“全书 Extractor → 全书 Reconciler”的两步式生成：

1. **分块**：服务端从不可变 Source 派生自然段 Evidence Unit，并只按 Unit 边界切块。目标 6,000 字符，最小 3,000、最大 9,000，短尾回并；每块携带前 2 个只读上下文 Unit（第一块除外）。上下文可以引用为证据，但不负责抽取。
2. **逐块抽取**（`story-map-chunk.v2`）：抽取与补抽都最多 4 块并发；模型只处理 `core` Unit，按叙事顺序返回人物、事件和块内因果边。事件按场景/情节节拍归纳（通常每 600–1000 字一个），同一连续场景或对话不拆成多条；因果边只保留直接、重要的关系，不为单纯先后顺序建边。第一轮抽取不接收程序人名提示，由模型依据原文识别人物；抽取/补抽候选用 `kind: "individual" | "group"` 区分具体个体与群体——只要具体个体在本片段的事件中参与（行动、说话、被行动波及或在场），即使无名、只短暂出现或处于边缘，也列为 `individual`，边缘人物用 `role: "minor"`；固定两人小组合可作为一条 `individual`，模糊人群/复数集体仍为 `group`；只被提到、回忆或谈论、并未在本片段事件中参与的人不列为人物；`kind` 只存在于生成中的候选，不进入最终 Character Schema。
3. **逐块补抽**（`story-map-glean.v2`）：每块恰好一轮，只返回新增人物、事件和边，并收到尚未覆盖的确定性人名候选作为“可能漏名”提示；模型必须回原文核对，不是人物就忽略。补抽只补明显遗漏的独立情节节拍，不补更细的子步骤；只被提到、回忆或谈论、并未在本片段事件中参与的人同样不列为新增人物；遗漏的无名、短暂或边缘参与者仍列为 `individual` 并用 `role: "minor"`。
4. **人名归并**（`story-map-names.v2`）：程序统计全书人名候选——常见姓氏 + 1–2 字、`老/小/阿` + 单字或 ASCII 字母、姓氏 + 称谓，以及对白说话人（姓名后接言语动词或 `：“`）；确定性规则过滤虚词碎片、常见非人名词和群体名，说话人命中提升排序。群体、家族、机构候选在人名轮之前被丢弃，并从事件参与者中移除（事件只剩群体时保留一个群体作为最小例外）。模型只看到过滤后的候选与提示，判断哪些候选是同一人物；每个候选必须恰好归入一个人物的 `mergedFrom` 或恰好列入一次 `rejectedCandidateIds`。可拒绝的只有漏网的群体/人群/家族/家庭/机构，以及只评论、不参与情节的作者叙事者；具体人物即使只短暂行动或说话、无名、边缘、只出现一次或不确定是否重要，都必须合并为 `role: "minor"`，不得拒绝。参与事件的具体个体不能通过 `rejectedCandidateIds` 丢掉。被拒候选从人物和事件参与者中移除（事件只剩被拒参与者时保留第一个作为人物）；给定名/昵称只有在原文确认时才能成为别名人物的别名。
5. **结局轮次**（`story-map-endings.v2`）：读取全书末尾约 20% 的 Unit（至少 3 个），加上已汇总事件和人物，输出恰好一个故事级结局，以及每个结尾命运已定或被明确留白的角色各一个人物结局（含已离场配角与主角/叙述者本人）；同一结果不重复列出。人物结局以 `【人物结局】<人物>：<命运>` 写入 `endingCandidates`，不新增 Schema 字段。
6. **全书合并**（`story-map-merge.v2`）：合并跨块重复事件，也合并相邻块把同一场景/节拍拆得更细的事件（地点与时间窗口相同、参与者重叠、证据连续）；合并 prompt 附带 `<granularity_hint>`（核心文本字符数与目标事件范围 `[round(len/1000), round(len/600)]`，下限 3）：明显超出上限时把相邻同场景/更细节拍折叠到大致范围内，不同场景或转折点不合并，范围内只合并真正重复；按 `duplicateEndingGroups` 合并同一人物/故事主线上同一结果的结局候选，不同人物的命运不算重复；补充跨块 `causes` / `enables` / `foreshadows` 边并统一事件序列。服务端随后确定性去重：同一 `(from, to)` 的边只保留第一条的类型/说明并合并证据；故事级结局只在目标事件与规范化后的 `requirement` 文本都相同时折叠，人物结局按人物名折叠，均合并证据；最后去掉块内冲突 ID 的 `__c<chunk>` 后缀，碰撞时依次改为 `-2`、`-3`，并重写人物参与者、边端点和结局目标引用。

每个证据阶段都在本阶段做引用校验：块抽取与补抽只接受该块 `core` + `context` Unit，结局轮次只接受末尾 Unit 及已汇总事件的证据；最终合并对完整候选执行 Evidence 解析（Unit ID → `SourceReference[]`）和 Story Map 领域校验。Schema 或引用不合法时只 repair 一次，仍失败即 fail closed，不写入 Artifact；通过后才创建版本化 Artifact，Story Map Schema 保持不变。模型侧证据句柄始终是稳定 Unit ID，不返回 `exactQuote`、Section ID、偏移或 Hash。M1-03（`ca705d3`）曾把证据改为 sectionId + exactQuote，真实回归因逐字摘录无法稳定匹配而在一次 repair 后仍失败；本管线保留 Unit ID。

### Story Map 生成任务（后台、可恢复）

Story Map 生成不再占用一次同步 Server Action。用户点击生成后，服务端先写入 `jobs` 行（`kind: "story_map_generation"`，`input_json` 只含 `sourceId` 等稳定 ID），再由进程内 Runner 在响应之后调用同一分块管线。任务状态只能是 `queued` / `running` / `succeeded` / `failed` / `interrupted`；进度只记录固定阶段与计数（`chunking` → `extract` → `glean` → `names` → `endings` → `merge` → `saving`），不包含原文、Prompt 或模型输出。

同一 project + kind + source 同时最多一个 `queued`/`running` 任务；重复点击直接回到已有任务。成功时任务只保存 `artifactId`，失败时保存经统一脱敏的短错误。任务历史只追加：`failed` / `interrupted` 行不被复用，重试创建新行。Runner 每 15 秒刷新心跳；进程首次使用或心跳超过 2 分钟时，遗留的 `queued`/`running` 任务被标为 `interrupted`。project 页面读取该 Source 的最新任务，客户端在任务进行中轮询 `GET /api/jobs/[jobId]?projectId=<id>`：成功且仍在 `queued`/`running` 时每 1 秒继续，网络错误或 5xx 按 1、2、4、8…秒指数退避（上限 30 秒），成功后回到 1 秒；404 表示任务不存在或不属于本项目，停止轮询并允许重新开始；终态不再轮询。成功后导航到 `?artifact=<id>`；刷新页面仍从服务端恢复同一任务。详见 [`ADR 0008`](decisions/0008-background-jobs.md)。

重试不是从零重跑：每个分块的抽取与补抽结果在通过 Schema 与 Unit 引用校验后，作为只追加的检查点保存（`story_map_chunk_checkpoints`，阶段为 `extract` / `glean`），不保存 Prompt、原文或 raw model output。每行同时记录产生该阶段结果的 `generationRunId`（迁移前的旧行为 `null`）；复用检查点不重新调用模型，生成结果中的抽取/补抽 run id 列表始终按分块顺序保留**每个分块一个位置**：复用分块保留原始 run id，旧行没有 run id 时写入 `null` 占位而不是删除该位置，因此列表下标始终对应分块下标，且不会伪造来源。检查点按 project + `runGroupId` 加载，key 覆盖 Source id / `contentHash`、分块 `coreUnitIds` / `contextUnitIds` 与序号、全部 Prompt 版本以及模型/provider 身份；key 不匹配、损坏或无法再次通过阶段校验的行被忽略。启动任务接受显式 `mode`：`resume`（默认）在最新任务 `failed` / `interrupted` 时创建新任务行、沿用其 `runGroupId` 并写入 `retryOfJobId`，只补跑缺失的抽取/补抽分块；`fresh` 无论上一任务状态如何都使用全新 `runGroupId`，不读旧检查点、预算从 0 开始。首次生成没有可重试任务，`resume` 也自然得到新 group；人名、结局、合并始终重跑，并走同一 merge/Evidence/领域校验路径。

模型调用预算跨 attempt 累计：`jobs.model_calls` 记录本 attempt 每次真实 provider 调用（含 repair，调用前落库），同一 run group 的此前 attempt 之和同时参与预检与运行中计数；预计剩余调用或实际累计超过 `STORY_MAP_MAX_MODEL_CALLS` 时 fail closed，默认重试不能靠新任务行重置预算。预算写入是调用 provider 的硬前提：写入返回 `null`（任务已不再是 `running`，例如被 stale recovery 标为 `interrupted`）或抛错时，Runner 必须在真正发出下一次调用前中止，任务保持 `failed` / `interrupted` 并只保存脱敏错误，绝不继续产生未计费调用。因此失败/中断界面同时提供“重试（复用已完成分块）”（`resume`）与“从头重新生成”（`fresh`）；预算耗尽时错误文案固定脱敏并说明预算已用完，界面把 `fresh` 作为明确出路，避免某一 Source 被已耗尽的 run group 永久锁死。续跑进度显示 `已复用 N/M 个分块`（抽取与补抽都已复用的分块数）。检查点只追加、不 UPDATE；检查点行的调用数用于成本审计，预算以任务行为准，以覆盖“调用已发生但结果尚未落检查点”的崩溃窗口。

## Character

Story Map 中可被事件引用的人物实体。Character 在所属 Story Map 版本内有唯一 ID，`role` 取 `protagonist` / `antagonist` / `supporting` / `minor` / `deceased`；`minor` 表示只短暂出现、无名、边缘或不确定是否重要的具体人物，仍与主要人物一样必须参与至少一个有 Evidence 的 Event。当前不在 Character 上复制独立 Evidence：可作为剧情事实使用的人物状态必须写入带 Evidence 的 Event；`role` 与 `initialState` 只用于地图浏览和提取定向，不能脱离相关 Event 充当 Canon 事实。别名可以归到同一 Character，但不确定的合并不得静默发生。Character split 只有真实 benchmark 记录明确需求后才实现；M1-04 没有取得该证据。

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

生成 Impact Plan 时，服务端用纯函数把 confirmed Story Map 的 Edge 分成 `established` 与 `uncertain`：`uncertain` 是 `review.uncertainEdgeIds` 中的 Edge，或低于 `LOW_CONFIDENCE_THRESHOLD` 且 Evidence 尚未人工确认的 Edge（复用 `derive-story-map-review` 的常量与确认 helper），原因分别为 `marked_uncertain` / `unreviewed_low_confidence`。Prompt 只把 `established` Edge 放进 `confirmedStoryMap.edges`，把 `uncertain` 关系单独放进 `<uncertain_relations>` 并带原因；模型只能把后者写成可能性，不得作为 `direct` Impact 的唯一依据，并应将这些关系写入 `uncertainties`。`impact-plan.v4` / `impact-plan-feedback.v3` 承担该契约，旧 Prompt 版本保留。

服务端不信任模型：新 Impact Plan 用可选字段 `uncertainEdgeIds` 记录本次上下文中的全部不确定 Edge，用 `uncertainImpactIds` 记录 `reasonPath` 全程只由不确定 Edge 支撑的 Impact，再用 `usedUncertainEdgeIds` 记录本次计划实际用到的（作为某项 Impact `reasonPath` 相邻两步 from/to 出现）不确定 Edge，按首次使用顺序去重。旧 Artifact 没有这些字段仍可解析。三个列表各自必须唯一；`uncertainImpactIds` 只能引用本计划中存在的 Impact；两者同时存在时 `usedUncertainEdgeIds` 必须是 `uncertainEdgeIds` 的子集。生成候选时还会用绑定的 confirmed Story Map 做领域校验：`uncertainEdgeIds` / `usedUncertainEdgeIds` 的每个值都必须对应地图中真实存在的 Edge，否则 fail closed 并给出具体下标。接受候选与读取已接受计划进行续写时复用同一领域校验；旧计划缺少这些字段时跳过。预览摘要「含 N 条未精修/不确定关系」只按 `usedUncertainEdgeIds` 计数，完整详情给这些 Impact 加「可能」标记并单列实际用到的不确定关系；旧 Artifact 缺少 `usedUncertainEdgeIds` 时回退到旧的 `uncertainEdgeIds` 计数与列表（历史行为，可能多于实际使用）。该处理只影响本次推演的呈现，不改变 Edge 存储、readiness 或 Worldline Delta。

“混合路径”仍视为确定：`uncertainImpactIds` 只收录每一段相邻 Event 都由不确定 Edge 支撑的 Impact；只要 `reasonPath` 中有一段由已建立 Edge 支撑，就不降级为“可能”。理由是已建立的那一段提供了可核对的因果锚点，而模型已被要求在 `uncertainties` 中说明途经的不确定段；这样不会把混合路径整体当成已确认事实，也不会仅因途经一条不确定关系就否定整条路径。为避免“可能”的 Impact 看起来过于确定，服务端在生成计划时对 `uncertainImpactIds` 中的 Impact 执行 `confidence = min(model confidence, UNCERTAIN_IMPACT_MAX_CONFIDENCE)`（`UNCERTAIN_IMPACT_MAX_CONFIDENCE = 0.5`）；确定 Impact 的 confidence 不变。该封顶只作用于本次候选计划，不是新的 Edge 置信度，也不回写 Story Map。

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

同一 confirmed Story Map revision 的建议按批次追加：自动加载只复用最新批次，不再次调用模型；只有用户显式点击「换一批」才创建新的 `batchIndex`（0 为最初自动生成的一组），旧批次永不覆盖或删除，界面可切回任意批次。换批请求携带客户端在点击时创建的幂等键；Artifact id 由 `(storyMapArtifactId, batchIndex, idempotencyKey)` 确定性派生。相同键的重试/并发请求返回同一 Artifact，不增加模型调用。并发换批的实际合并规则是：同一 revision 的进程内 in-flight 锁只执行第一个生成任务，**不同幂等键**的并发请求也会 await 同一个 Promise 并收到同一批次，因此一次突发只写入一个批次、只发生一次模型调用；锁释放后到达的新键请求才按已持久化批次串行分配下一个 `batchIndex`，不同键不会并发写入多个批次。`refreshOf` 记录上一批 Artifact。旧行没有批次字段时解析为批次 0，不迁移历史数据。

每个 revision 的批次数由 `RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION` 控制（默认 5）。环境变量在 trim 后只接受 `/^[1-9][0-9]*$/` 的纯十进制数字，且不得超过 20；`"0x2"`、`"1e0"`、`"+3"`、`" 2.0"` 等写法以及超过上限的值都在任何 Prompt 读取与模型调用前 fail closed。批次上限按已持久化批次检查，达到后返回友好错误并禁用换批按钮。每个 `ripple_suggestions` Generation Run 在每次真实 provider 调用前把 `generation_runs.model_calls` 自增并落库（含 initial、repair 与瞬时网络重试）；写入失败时必须在真正发出该次调用前 fail closed。迁移 0011 之前的旧行没有该值，按每个 run 1 次保守计入；没有绑定 `story_map_artifact_id` 的旧 run 无法归属 revision，不参与计数。每个 revision 另有一条硬模型调用上限 = 批次上限 × `RIPPLE_SUGGESTION_MAX_MODEL_CALLS_PER_BATCH`（6）：每批最坏为 initial 4 次（1 次首调 + 2 次空响应重试 + 1 次瞬时网络重试）加 repair 2 次（1 次修复 + 1 次瞬时网络重试）；默认 5 批即 30 次，这也是该 revision 的最坏情况 provider 调用总数。两条上限都在任何 Prompt 读取与模型调用前检查，失败与成功的真实调用同等计入；运行中若下一次 repair 或重试会超过硬上限，也在发出调用前 fail closed。失败调用不写批次 Artifact，但不再有独立的“尝试次数”上限，因此失败本身不会在真实调用触顶前挡住正常的换一批；成功批次仍受批次数上限约束。批次数触顶与模型调用触顶返回不同的中文错误文案，界面据此显示对应提示。换批的 Prompt 会接收之前批次的建议 Event id 与标题，优先提出不同瞬间；如果模型仍只返回已建议过的 Event，批次照常保存，不因“重复”而静默重试或再次计费。每次换批仍创建独立 Generation Run 并在成功后绑定 Artifact。

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

1. 基于当前 Worldline 有效状态与当前路径提出恰好三个方向，每个方向包含标题、前提、受影响人物与预期后果；
2. 用户选择一个方向后生成一个完整场景及 `statePatch`。

### 场景节点树

方向和场景分别保存为不可变 `continuation` Artifact，均绑定该 Worldline、accepted Impact Plan 与对应 Generation Run；场景还绑定方向 Artifact 和用户选择。一次方向生成是一个方向批次（`schemaVersion: 2`）：`parentSceneId` 指向路径末端场景，根批次为 `null`，`batchIndex` 从 0 递增，批次内恰好三个方向。一次场景生成是一个节点（`schemaVersion: 2`），保存 `parentSceneId`、`depth`、`origin`（`generated` / `retry`）、`attemptIndex` 与 `summary`。根节点 `parentSceneId: null`、`depth: 1`；子节点 `depth = parent.depth + 1`。任一场景都可以作为父节点继续；同一方向重试创建新的兄弟场景（`origin: retry`、`attemptIndex` 递增），旧场景不更新；「换一批」在同一个父节点上创建新的方向批次（`batchIndex` 递增），旧批次保留。场景和方向 Artifact 永不 UPDATE，新内容总是新行。

方向批次 ID 由 `(worldlineId, parentSceneId ?? "root", batchIndex)` 确定性派生，方向 ID 由 `(batchId, index)` 派生；场景 ID 由 `(directionsArtifactId, selectedDirectionId, attemptIndex)` 派生。相同 ID 的重复写入幂等返回已有行，因此并发重试不会产生重复批次或重复场景。进入 Worldline 时客户端自动请求根批次一次；服务端若已有根批次直接复用，同一进程内按确定性目标 Artifact id 合并并发请求，只有用户“换一批”才会创建新的 `batchIndex`。v1 方向没有父节点/批次字段，视为根批次 0；v1 场景没有树字段，归一化为根节点（`parentSceneId: null`、`depth: 1`、`origin: generated`、`attemptIndex: 0`、`summary: null`、`contextManifest: null`），保留可读并可作为根父节点，不迁移历史行。

`statePatch` 只包含 `factsAdded`、`factsRemoved`、`characterChanges`、`threadsOpened` 和 `threadsClosed`。新增事实只能使用 `generated:` key，不得占用 `event:` / `impact:` / `divergence:` 命名空间；删除事实不得删除 accepted Impact Plan 派生的 Delta、严格模式 Anchor 目标或越过 Divergence 倒改分歧前 Canon。人物和线索必须存在于当前状态。

### 路径状态

Worldline 的基础状态只来自 accepted Impact Plan 确定性派生的 Delta（`baseDelta`）。当前路径状态是 `baseDelta` 沿根节点到当前节点的 `statePatch` 依次折叠的结果：只读取该路径上的节点，不读取兄弟节点、世界线中路径外的场景或未来节点。折叠沿用上述 `statePatch` 语义。路径必须同属一个 Worldline、父子链连续、`depth` 逐级加一，否则 fail closed。因此兄弟分支的状态互不可见，任一节点只影响它的后代路径。

### 路径作用域设定增量

读者可在任意场景节点添加一条短设定规则（`setting_delta` continuation Artifact，payload `SettingDeltaV1`：`subject`、`statement`、`anchorSceneId`）。`anchorSceneId` 为 `null` 时规则从分歧点起整条世界线生效；否则只在该锚点场景及其后代生效。规则只沿当前路径可见：祖先节点与当前节点上的规则生效，兄弟分支的规则永不出现。同一主体（人物稳定 ID 或规范化术语名）沿路径更晚/更深的规则覆盖较早规则，旧行保留为只读 history，不 UPDATE 或 DELETE。

停用、重新启用与软删除同样是不可变 `continuation` Artifact（`artifactType: "setting_delta_lifecycle"`，payload `SettingDeltaLifecycleV1`：`targetDeltaId`、`status: "deactivated" | "reactivated" | "deleted"`），不 UPDATE 原规则。同一 `targetDeltaId` 按 `(createdAt, id)` 取最新生命周期；没有生命周期视为 active。`deleted` 是软删除：从界面列表与生成上下文完全隐藏，也不占 active 名额；`deactivated` 在界面显示为“已停用”、不进入上下文、不占 active 名额，可被 `reactivated` 恢复（使用原规则说明）。软删除的规则不出现在任何主体的 history 中；生效版本被软删除时整个主体隐藏，不回退到更早版本。

写入时按规则的 `anchorSceneId` 构造路径（`null` = 分歧点空路径）并检查该路径的生效主体：新主体会让 active 数超过 `SETTING_DELTA_MAX_ACTIVE = 20` 时 fail closed，已有生效主体的改写属于替换、不增加 active 数。写入与重新启用还要检查 post-write active 集合的序列化长度：`serializeSettingDeltasForContext` 产生逐条紧凑文本，`normalizedContextChars` 做 NFKC、换行转空格、移除其余 C0/C1 控制字符并合并连续空格，超过 `SETTING_DELTA_CONTEXT_MAX_CHARS = 2000` 时 fail closed。每条 Worldline 最多 `SETTING_DELTA_MAX_PER_WORLDLINE = 50` 条非软删除规则，软删除释放名额。设定增量是读者规则，不是 Canon 证据，也不写入 `statePatch` 或路径状态；生效规则进入独立的可裁剪 `setting_deltas` 段，不再放入 `worldline_setup`。Prompt 要求其覆盖更早的路径状态与分歧后的推演，但不能改写分歧点之前已发生的原著事实。

### 上下文组装与清单

每次生成只从当前路径和当前 Worldline 组装上下文，固定顺序为：

1. `worldline_setup`：世界线、分歧、模式、Anchor、人物、accepted Impact Plan 与当前路径状态；
2. `canon_events`：与 accepted Impact Plan / Anchor 相关的 Canon 事件（id、标题、摘要、参与者、状态变化）、这些事件之间的边（id、from、to、类型、说明、置信度、confirmed），以及 Anchor 目标结局（id、targetEventId、requirement）；人物只带 id、姓名、别名与角色。该段**不包含任何 `evidence[]`**：相关事件的原著证据只在可裁剪的 `canon_evidence` 中提供，边与结局不再在必需段重复携带证据；
3. `setting_deltas`：当前路径生效的读者设定规则，每条带稳定 id（delta id）与“主体（作用域）：说明”；可裁剪，永不进入 `worldline_setup`；
4. `path_summary`：当前路径较早场景的滚动摘要；
5. `canon_evidence`：相关事件的原著证据切片排在最前，随后是 `selectContinuationContext` 选出的代表窗口与人物证据（后者仍受 6000 字符且严格小于 Source 25% 的选择器上限）；
6. `recent_scenes`：当前路径最近 2 个场景正文；
7. `selected_direction`：用户选中的方向；
8. `anchor_reminder`：严格/开放模式提示与状态补丁约束。

方向生成没有 `selected_direction`，其余段相同。

`worldline_setup`、`canon_events`、`anchor_reminder` 以及场景生成时的 `selected_direction` 是必需段，永不整段裁剪，它们只是预算下限；`setting_deltas` 不是必需段。超出 `CONTINUATION_CONTEXT_MAX_CHARS` 时按一条固定降级阶梯逐级尝试。阶梯是单一嵌套序列，每一级都只删除或严格缩短上一级的内容；结果固定为该预算下第一个放得下的状态。因此更大的预算只会停留在更早（或相同）的状态，绝不会丢掉更小预算已保留的证据、规则或完整场景，也不会使用更小预算没有启用的降级。阶梯为：

1. 完整内容；
2. `canon_evidence` 按优先级从低到高、同优先级从末尾一次丢一条，因此相关事件证据最后才被裁掉；
3. `setting_deltas` 从最浅/最旧开始整条丢弃（先 `anchorDepth`，再 `createdAt`，再 id），保留最深/最新的路径规则更久；被丢弃 id 写入 manifest 的 `droppedItemIds`；
4. `recent_scenes` 从最旧开始整条丢弃，始终保留最新一个场景；
5. `path_summary` 按整行从开头裁剪，首行省略/压缩提示保留到最后一刻，绝不把一行切成半句；
6. 若调用方提供了严格更短的紧凑 `worldline_setup`，整体替换为紧凑形式（只保留计数与 key，不包含任何 fact 正文）；
7. 最新场景有非空且严格短于正文的 `summary` 时，用该摘要替换正文；
8. 最新场景没有可用摘要（v1 场景 `summary` 为 `null`/空）时，在句末边界（`。！？!?…；;` 或换行，保留标点）截断正文为能放下的最长前缀，并追加 `（后文已截断）`；截断不得落在未闭合的引号内（`「」『』“”‘’` 与 ASCII 引号），也不得拆开 `……`；句末后紧跟恰好闭合引号的闭引号时（如 `。」`、`。』」`、`……」`），在所有闭引号之后截断；若只有引号内的句末可用，则在最外层开引号之前截断；若最外层开引号就在正文开头（整段都在引号内）、连安全前缀都放不下或正文没有句末边界，则进入第 9 步；
9. 仍超过预算则 fail closed，组装器抛出类型化 `ContinuationContextBudgetError`（`continuation_context_budget_exceeded`，携带 `neededChars` / `maxChars`），`message` 保留内部细节供日志；服务端边界把它映射为普通中文说明与可执行出路（换分歧瞬间或开放模式、减少 Anchor、停用或软删除本路径上过长/过多的设定增量、或由部署方提高 `CONTINUATION_CONTEXT_MAX_CHARS`），界面不直接展示内部术语。

第 6—8 步释放的预算不会回填第 2 步丢弃的证据：跨层回填会把低优先级内容塞进更小预算的结果（大预算停留在第 4—5 步时证据为零，小预算却带着回填证据），破坏嵌套顺序。紧凑 `worldline_setup`、摘要替换与 v1 截断释放的预算只用于让当前状态本身放得下；摘要与 v1 截断仍只在仍超预算时使用。

不会因为“完整形式的必需段放不下”提前启用紧凑形式：紧凑 `worldline_setup` 只出现在阶梯第 6 步，且只有它严格更短时才使用。总素材预算由 `CONTINUATION_CONTEXT_MAX_CHARS` 控制，默认 24000 字符，只约束组装后的 `<continuation_context>` 素材，不包含约 2–3k 字符的系统 Prompt 模板；配置不是正整数时 fail closed。预算按 UTF-16 字符数计算，不引入 tokenizer。

每次场景生成保存一个不含正文的 Context Manifest，只记录段名、是否包含、字符数、是否裁剪、被丢弃条目 ID，以及 `budget.totalChars / maxChars / percentageUsed`。`canon_evidence` 与 `setting_deltas` 的被丢弃 id 都记入各自段的 `droppedItemIds`。`recent_scenes` 用 `summarizedItemIds` 单独记录“用自身摘要替换正文”的最新场景 id，用 `truncatedItemIds` 记录 v1 正文被截断的场景 id；这两类场景不再计入 `droppedItemIds`。`canon_evidence` 的 `backfilledItemIds` 只为本分支期间可能已存的旧 manifest 保留为可选只读字段；新 manifest 不再写入（不做跨层证据回填），被丢弃的证据只出现在 `droppedItemIds`。`worldline_setup` 启用紧凑形式时用 `compactedFields` 记录实际移除的字段名（如 `currentState.factsAdded[].statement`、`currentState.characterChanges[].summary`），只含字段名，不含正文。`path_summary` 段额外用 `coveredItemIds`（只含场景 id）和 `watermarkId` 记录实际进入上下文的摘要覆盖范围。manifest 随场景 Artifact 保存，不写入 Prompt、原文或生成正文；前端只展示段名和计数。

### 路径滚动摘要

场景生成输出 `summary`（≤200 字），与场景一起不可变保存。组装上下文时，沿根→当前节点路径确定性构建滚动摘要：最近 2 个场景留给 `recent_scenes` 原文，更早的场景按从旧到新写成摘要行。超过 1200 字符时不再只丢弃旧行，而是保留最新若干行原文，把更早的场景压缩成一行 `更早剧情（第 a–b 幕）：` 加场景标题（以 `；` 连接）；标题按整条截断，不做字符截断。压缩行放不下全部压缩标题时，保留最靠近剩余全文行的最近若干条标题、丢弃更早的标题，因此显示范围始终连续；标记写实际显示范围 `第 a–b 幕`（a 为第一个实际显示的场景）。`coveredSceneIds` / `watermarkSceneId` 只覆盖实际显示的压缩场景与保留的全文行，不包含被丢弃的最早标题。压缩只读取给定路径的不可变字段，同一输入逐字节相同，不额外调用模型，也不查询兄弟分支；切换路径时按新路径重建，祖先内容保持一致。

模型只读取相关 Canon Event、对应 Source Evidence、accepted Impact Plan、当前路径状态、路径摘要与最近场景，不拼接整部 Source。Continuation 属于 `generated` 内容，不改变 Source，也不能充当原著 Evidence。

### v3 上下文与 v2 Prompt packet 的差异

v2 的 `<continuation_context>` 是一个 JSON packet，包含 `stage`、完整 `readonlyCanonical`、完整 `currentWorldline`、`divergence`、完整 `acceptedImpactPlan`、`relevantEvidence`、`currentState`，以及可选的 `styleContext` 与 `selectedDirection`。v3 改为固定段标签，内容对应关系如下：

| v2 packet | v3 段 | 说明 |
| --- | --- | --- |
| `readonlyCanonical` | `canon_events` | 保留 `sourceId`、`storyMapArtifactId`、`storyMapId`、人物 slim 字段、相关事件完整字段、事件之间的边（不含 `evidence`）与 Anchor 目标 `endingCandidates`（不含 `evidence`） |
| 无（0011 前的 `worldline_setup.settingDeltas`） | `setting_deltas` | 新增独立可裁剪段：当前路径生效的读者规则，每条带 delta id 与“主体（作用域）：说明”；写时限制 ≤20 个生效主体、序列化 ≤2000 规范化字符，超预算时从最浅/最旧开始整条丢弃 |
| `relevantEvidence` | `canon_evidence` 的前半部分 | 每个相关事件的证据切片，id 为 `related:<eventId>:<n>`；裁剪时最后丢弃；未变 |
| `styleContext.representativeExcerpts` / `styleContext.characterEvidence` | `canon_evidence` 的后半部分 | 仍由 `selectContinuationContext` 选择；排在相关事件证据之后，先被裁剪 |
| `currentWorldline` + `divergence` + `acceptedImpactPlan` + `currentState` | `worldline_setup` | 保留世界线 id/模式/分歧/Anchor、Story Map id/标题/logline、人物 id/姓名/别名/角色、accepted Impact Plan 的 id/mode/divergence/impacts 摘要（不确定项带 `uncertain: true`）/characterChanges/threadChanges/anchorEvaluations/uncertainties、当前路径状态；`stage` 由 Prompt 版本承担，不再重复 |
| 无 | `path_summary` | 新增：当前路径较早场景的确定性滚动摘要 |
| 无 | `recent_scenes` | 新增：当前路径最近 2 个场景正文 |
| 无 | `anchor_reminder` | 新增：从 Prompt 模板移到上下文末尾的严格/开放 Anchor 与 statePatch 约束 |
| 完整 `currentWorldline` JSON | `worldline_setup` 字段 | 不再发送完整 worldline 行；只保留上述字段。未发送的是数据库/审计字段（如 `parentWorldlineId`、`baseStoryMapArtifactId`、`acceptedImpactPlanId`、`idempotencyKey`、`createdAt`、`status` 等引用与时间戳），它们不改变生成语义 |
| 无预算/无清单 | manifest + `CONTINUATION_CONTEXT_MAX_CHARS` | 新增：段级字符预算、裁剪记录、`coveredItemIds` / `watermarkId`；Prompt 模板不计入预算 |

`canon_events`、相关事件证据、边、Anchor 目标结局与 accepted Impact Plan 均未删除；v3 只是把原来混在一个 JSON 里的内容拆成固定顺序、可裁剪、可审计的段。边与结局的 `evidence[]` 不再进入必需段，相关事件的原著证据仍由可裁剪的 `canon_evidence`（相关事件切片）提供，因而不会让 strict 模式的必需上下文随边/结局的证据体积无限增长。


## 状态转换与确认门

```text
Source
→ Story Map（明确版本）
→ 用户确认该 Story Map 版本
→ Divergence
→ Impact Plan（提案并评估 Anchor）
→ 用户接受当前 Impact Plan
→ Worldline（父世界线 + Delta）
→ Continuation（场景节点树：可继续、重试分叉、换一批方向）
```

Impact Plan 被接受前不得创建或改变 Worldline。所有模型结构化输出只有同时通过 Schema、Evidence、引用完整性和领域不变量校验，才能成为下一步输入；失败时拒绝完整候选并停止状态推进。
