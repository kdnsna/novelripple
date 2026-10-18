# 0008：可恢复的后台 Story Map 生成任务与轮询进度

- 状态：Accepted
- 日期：2026-10-17
- 范围：P0 — Story Map 生成从 60–80 秒同步 Server Action 改为 SQLite 持久化的可恢复后台任务；Phase 2 收尾补充分块检查点、检查点来源与跨 attempt 调用预算。不改变 Source、Story Map Artifact、Evidence、候选先于提交或 fail-closed 合同

## 背景

当前 `生成 Story Map` 在 Server Action 里同步等待完整分块管线。真实作品通常需要 60–80 秒，请求接近 120 秒超时，用户只看到一个禁用按钮；刷新会丢失请求，服务重启则无法判断任务是否仍在运行。生成失败也没有可追踪的任务历史。

本轮只解决“长任务可观察、可刷新、可恢复、可重试”，不引入队列服务、Worker 进程、SSE 或新的部署单元。

## 决定

### 1. 新增只保存任务控制信息的 `jobs` 表

迁移 `drizzle/0007_background_jobs.sql`：

| 列 | 含义 |
| --- | --- |
| `id` | `job_<uuid>`，任务身份 |
| `project_id` | 外键到 `projects`，删除项目时级联删除任务 |
| `kind` | 目前只有 `story_map_generation` |
| `input_json` | 只含稳定 ID（当前为 `sourceId`，以及可选的 `runGroupId` / `retryOfJobId`，见第 8 节），绝不保存原文 |
| `status` | `queued` / `running` / `succeeded` / `failed` / `interrupted` |
| `progress_json` | `{ stage, completed, total }`；`stage` 是固定枚举，不含正文 |
| `result_json` | 成功时 `{ artifactId }` |
| `error` | 只保存经过脱敏的短消息，不保存 Prompt、模型输出或原文 |
| `created_at` / `updated_at` / `heartbeat_at` | ISO 时间；心跳用于恢复判断 |

Zod 行 Schema 位于 `src/domain/schemas/job.ts`，Repository 位于 `src/server/repositories/job-repository.ts`。任务行是追加式历史：状态可以沿 `queued → running → succeeded|failed` 前进，但重试永远插入新行，不复活或复用失败行。迁移只新增表，不改写已有数据。

### 2. 单飞与后台 Runner

`startStoryMapGenerationJob(projectId, sourceId)` 在同一个 project + kind + source 下先查 `queued`/`running` 任务；存在则直接返回它，不创建第二行，也不启动第二个 Runner。Server Action 只在新建任务时用 Next.js `after()` 调度 `runStoryMapGenerationJob`，因此响应不等待模型；`after()` 在 Node 自托管与本地开发中继续执行到完成。

Runner 用条件更新认领任务（只有 `queued` 能变成 `running`），每 15 秒刷新一次心跳；管线每进入一个阶段或完成一个分块就写入进度。成功时写入 `result.artifactId`，失败时用 `storyMapGenerationErrorMessage` 脱敏后写入 `error`。所有状态更新都带当前状态条件，避免中断后又被迟到的回调覆盖。每次 provider 调用前的预算写入也是硬条件：`updateJobModelCalls` 返回 `null`（任务已不是 `running`）或抛错时，Runner 立即中止生成，不再发出未计费的模型调用；任务保持 `interrupted` / `failed` 并只保留脱敏错误。

### 3. 进度回调不改变生成语义

`generateStoryMap` 新增可选 `onProgress`，默认 no-op。回调只接收阶段与计数：

```text
queued → chunking → extract(0..n) → glean(0..n) → names → endings → merge → saving
```

`extract` / `glean` 的 `total` 是分块数，`completed` 按完成数递增；单步阶段 `total: 1`。回调不参与 Prompt 拼装、Schema 校验、repair 判断或模型调用计数，因此同一输入开启/关闭进度必须产生相同 Artifact 内容与相同调用次数。

### 4. 恢复：进程内首次使用收口旧任务

`ensureJobRecovery()` 在进程内第一次被页面、Action 或 API 调用时执行：

