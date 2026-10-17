# 0007：场景节点树、路径状态与分段上下文组装

- 状态：Accepted
- 日期：2026-10-17
- 范围：P0 — Continuation 从“每条世界线一个场景”改为场景节点树；不改变 Source、Story Map、Impact Plan、Worldline Delta、Evidence 或 fail-closed 合同

## 背景

M0 / M1 的 Continuation 是线性合同：每条 Worldline 只有一个方向 Artifact 和一个场景，用户选定方向后不能更换，也没有重试兄弟节点。`selectContinuationContext` 只确定性挑选原著代表窗口与人物证据，硬上限 6000 字符且不超过 Source 的 25%；生成场景时没有最近场景正文、没有路径摘要、没有段级预算和“模型看到了什么”的清单。想继续第二幕只能修改世界线或另建世界线，生成内容无法沿路径累积。

P0 要在不改变不可变 Artifact、candidate-first、世界线隔离和 fail-closed 的前提下，让任一场景都能继续，允许重试本幕和换一批方向，并让每次模型调用只读取当前路径相关的材料。

## 决定

### 1. 场景节点树使用不可变 v2 Artifact

方向和场景仍是既有 `artifacts` 表中的 `continuation` 行，不新增表：

- 方向批次（`schemaVersion: 2`）记录 `parentSceneId`、`batchIndex` 与恰好三个方向；根批次 `parentSceneId: null`，`batchIndex` 从 0 递增。
- 场景节点（`schemaVersion: 2`）记录 `parentSceneId`、`depth`、`origin`（`generated` / `retry`）、`attemptIndex`、`summary` 与 `contextManifest`。根节点深度为 1，子节点深度为父节点加一。
- 任一场景都可以作为父节点继续。同一方向重试创建同父节点、同批次、同方向的新兄弟节点，`attemptIndex` 递增；「换一批」在同一父节点上创建 `batchIndex` 递增的新方向批次。旧批次和旧场景永不 UPDATE。
- ID 由内容身份确定性派生：方向批次为 `(worldlineId, parentSceneId ?? "root", batchIndex)`，方向为 `(batchId, index)`，场景为 `(directionsArtifactId, selectedDirectionId, attemptIndex)`。重复写入命中同一主键时幂等返回已有行。

### 2. 路径状态只沿根→当前节点折叠

accepted Impact Plan 确定性派生的 Delta 是 `baseDelta`；当前状态是 `baseDelta` 依次折叠根→当前节点路径上的每个 `statePatch`。折叠不读取兄弟分支、路径外场景或未来节点。路径必须属于同一 Worldline、父子链连续、深度逐级加一，否则 fail closed。因此“旧节点不可变”带来的结论是：改写旧内容只能创建兄弟节点，兄弟分支的状态永远不会互相污染。

### 3. 上下文按固定六段组装

素材按固定顺序进入 `<continuation_context>`：

1. `worldline_setup`；
2. `path_summary`；
3. `canon_evidence`（继续复用 `selectContinuationContext` 的 6000 字符 / Source 25% 上限）；
4. `recent_scenes`（最近 2 个场景正文）；
5. `selected_direction`；
6. `anchor_reminder`。

总素材预算由 `CONTINUATION_CONTEXT_MAX_CHARS` 控制，默认 24000 字符，按 UTF-16 字符数而非 token 计算。超预算时依次：从末尾整条丢弃 `canon_evidence` → 从最旧开始整条丢弃 `recent_scenes`（始终保留最新一个场景）→ 从开头截断 `path_summary`。`worldline_setup`、`anchor_reminder` 以及场景生成时的 `selected_direction` 永不裁剪；配置非法，或必需段与最新场景本身超预算时 fail closed。系统 Prompt 模板不计入该素材预算。

每次场景生成保存不含正文的 Context Manifest：只含段名、`included`、`chars`、`trimmed`、`droppedItemIds` 与预算计数。manifest 随场景 Artifact 保存，前端抽屉只展示段名、字数和丢弃项数量，不展示原文或生成正文。

### 4. 路径滚动摘要是确定性派生，不额外调用模型

`continuation-scene.v3` 顺带输出 ≤200 字的场景 `summary`，与场景一同不可变保存。组装上下文时沿根→当前节点构建滚动摘要：最近 2 个场景保留原文，更早的场景按旧→新写成摘要行；超过 1200 字符时从最旧一行开始省略并加省略提示，`watermarkSceneId` 记录最后一条被摘要覆盖的节点。摘要是纯函数派生，同一输入逐字节相同，不查询兄弟分支，也不需要单独的摘要表或缓存。

### 5. v1 保持可读，不做迁移

v1 方向没有父节点/批次字段，视为根批次 0；v1 场景没有树字段，归一化为根节点（`parentSceneId: null`、`depth: 1`、`origin: generated`、`attemptIndex: 0`、`summary: null`、`contextManifest: null`）。历史行保留原样并可作为根父节点；新生成只写 v2 方向、v2 场景和 v3 模型输出。

