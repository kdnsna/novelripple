# 0008：可恢复的后台 Story Map 生成任务与轮询进度

- 状态：Accepted
- 日期：2026-10-17
- 范围：P0 — Story Map 生成从 60–80 秒同步 Server Action 改为 SQLite 持久化的可恢复后台任务；不改变 Source、Story Map Artifact、Evidence、候选先于提交或 fail-closed 合同

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
| `input_json` | 只含稳定 ID（当前为 `{ "sourceId": ... }`），绝不保存原文 |
| `status` | `queued` / `running` / `succeeded` / `failed` / `interrupted` |
| `progress_json` | `{ stage, completed, total }`；`stage` 是固定枚举，不含正文 |
| `result_json` | 成功时 `{ artifactId }` |
| `error` | 只保存经过脱敏的短消息，不保存 Prompt、模型输出或原文 |
| `created_at` / `updated_at` / `heartbeat_at` | ISO 时间；心跳用于恢复判断 |

Zod 行 Schema 位于 `src/domain/schemas/job.ts`，Repository 位于 `src/server/repositories/job-repository.ts`。任务行是追加式历史：状态可以沿 `queued → running → succeeded|failed` 前进，但重试永远插入新行，不复活或复用失败行。迁移只新增表，不改写已有数据。

### 2. 单飞与后台 Runner

`startStoryMapGenerationJob(projectId, sourceId)` 在同一个 project + kind + source 下先查 `queued`/`running` 任务；存在则直接返回它，不创建第二行，也不启动第二个 Runner。Server Action 只在新建任务时用 Next.js `after()` 调度 `runStoryMapGenerationJob`，因此响应不等待模型；`after()` 在 Node 自托管与本地开发中继续执行到完成。

Runner 用条件更新认领任务（只有 `queued` 能变成 `running`），每 15 秒刷新一次心跳；管线每进入一个阶段或完成一个分块就写入进度。成功时写入 `result.artifactId`，失败时用 `storyMapGenerationErrorMessage` 脱敏后写入 `error`。所有状态更新都带当前状态条件，避免中断后又被迟到的回调覆盖。

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

服务端页面在首次渲染时读取该 Source 的最新任务，刷新后仍显示同一进度。客户端组件在 `queued`/`running` 时每 1 秒请求 `GET /api/jobs/[jobId]`，成功后刷新到 `?artifact=<id>&generated=created`，与旧同步流程最终展示完全一致。

轮询的代价是每秒一个很小的本地 SQLite 读取，但收益是：无需长连接管理、无需处理 SSE 重连与代理缓冲、页面刷新天然恢复，且现有 Next.js/SQLite 单进程部署不需要新基础设施。SSE 只在真实并发与实时性需求证明不足时再评估。

### 6. 读侧只暴露脱敏视图

`src/server/jobs/job-view.ts` 只保留 `id`、`status`、`progress`、`result`、`error`。API 不返回 `input`、心跳、Prompt、模型输出或原文；错误在写入前已经过统一脱敏函数，未知异常只会得到固定文案。`JobIdSchema` 先校验路径参数，非法 ID 返回 400，未知 ID 返回 404。

### 7. 明确不做的

- 不新增队列库、Redis、Worker 进程或第二个数据存储；
- 不实现跨进程锁或分布式调度；当前产品是本地/单 Node 进程工具，单飞在进程内完成；
- 不改 Story Map Schema、Prompt、Evidence 解析或 Artifact 写入路径；
- 不为历史同步调用保留兼容双轨。

## 备选方案

| 方案 | 没有采用的原因 |
| --- | --- |
| 继续同步 Server Action，只加进度流 | 刷新即丢失、重启后无法判断状态，仍受请求生命周期限制；没有解决 P0 的根本问题 |
| SSE / WebSocket 推送进度 | 需要长连接生命周期、重连和代理配置；当前 1 秒轮询已足够，且刷新恢复更简单 |
| BullMQ / pg-boss 等队列库 | 分别需要 Redis 或 PostgreSQL，引入新服务、新部署单元与运维成本；单进程 SQLite 已经能表达任务状态、心跳与单飞 |
| 在 `jobs` 中保存完整输入或模型输出 | 会把原文/私人分支写进任务历史，违反隐私边界；恢复只需要 Source ID，结果只需要 Artifact ID |
| 重试时重置同一个失败行 | 会覆盖历史、让“任务曾失败”不可追踪，也可能与旧回调竞争；追加新行是唯一安全语义 |

## Open-source preflight

检索日期：2026-10-17。本轮受任务约束不执行网络访问，也不复制第三方代码；结论完全基于仓库现有能力与已知的通用队列方案：

- 复用 NovelRipple 已有的 SQLite + Drizzle、Zod、Server Action、`after()` 和 Story Map 管线；没有新增依赖。
- 未采用 BullMQ（MIT，https://github.com/taskforcesh/bullmq，需要 Redis）与 pg-boss（MIT，https://github.com/timgit/pg-boss，需要 PostgreSQL）：它们解决的是多进程/分布式任务，本仓库当前没有该需求，引入成本高于收益。
- Next.js `after()` 是现有框架 API（MIT），用于在响应后继续执行；数据库仍是唯一事实源，任务状态不依赖进程内内存。
- 新依赖：**none**。

## 后果

- 用户点击生成后立即看到阶段与分块计数；刷新页面继续显示，服务重启后看到 `interrupted` 和“重试”。
- 任务历史只追加，失败原因经过脱敏；Source、Artifact 和 Story Map 合同不变。
- 生成仍要求至少一个存活的 Node 进程执行 Runner。若未来改为多实例或 Serverless，需要把 Runner 移到独立 Worker/队列，并重新评估心跳与单飞；当前明确不支持该部署形态。
- 进度是辅助信息：写入失败不会中止已经开始的生成，但任务最终状态仍由 Artifact 写入成功决定。