- 首次调用把本进程启动前遗留的 `queued`/`running` 任务全部标为 `interrupted`，覆盖“服务器重启时任务正在跑”的场景；
- 之后的页面调用只把心跳超过 2 分钟的 `queued`/`running` 任务标为 `interrupted`。

状态通过 `globalThis` 保存，避免 Next dev 热更新重复执行首次恢复。Runner 在长阶段持续刷新心跳，所以正常慢任务不会被误判。`interrupted` 行保留原 `created_at`、进度和历史；`重试` 总是创建新任务。

### 5. 轮询而不是 SSE

服务端页面在首次渲染时读取该 Source 的最新任务，刷新后仍显示同一进度。客户端组件在 `queued`/`running` 时请求 `GET /api/jobs/[jobId]?projectId=<id>`：成功且仍在进行中时每 1 秒继续；网络错误或 5xx 按 1、2、4、8…秒指数退避（上限 30 秒），下一次成功后重置为 1 秒；404 表示任务不存在或不属于本项目，停止轮询并显示“任务不存在或不属于本项目”与“重新开始”；`succeeded` / `failed` / `interrupted` 等终态不再轮询。成功后刷新到 `?artifact=<id>&generated=created`，与旧同步流程最终展示完全一致。

轮询的代价是每秒一个很小的本地 SQLite 读取，但收益是：无需长连接管理、无需处理 SSE 重连与代理缓冲、页面刷新天然恢复，且现有 Next.js/SQLite 单进程部署不需要新基础设施。SSE 只在真实并发与实时性需求证明不足时再评估。

### 6. 读侧只暴露脱敏视图

`src/server/jobs/job-view.ts` 只保留 `id`、`status`、`progress`、`result`、`error`。API 不返回 `input`、心跳、Prompt、模型输出或原文；错误在写入前已经过统一脱敏函数，未知异常只会得到固定文案。`JobIdSchema` 先校验路径参数，非法 ID 返回 400；调用方还必须用查询参数 `projectId`（`ProjectIdSchema`）声明所属项目，缺失或非法返回 400。任务不存在与任务属于其它项目返回同一个 404，避免用任务 id 探测其它项目。

### 7. 明确不做的

- 不新增队列库、Redis、Worker 进程或第二个数据存储；
- 不实现跨进程锁或分布式调度；当前产品是本地/单 Node 进程工具，单飞在进程内完成；
- 不改 Story Map Schema、Prompt、Evidence 解析或 Artifact 写入路径；
- 不为历史同步调用保留兼容双轨。

### 8. 分块检查点与跨 attempt 预算（Phase 2 收尾）

此前失败/中断的任务重试会从第 1 个分块重新调用模型，`STORY_MAP_MAX_MODEL_CALLS` 也在每次 attempt 从 0 开始，因此多次重试的总调用数可能超过上限。本轮把**已验证的分块中间结果**持久化，并让同一逻辑生成的所有 attempt 共享调用预算。

#### 8.1 只存已验证的分块阶段结果

迁移 `drizzle/0008_story_map_chunk_checkpoints.sql` 新增只追加表 `story_map_chunk_checkpoints`：

| 列 | 含义 |
| --- | --- |
| `id` | `ckpt_<uuid>`，检查点行身份 |
| `project_id` / `source_id` | 外键；项目删除时级联删除 |
| `source_content_hash` | 生成时 Source 的 `contentHash` |
| `run_group_id` | 同一次逻辑生成的所有 attempt 共享 |
| `checkpoint_key` | 由 Source 身份 + 分块计划 + Prompt 版本 + 模型/provider 派生的 SHA-256 |
| `chunk_index` | 分块序号 |
| `stage` | `extract` / `glean` |
| `result_json` | 该阶段通过 Schema 与 Unit 引用校验后的结构化候选 |
| `model_calls` | 产生该阶段结果实际消耗的模型调用数（含 repair） |
| `generation_run_id` | 产生该阶段结果的 Generation Run（迁移 0009 新增；旧行为 `null`） |
| `created_at` | 追加时间 |

