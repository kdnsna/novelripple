# 0009：读者优先入口——快速确认、3 个瞬间与可选精修

- 状态：Accepted
- 日期：2026-10-17
- 范围：P0-3 / P1-4 — candidate Story Map 生成后允许直接进入 Ripple，Guided Review 变为可选精修；不改变 Source、Evidence、Story Map Schema、Impact Plan、Worldline 或 fail-closed 合同

## 背景

旧流程要求读者在进入 Ripple 前完成 Guided Review：确认核心人物、Ending Candidate 与重要 Evidence。M1-02 的用户观察显示读者“点击了很多但不知道目标”，数据库里 Ripple 与 Worldline 都是 0；价值最高的涟漪与续写被放在 9 步流程的最后。Phase 2 的 P0-3 建议把“核对”降为可选，并让读者在候选 Story Map 生成后立即看到 3 个值得改变的分叉点。

领域不变量不能因此放宽：Divergence、Impact Plan、Ripple Suggestions 与 Worldline 仍必须绑定 `status === "confirmed"` 的不可变 Story Map revision；Source 不可变、Evidence 可追溯、revision 不可变、兄弟世界线隔离和坏输出 fail closed 仍然有效。

## 决定

### 1. 新增 `quick_confirm_story_map` 操作，而不是放宽 confirmed 检查

Story Map review operation 增加 `quick_confirm_story_map`。仓库函数 `quickConfirmStoryMapArtifact({ projectId, artifactId })` 与普通确认共用 `createRevisionFromLatest`：

- 从项目内最新 draft revision 创建**新的** confirmed revision，旧行永不 UPDATE；
- 仍执行 Source 查找、Evidence Unit 派生、`assertValidStoryMap`、`assertValidStoryMapReview` 与 Artifact Schema 校验；
- 不调用 `requireReadyForRipple`，因此未完成核对也可确认；
- 不新增或删除 review confirmations，因此未完成的核对仍按 readiness 如实派生“未精修”；快速确认本身不检查 readiness；
- 已经 confirmed 时幂等返回同一行；base 不是最新 revision 时仍报 stale 并 fail closed；
- 普通 `confirm_story_map` 路径和 readiness 门完全不变。

confirmed 之后的下游检查一行未改：Ripple Suggestions 生成器、Impact Plan 生成器、Impact Plan 仓库和 Worldline 创建仍显式检查 `storyMap.status === "confirmed"`。读者只是更早到达“已确认”，并没有绕过任何 confirmed 绑定。

### 2. “未精修”与“待核对”是纯派生 UI 状态

新增 `src/domain/review/derive-story-map-refinement.ts`。它接收当前 Artifact 和已有的 `deriveStoryMapReview` 结果：

- `quickConfirmed`：当前 confirmed revision 的 `review.operation.type` 为 `quick_confirm_story_map`；
- `needsRefinement`：当前 revision 的 `storyMap.status` 为 `confirmed` 且 `readiness.readyForRipple` 为 false；它不看 operation 类型。普通 `confirm_story_map` 要求 readiness，所以实际上通常只有快速确认的 revision 会满足它；任何修正都会产生新的 draft revision，draft 不满足该条件，因此不显示横幅；
- 待核对的 Event / Edge / Ending Candidate ID 直接取 Review Queue 中 `status === "pending"` 且目标类型不是 character 的项，沿用原队列与优先级；
- 不新增置信度阈值、总分或持久化字段。

界面在这些节点、边、结局和队列项上显示小角标“待核对”，并在工作区显示“未精修 · 可随时进入精修模式”的横幅与进入精修模式的按钮。精修模式只切换当前视图；任何实际修正仍按原路径创建新的不可变 revision，完成后走普通确认。

### 3. `quickStartRippleAction` 只做 zod 校验与仓库调用

新的 Server Action `quickStartRippleAction(input)` 使用与其他 Story Map action 相同的 zod `.strict()` 输入（`projectId`、`artifactId`）和错误文案风格，调用 `quickConfirmStoryMapArtifact`，返回 `{ ok: true, artifact }` 或 `{ ok: false, error }`。页面随后把 workspace 快进到新 confirmed revision、打开 Ripple 面板并替换 URL；失败不写半成品。