## 备选方案

| 方案 | 没有采用的原因 |
| --- | --- |
| 新建 `direction_batches` / `scene_nodes` / `path_summaries` 表并迁移 | 现有 `artifacts` 已拥有版本化、不可变、Generation Run 绑定和项目/世界线隔离；再建表会形成两套所有权与迁移脚本，还会复制 Artifact 解析和幂等逻辑。当前规模下按 Worldline 读取后在领域层构树足够，不引入数据库外键/索引的代价可以接受 |
| 在每个场景节点保存完整路径状态 | 同一状态会在祖先和后代重复存储，后续语义修正必须回填所有后代，容易漂移；也不比从不可变节点确定性折叠更可靠。当前折叠成本是有界的路径长度，先在需要时重算，只有真实性能数据证明瓶颈才考虑物化 |
| 用 token 而不是字符做预算 | 需要引入或维护 tokenizer，预算会随模型/供应商变化，领域层和测试也会耦合到具体模型；中文字符数已经能提供稳定的硬上限。若未来供应商 token 上限成为实际约束，再单独评估 token 预算与字符预算的双重上限 |
| 按段固定百分比配额（如 25% / 50%） | 当前先保证必需段和最近场景，再用统一字符预算做确定性裁剪；固定百分比会让短路径浪费预算、长证据段仍可能挤占最新场景。统一预算更简单，也更容易做“任意输入都不超预算”的性质测试 |

## 后果

- 旧方向和旧场景不被覆盖；继续、重试和换一批都产生新行，历史可回读。确定性 ID 让并发重复请求幂等，不产生重复批次或重复场景。
- 兄弟分支的状态与摘要互不可见；断裂父子链、跨世界线父节点、深度不连续或循环引用都在构树时 fail closed，不返回部分树。
- 上下文预算有硬上限，manifest 可审计且不泄露正文。代价是预算按字符近似 token，且没有按段配额：单个最新场景过大时可能挤掉全部 `canon_evidence`，甚至与必需段一起超预算而失败。这是有意的 fail-closed 取舍，不静默截断最新场景。
- 路径摘要不增加模型调用，但需要每个场景都产出 `summary`；v1 场景只有标题，摘要行会退化为标题，不会伪造旧场景摘要。
- v1 兼容只做读取归一化，不迁移历史行；v1 场景只能作为根节点，不能获得真实的祖先树。
- 当前 UI 默认沿首选分支（每层优先 `attemptIndex === 0`）走到叶子，兄弟用 `‹ 2/3 ›` 切换；“当前阅读位置”仍由客户端选择表达，尚未持久化 `headNodeId`。

## 不变的部分

- Source、Story Map、Impact Plan、Worldline 与 Worldline Delta 合同不变；Continuation 仍是 `generated` 内容，不能充当原著 Evidence。
- `selectContinuationContext` 继续拥有原著证据选择；6000 字符 / Source 25% 上限不变。
- 所有模型输出仍先经过 Zod Schema 与领域校验；一次 repair 后仍失败即 fail closed，不写入 Artifact。
- 不新增数据库表、迁移、运行时依赖或第二套上下文系统。

## 后续工作（P1）

1. **路径作用域设定条目**：Codex / lore entries 按 `name ∪ aliases` 命中，只读取分叉点之前与当前路径上的内容；`always` 条目进入必需段，场景 `characterChanges` 可转为以场景节点为锚的 progression。
2. **世界线树视图**：用 React Flow 等现有视图能力展示当前路径、已访问旁支、未选择的方向（幽灵节点）和结局标记；默认只展开当前路径与直接兄弟，大树用折叠/两档渲染，不预生成未选方向。
3. **书签与位置**：持久化命名书签和 `headNodeId`，支持“从这里重来”；基线 Story Map revision 变化时把旧世界线标成 stale，允许在旧版本只读继续或按新版本重开，不做自动迁移。
4. **流式生成**：场景生成改为可中止的流式请求，带 `requestKey` 丢弃过期回包；流式失败不得留下半提交场景，仍以完整 Schema 校验后的 Artifact 为唯一提交点。

## Open-source preflight

检索日期：2026-10-17。本次只记录仓库内已经落地的 P0，不新增依赖、不复制第三方代码。

- 复用 NovelRipple 已有的 Zod Schema、Drizzle/`artifacts` 存储、Generation Run、`selectContinuationContext`、`generateStructured` 与既有 fail-closed 校验；没有引入新的上下文框架或树组件。
- 设计对照来自外部研究 `reverse-engineering.md` 第 4.3、7 节对公开产品行为的观察（方向批次、retry 同位切换、固定段顺序、滚动摘要水位线）。只借鉴交互与数据模式，不复制代码、Prompt 或私有数据。
- 新依赖：**none**。