检查点粒度是**单个分块的一个阶段**：抽取一完成就追加 `extract` 行，补抽完成再追加 `glean` 行。这样在“抽取全部完成、补抽进行到一半”时崩溃，重试仍可复用所有已完成抽取，只补做缺失的补抽。`checkpoint_key` 包含：

- `source.id` 与 `source.contentHash`（Source 变化即失效）；
- 分块 `id`、`index`、完整 `coreUnitIds` / `contextUnitIds` 顺序（分块计划变化即失效）；
- 全部 `STORY_MAP_PROMPT_VERSIONS`（任一 Prompt 版本升级即失效）；
- `modelConfig.model` 与 `providerName`（模型或 provider 身份变化即失效）。

不存 Prompt、原文、`exactQuote`、模型 raw output 或修复前后文本；`result_json` 只等于管线本来就会留在内存里的 `StoryMapExtractionCandidate` / `StoryMapGleaningCandidate`。行只 INSERT，不 UPDATE；key 不匹配的旧行保留但不再命中。

#### 8.1b 检查点来源与 run id 顺序

迁移 `drizzle/0009_story_map_checkpoint_provenance.sql` 给检查点表增加可空列 `generation_run_id`。每次保存 `extract` / `glean` 行时写入 `generateStructured` 返回的 `generationRunId`；迁移前写入的旧行保持 `null`，不会伪造来源。

生成结果中的 `extractorRunIds` / `gleaningRunIds` 按**分块顺序**返回，而不是按并发完成顺序 append：

- 新调用在对应分块序号写入本次 Run；
- 复用检查点写入该行原始的 `generation_run_id`，因此重试后的结果仍能追溯到真正产生该分块结果的那次运行；
- 迁移前没有 run id 的旧检查点无法恢复原始 Run，会被略过，不会填入本次 Run 冒充来源。

复用判定仍以 `checkpoint_key + stage` 和阶段校验为准；来源字段只用于追踪，不参与 key，也不放宽 fail-closed 校验。

#### 8.2 重试创建新任务并共享 run group

任务输入仍只保存稳定 ID，新增两个可选字段：

```json
{
  "sourceId": "source_...",
  "runGroupId": "run_...",
  "retryOfJobId": "job_..."
}
```

`startStoryMapGenerationJob` 接受经 Zod 校验的显式 `mode`，不写入任务输入：

- `resume`（缺省）：只把最新任务的 `failed` / `interrupted` 视为可重试；新任务沿用它的 `runGroupId`（旧任务没有该字段时用旧任务 id），并写入 `retryOfJobId`。最新任务是 `succeeded` 或不存在时创建全新的 `runGroupId`，因此“重试”复用已完成分块与预算，而普通再次生成不会复用成功运行的检查点或继承其预算。
- `fresh`：无论上一任务状态如何，总是创建全新的 `runGroupId`，不写 `retryOfJobId`，因此不读旧检查点、预算从 0 开始。首次生成没有可重试任务，`resume` 也自然得到新 group。

两种模式仍只追加新任务行，旧任务行、状态和进度保持不变。

Runner 只加载同一 `projectId + runGroupId` 的检查点；同一 key + stage 存在多行时取最新一行。每一行在复用前都会再次通过阶段 Schema 和当前分块 Unit 范围校验；损坏、旧版或 key 不匹配的行被忽略并重新生成，检查点永远不会绕过 fail-closed 校验。

#### 8.3 哪些阶段检查点、哪些重跑

- **检查点**：每块抽取（`story_map_extract`）与它的补抽（`story_map_glean`）。
- **重跑**：人名归并、结局轮次、全书合并。它们依赖已汇总的检查点结果，本身不作为检查点；其调用仍计入预算。
- 所有检查点结果仍按原顺序汇总，随后走与普通生成完全相同的 `poolChunkCandidates → dropGroupCandidates → applyRoster → applyEndingPass → applyMerge → Evidence 解析 → 领域校验` 路径。因此“复用 k 个分块后的输出”与“从同样的 k 个分块结果重新生成”逐字段一致。

#### 8.4 预算跨 attempt 累计