### 4. 3 个瞬间复用现有 Ripple Suggestions

服务端页面读取当前 revision 的 `ripple_suggestions` Artifact 并传给工作区。Ripple 面板渲染“3 个值得改变的瞬间”：

- 如果当前 revision 已有 Suggestions，直接展示；
- 如果没有，mount 后自动调用现有 `generateRippleSuggestionsAction` 一次，`useRef` 防止 StrictMode/重渲染重复请求；
- 生成中显示“正在寻找值得改变的瞬间…”；失败显示现有 action 的错误文案与“重试”按钮；
- 每张卡展示事件标题、`whyInteresting`、建议 instruction 和“从这里改变”按钮，点击后只预填 Event、Divergence 类型与 instruction；
- 保留“或者，从时间线上自己选一个事件”的次路径。

不新增模型、Prompt、表或建议评分；Suggestions 仍是绑定 confirmed revision 与 Generation Run 的不可变 Artifact。

### 5. 模式标签改为读者语言

内部枚举仍为 `strict` / `open`。Ripple 表单、预览头与 Worldline 面板只改显示：

- `strict` → “保留原结局”，辅助说明“选择要保住的结局；新剧情会绕路回到这些结局”；
- `open` → “让故事自由发展”，辅助说明“不锁定结局，涟漪可以改写结尾”。

## 备选方案

| 方案 | 没有采用的原因 |
| --- | --- |
| 继续要求 Guided Review 完成后才能进入 Ripple | 这正是 P0-3 的核心问题；读者在见到价值前必须先做编辑工作，M1-02 已观察到因此无人创建 Ripple |
| 去掉 confirmed 要求，允许 draft 直接生成 Ripple / Worldline | 会破坏 candidate-first、revision 不可变和 Evidence 门禁；下游所有 confirmed 检查都必须重写，风险远大于收益 |
| 新增 Story Map `status: "quick_confirmed"` 或独立表 | 会形成第二套状态与迁移，且下游只认识 confirmed；operation type 已足够记录确认方式，readiness 本来就是派生视图 |
| 快速确认时自动替用户补齐/伪造 review confirmations | 会让“已核对”变成假事实，违反 Evidence 可追溯与人工确认语义；保持 confirmations 为空才能如实显示“未精修” |
| 为 3 个瞬间新增一次模型调用或新评分 | 现有 Ripple Suggestions 已由 confirmed Story Map 生成、带证据与因果空间筛选；重复实现会增加成本且产生第二套推荐标准 |
| 把“待核对”做成持久化风险分数 | 风险应可由当前 revision 重建；直接复用 Review Queue 的 pending 项与优先级即可，不引入不可解释总分 |

## Open-source preflight

检索日期：2026-10-17。本轮受任务约束不执行网络访问，也不复制第三方代码；结论基于仓库现有能力与已记录的通用方案：

- 复用 NovelRipple 已有的 `createRevisionFromLatest`、Story Map Review 派生队列、Ripple Suggestions 生成器/仓库/Action、Server Action + zod 与 React 客户端状态；没有新增依赖。
- 未引入推荐/排序库：现有 Suggestions 已有服务端 eligible Event 筛选与领域校验，前端只需展示 3 张卡。
- 未引入状态管理库或后台任务库：建议加载是一次现有 action 调用，失败可重试；快速确认是单行数据库事务，不需要队列。
- 新依赖：**none**。

## 后果

- 读者生成 candidate Story Map 后可一键确认并立即看到 3 个值得改变的瞬间，Guided Review 成为可选精修。
- 快速确认的 revision 如实记录确认方式：operation 为 `quick_confirm_story_map`，confirmations 保持为空；只要 readiness 尚未满足，界面就派生“未精修”角标与横幅，后续修正仍创建新 revision。
- 下游 confirmed 检查、Source/Evidence 校验、不可变 Artifact、Worldline 隔离与 fail closed 全部保持不变。
- 自动建议生成会给每个没有 Suggestions 的 confirmed revision 增加一次模型调用；这是现有生成器的一次调用，不新增 Prompt 或并发路径。如果调用失败，用户仍可从时间线自己选事件继续。
- 读者文案与内部枚举分离；日志、Schema、API 与世界线记录仍使用 `strict` / `open`。

