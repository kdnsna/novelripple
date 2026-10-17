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
- 不新增或删除 review confirmations，因此 revision 能派生为“未精修”；
- 已经 confirmed 时幂等返回同一行；base 不是最新 revision 时仍报 stale 并 fail closed；
- 普通 `confirm_story_map` 路径和 readiness 门完全不变。

confirmed 之后的下游检查一行未改：Ripple Suggestions 生成器、Impact Plan 生成器、Impact Plan 仓库和 Worldline 创建仍显式检查 `storyMap.status === "confirmed"`。读者只是更早到达“已确认”，并没有绕过任何 confirmed 绑定。

### 2. “未精修”与“待核对”是纯派生 UI 状态

新增 `src/domain/review/derive-story-map-refinement.ts`。它接收当前 Artifact 和已有的 `deriveStoryMapReview` 结果：

- `quickConfirmed`：当前 confirmed revision 的 `review.operation.type` 为 `quick_confirm_story_map`；
- `needsRefinement`：`quickConfirmed` 且 readiness 尚未满足；
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
- 快速确认的 revision 如实记录“未精修”：operation 为 `quick_confirm_story_map`，confirmations 保持为空；界面可派生角标与横幅，后续修正仍创建新 revision。
- 下游 confirmed 检查、Source/Evidence 校验、不可变 Artifact、Worldline 隔离与 fail closed 全部保持不变。
- 自动建议生成会给每个没有 Suggestions 的 confirmed revision 增加一次模型调用；这是现有生成器的一次调用，不新增 Prompt 或并发路径。如果调用失败，用户仍可从时间线自己选事件继续。
- 读者文案与内部枚举分离；日志、Schema、API 与世界线记录仍使用 `strict` / `open`。