`jobs` 新增 `model_calls` 列，表示**本 attempt** 已发起的 provider 调用数（含 repair 与瞬时网络重试）。Runner 在每次 provider 调用前同步写入；进程之后崩溃也不会漏算已经消耗的调用。

写入必须 fail closed：`updateJobModelCalls` 只在任务仍为 `running` 时成功，任务被 stale recovery 标为 `interrupted` 后会返回 `null`。Runner 必须把 `null` 或写入异常当成生成失败，在真正调用 provider 之前抛出；否则后续调用会绕过预算。此时任务已不是 `running`，不能再被改写成 `succeeded`，只保留 `interrupted` / `failed` 与脱敏错误；任务行的 `model_calls` 停在最后一次成功落库的调用数，与实际已发出的 provider 调用一致。

- 预检：`同一 run group 此前 attempt 的 model_calls 总和 + 本次预计剩余基础调用`（缺失的抽取 + 缺失的补抽 + 3 次全局调用）超过 `STORY_MAP_MAX_MODEL_CALLS` 时，在任何模型调用前 fail closed。
- 运行中：计数器从“此前 attempt 总和”起算，每次真实尝试先累加再检查；超过上限时沿用既有错误文案并立即失败。
- 后台 Runner 的预算以任务行为准，才能覆盖“调用已发生但结果尚未落检查点”的崩溃窗口；直接调用管线且未显式传入 `previousModelCalls` 时，回退到同 run group 检查点行 `model_calls` 之和。
- 检查点行的 `model_calls` 仍用于审计单阶段成本；任务行与检查点行不在同一次求和中重复计算。
- 预算只约束同一 run group。新的普通生成使用新 group，从 0 开始；默认重试不能通过新建任务行重置预算；只有用户显式选择 `fresh`（“从头重新生成”）才开启新 group 与新预算。

#### 8.5 进度展示

续跑时 `chunking` / `extract` / `glean` 进度额外携带 `reusedChunks`（抽取与补抽都已复用的分块数）。进度视图显示 `已复用 N/M 个分块`，其中 M 是总分块数；后续全局阶段不再重复显示。该字段只影响展示与 `JobProgress` 校验，不参与生成语义。

#### 8.6 显式 fresh 重启避免预算锁死

只按 run group 累计预算会带来一个死角：某个 Source 的重试一旦把该 group 的累计调用推到上限，后续每次 `resume` 都在预检阶段 fail closed，用户无法再生成这张地图。因此启动入口必须同时提供显式的 `fresh` 出口：

- 失败/中断界面默认主操作是“重试（复用已完成分块）”（`resume`），次操作是“从头重新生成”（`fresh`），并说明 fresh 会重跑每个分块、开启新的模型调用预算；
- 当失败原因就是预算耗尽时，错误文案替换为固定脱敏消息，界面把 fresh 提为主操作并明确说明继续重试会立即失败；
- `fresh` 不是“重试”的默认值：它丢弃所有已完成分块、重复付费，只用于用户明确要求从零开始或同一 run group 预算已耗尽的情况。

#### 8.7 明确不做的

- 不 checkpoint 人名 / 结局 / 合并等全局轮次：它们是一次性调用，复用的收益小于把全局中间态纳入不可变合同的成本；
- 不保存分块原文、Prompt 或 raw model output；
- 不为检查点提供 UPDATE、删除或“覆盖失败行”的接口；
- 不改变 Story Map Schema、merge 路径、Evidence 合同或失败脱敏。

## 备选方案