## Addendum（W4）：建议批次与显式「换一批」

- `ripple_suggestions` Artifact 新增可选 `batchIndex` / `refreshOf` / `idempotencyKey`，旧行按批次 0 解析；Artifact 仍然只插入、不 UPDATE。
- 自动加载继续复用最新批次；只有用户显式点击「换一批」才创建新批次。客户端在点击时生成幂等键，服务端用 `(storyMapArtifactId, batchIndex, idempotencyKey)` 派生目标 Artifact id，并按该 id 使用 in-flight 锁合并并发请求；相同键的重试返回同一行且不调用模型。
- 不同键的并发换批必须按真实行为理解：同一 revision 的 in-flight 锁只执行第一个生成任务，其他并发请求（即使幂等键不同）await 同一个 Promise 并收到该批次；一次突发只产生一个 `batchIndex`、一次模型调用。锁释放后到达的新键请求才会重新读取已持久化批次并串行分配下一个 `batchIndex`。不会为每个不同键并发写入独立批次。
- 每个 revision 的批次数上限由 `RIPPLE_SUGGESTION_MAX_BATCHES_PER_REVISION`（默认 5）控制，按已持久化批次在模型调用前检查；达到上限时 fail closed 并禁用按钮。环境变量 trim 后只接受 `/^[1-9][0-9]*$/` 的纯十进制数字，且不超过 20；`"0x2"`、`"1e0"`、`"+3"`、`" 2.0"` 与超过上限的值都在任何 Prompt 读取与模型调用前 fail closed。
- 失败调用也计入上限：`generation_runs.model_calls` 在每次真实 provider 调用前自增并落库（迁移 `0011_generation_run_model_calls`；旧行为 `null`，按 1 次兜底），覆盖 initial、repair 与瞬时网络重试。每个 revision 的硬上限为 `批次数上限 × RIPPLE_SUGGESTION_MAX_MODEL_CALLS_PER_BATCH`（6 = initial 最坏 4 次 + repair 最坏 2 次；默认 5 批 → 30 次），在任何 Prompt 读取与模型调用前检查；运行中下一次 repair / 重试会超限时也在发出调用前 fail closed。失败与成功的真实调用同等计入，但不再有独立的“尝试次数”上限，因此失败不会提前挡住正常换批；成功批次仍受批次数上限约束。界面错误文案与换批提示区分“换一批上限”和“模型调用上限”。
- `generation_runs` 新增可空 `story_map_artifact_id` 绑定（迁移 `0010_generation_run_story_map_binding`），换批的 Generation Run 写入当前 Story Map revision；计数按该绑定与 `kind = "ripple_suggestions"` 过滤。旧行或其它 kind 的 run 没有该绑定，解析为 `null`。
- 换批 Prompt（`ripple-suggestions.v4`）携带之前批次的建议 Event id 与标题；模型重复推荐已建议事件时仍保存该批次，不静默重试。
- 界面提供 `‹ 1/2 ›` 批次切换与「换一批」；切回旧批次只读已有 Artifact，关闭/重开面板不会自动生成新批次。
- 本轮未新增数据库表或依赖；批次元数据保存在既有 `artifacts.data_json` 中，Generation Run 只增加可空绑定列。
- 调用计数加固新增迁移 `0011_generation_run_model_calls`（可空 `model_calls`）；仍未新增表或依赖。

### Open-source preflight（W4）

检索日期：2026-10-17。本轮受任务约束不执行网络访问，也不复制第三方代码；结论基于仓库现有能力：

- 复用已有的 immutable Artifact 行、`crypto.createHash` 确定性 id、进程内 `runWithInFlightLock`、Zod `.default()` 兼容解析、既有 Generation Run 记录与 `story-map-limits.ts` 的 env 校验模式。
- 未引入批次/状态管理库：批次导航是单个 React 状态，幂等键使用浏览器原生 `crypto.randomUUID()`。
- 未新增表：`batchIndex` / `refreshOf` / `idempotencyKey` 都存放在既有 `artifacts.data_json`，旧行按批次 0 解析；`generation_runs` 只增加可空 `story_map_artifact_id` 绑定列。
- 新依赖：**none**。本轮加固沿用上述复用结论，没有新增依赖或网络调用。