| 方案 | 没有采用的原因 |
| --- | --- |
| 继续同步 Server Action，只加进度流 | 刷新即丢失、重启后无法判断状态，仍受请求生命周期限制；没有解决 P0 的根本问题 |
| SSE / WebSocket 推送进度 | 需要长连接生命周期、重连和代理配置；当前 1 秒轮询已足够，且刷新恢复更简单 |
| BullMQ / pg-boss 等队列库 | 分别需要 Redis 或 PostgreSQL，引入新服务、新部署单元与运维成本；单进程 SQLite 已经能表达任务状态、心跳与单飞 |
| 在 `jobs` 中保存完整输入或模型输出 | 会把原文/私人分支写进任务历史，违反隐私边界；恢复只需要 Source ID，结果只需要 Artifact ID |
| 重试时重置同一个失败行 | 会覆盖历史、让“任务曾失败”不可追踪，也可能与旧回调竞争；追加新行是唯一安全语义 |
| 复用失败行或缓存整次生成的最终 Artifact | 失败行不可变；最终 Artifact 依赖全局轮次和当时模型，无法安全复用。只缓存已验证的分块阶段结果，并让全局轮次重跑，才能保持同一 merge 路径 |
| 只按 Source ID 复用检查点 | Source 不可变，但 Prompt、分块计划和模型都可能变化；key 必须覆盖全部决定输出的输入，否则会静默复用旧结果 |
| 用检查点行求和作为唯一预算来源 | 模型调用可能已完成但结果尚未写入检查点（崩溃窗口）；必须同时记录任务 attempt 的 `model_calls`，预算才能覆盖真实消耗 |
| 忽略预算写入返回的 `null` 继续调用 | 任务已被 stale recovery 标为 `interrupted` 时，后续调用不再计入任何 attempt，预算与审计都会失真；必须在 provider 调用前中止 |
| 按并发完成顺序记录检查点 run id | 分块并发的完成顺序不稳定，run id 列表会与分块/证据顺序错位；必须按分块序号记录 |
| 重试默认从头开始（fresh） | 会丢弃已验证分块、重复付费，也违背“重试只补缺失阶段”的目标；默认 `resume`，仅当用户明确选择或同一 group 预算耗尽时才 `fresh` |
| 预算耗尽后允许 resume 重置计数 | 会让“调用预算”不再可信，重试可以通过反复新建任务行无限调用模型；只允许显式 `fresh` 开启新 run group 与新预算 |

## Open-source preflight

检索日期：2026-10-17。本轮受任务约束不执行网络访问，也不复制第三方代码；结论完全基于仓库现有能力与已知的通用队列方案：

- 复用 NovelRipple 已有的 SQLite + Drizzle、Zod、Server Action、`after()` 和 Story Map 管线；没有新增依赖。
- 未采用 BullMQ（MIT，https://github.com/taskforcesh/bullmq，需要 Redis）与 pg-boss（MIT，https://github.com/timgit/pg-boss，需要 PostgreSQL）：它们解决的是多进程/分布式任务，本仓库当前没有该需求，引入成本高于收益。
- Next.js `after()` 是现有框架 API（MIT），用于在响应后继续执行；数据库仍是唯一事实源，任务状态不依赖进程内内存。
- Phase 2 收尾的分块检查点扩展继续复用 SQLite + Drizzle、Zod 和现有 `sha256` 工具；没有新增依赖、没有复制第三方代码，检查点表与索引沿用本仓库 drizzle 迁移约定。
- 新依赖：**none**。

## 后果

- 用户点击生成后立即看到阶段与分块计数；刷新页面继续显示，服务重启后看到 `interrupted` 和“重试”。
- 重试只重跑未完成的抽取/补抽分块；已完成阶段直接复用，进度显示 `已复用 N/M 个分块`。人名、结局、合并仍重跑，但调用数与之前 attempt 一起计入上限；超出时在任何越界调用前 fail closed。预算耗尽后，用户仍可通过“从头重新生成”显式开启新的 run group 与预算，Source 不会被永久锁死。
- 任务历史只追加，失败原因经过脱敏；Source、Artifact 和 Story Map 合同不变。
- 每个检查点绑定产生它的 Generation Run；重试复用的分块仍保留原始 run id，抽取/补抽 run id 列表按分块顺序而非并发完成顺序返回。
- 预算写入失败或被中断时不会再继续发出未计费调用；任务保持 `interrupted` / `failed`，不会因迟到回调变成 `succeeded`。
- 生成仍要求至少一个存活的 Node 进程执行 Runner。若未来改为多实例或 Serverless，需要把 Runner 移到独立 Worker/队列，并重新评估心跳与单飞；当前明确不支持该部署形态。
- 进度是辅助信息：写入失败不会中止已经开始的生成，但任务最终状态仍由 Artifact 写入成功决定。
