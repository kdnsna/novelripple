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

### 3. 上下文按固定七段组装

素材按固定顺序进入 `<continuation_context>`：

1. `worldline_setup`；
2. `canon_events`（相关 Canon 事件、事件之间的边与 Anchor 目标结局）；
3. `path_summary`；
4. `canon_evidence`（相关事件证据在前，代表窗口/人物证据在后，后者继续复用 `selectContinuationContext` 的 6000 字符 / Source 25% 上限）；
5. `recent_scenes`（最近 2 个场景正文）；
6. `selected_direction`；
7. `anchor_reminder`。

总素材预算由 `CONTINUATION_CONTEXT_MAX_CHARS` 控制，默认 24000 字符，按 UTF-16 字符数而非 token 计算，只约束组装后的上下文素材，不包含约 2–3k 字符的系统 Prompt 模板。超预算时只沿一条固定降级阶梯前进。阶梯是单一嵌套序列，每一级只删除或严格缩短上一级的内容：完整内容 → 按 priority 从低到高丢弃 `canon_evidence`（同优先级从末尾，相关事件证据最后丢）→ 从最旧开始整条丢弃 `recent_scenes`（始终保留最新一个场景）→ 按整行从开头裁剪 `path_summary`（保留首行省略/压缩提示到最后一刻，不切半行）→ 用严格更短的紧凑 `worldline_setup` 整体替换 → 用最新场景自己的非空且严格更短的 `summary` 替换正文 → 最新场景没有可用摘要（v1）时在句末边界截断并追加 `（后文已截断）` → 仍超预算才 fail closed。结果是该预算下第一个放得下的状态：更大的预算只会停留在更早（或相同）的状态，绝不会丢掉更小预算已保留的证据或场景，也不会使用更小预算没有启用的降级。第 5—7 步（紧凑 `worldline_setup`、摘要替换、v1 截断）释放的预算**不回填**第 2 步丢弃的证据：跨层回填会把低优先级内容塞进更小预算的结果（大预算停留在第 3—4 步时证据为零，小预算却带着回填证据），破坏嵌套顺序；这些预算只用于让当前状态本身放得下。v1 截断不得落在未闭合引号内（`「」『』“”‘’` 与 ASCII 引号），不得拆开 `……`；句末后紧跟恰好闭合引号的闭引号时（如 `。」`、`。』」`、`……」`），在所有闭引号之后截断；若只有引号内句末可用，则在最外层开引号前截断；若最外层开引号就在正文开头（整段都在引号内）或没有安全非空前缀，则 fail closed。不会因为“完整形式的必需段放不下”提前启用紧凑形式；紧凑形式只出现在阶梯第 5 步。`worldline_setup`、`canon_events`、`anchor_reminder` 以及场景生成时的 `selected_direction` 永不整段裁剪（`worldline_setup` 只允许整体替换为更紧凑的等价形式）。

每次场景生成保存不含正文的 Context Manifest：只含段名、`included`、`chars`、`trimmed`、`droppedItemIds`、`budget` 计数，以及 `path_summary` 的 `coveredItemIds` / `watermarkId`（只含场景 id）。`recent_scenes` 另用 `summarizedItemIds` 记录用自身摘要替换正文的最新场景 id，用 `truncatedItemIds` 记录 v1 正文被截断的场景 id；两者都不再计入 `droppedItemIds`。`canon_evidence` 的 `backfilledItemIds` 只为本分支期间可能已存的旧 manifest 保留为可选只读字段；新 manifest 不再写入（不做跨层证据回填），被丢弃的证据只出现在 `droppedItemIds`。`worldline_setup` 启用紧凑形式时用 `compactedFields` 记录被移除的字段名（只含字段名，不含正文）。manifest 随场景 Artifact 保存，前端抽屉只展示段名、字数和丢弃项数量，不展示原文或生成正文。

### 4. 路径滚动摘要是确定性派生，不额外调用模型

`continuation-scene.v4` 顺带输出 ≤200 字的场景 `summary`，与场景一同不可变保存。组装上下文时沿根→当前节点构建滚动摘要：最近 2 个场景保留原文，更早的场景按旧→新写成摘要行；超过 1200 字符时保留最新若干行原文，把更早的场景压缩成一行 `更早剧情（第 a–b 幕）：` + 场景标题（按整条标题截断）。压缩行放不下全部标题时保留最靠近剩余全文行的最近若干条、丢弃更早标题，标记写实际显示范围 `第 a–b 幕`；`coveredSceneIds` / `watermarkSceneId` 只覆盖实际显示的压缩场景与保留的全文行。摘要是纯函数派生，同一输入逐字节相同，不查询兄弟分支，也不需要单独的摘要表或缓存。

### 5. v3 上下文与 v2 Prompt packet 的差异

v2 packet 的字段去向：

- `readonlyCanonical` → `canon_events`，字段不变：`sourceId`、`storyMapArtifactId`、`storyMapId`、`characters`、相关事件的 id/title/summary/sequence/participants/stateChanges、事件之间的 edges、Anchor 目标 endingCandidates。
- `relevantEvidence` → `canon_evidence` 的前半部分，id 为 `related:<eventId>:<n>`；相关事件证据优先级最高，裁剪时最后丢弃。
- `styleContext.representativeExcerpts` / `styleContext.characterEvidence` → `canon_evidence` 的后半部分，仍由 `selectContinuationContext` 选择，先于相关事件证据被裁剪。
- `currentWorldline` + `divergence` + `acceptedImpactPlan` + `currentState` → `worldline_setup`：世界线 id/mode、Divergence、anchors、Story Map id/title/logline、人物 id/name/aliases/role、accepted Impact Plan 的 id/mode/divergence/impacts 摘要/characterChanges/threadChanges/anchorEvaluations/uncertainties、当前路径状态。完整 worldline 行不再发送；省略的是数据库/审计字段（`parentWorldlineId`、`baseStoryMapArtifactId`、`acceptedImpactPlanId`、`idempotencyKey`、`createdAt`、`status` 等），不影响生成语义。
- `stage` 由 Prompt 版本承担；`selectedDirection` 仍是 `selected_direction`。
- 新增：`path_summary`、`recent_scenes`、`anchor_reminder`、Context Manifest 与段级字符预算。

`canon_events`、相关事件证据、边、Anchor 目标结局与 accepted Impact Plan 均未删除；v3 只是把原来混在一个 JSON 里的内容拆成固定顺序、可裁剪、可审计的段。

### 6. v1 保持可读，不做迁移

v1 方向没有父节点/批次字段，视为根批次 0；v1 场景没有树字段，归一化为根节点（`parentSceneId: null`、`depth: 1`、`origin: generated`、`attemptIndex: 0`、`summary: null`、`contextManifest: null`）。历史行保留原样并可作为根父节点；新生成只写 v2 方向、v2 场景和 v3 模型输出。

## 备选方案

| 方案 | 没有采用的原因 |
| --- | --- |
| 新建 `direction_batches` / `scene_nodes` / `path_summaries` 表并迁移 | 现有 `artifacts` 已拥有版本化、不可变、Generation Run 绑定和项目/世界线隔离；再建表会形成两套所有权与迁移脚本，还会复制 Artifact 解析和幂等逻辑。当前规模下按 Worldline 读取后在领域层构树足够，不引入数据库外键/索引的代价可以接受 |
| 在每个场景节点保存完整路径状态 | 同一状态会在祖先和后代重复存储，后续语义修正必须回填所有后代，容易漂移；也不比从不可变节点确定性折叠更可靠。当前折叠成本是有界的路径长度，先在需要时重算，只有真实性能数据证明瓶颈才考虑物化 |
| 用 token 而不是字符做预算 | 需要引入或维护 tokenizer，预算会随模型/供应商变化，领域层和测试也会耦合到具体模型；中文字符数已经能提供稳定的硬上限。若未来供应商 token 上限成为实际约束，再单独评估 token 预算与字符预算的双重上限 |
| 按段固定百分比配额（如 25% / 50%） | 当前先保证必需段和最近场景，再用统一字符预算做确定性裁剪；固定百分比会让短路径浪费预算、长证据段仍可能挤占最新场景。统一预算更简单，也更容易做“任意输入都不超预算”的性质测试 |
| 降级释放预算后回填证据 | 阶梯会因此不再是嵌套序列：大预算停在“丢场景但保留完整设定”时证据为零，小预算却能靠紧凑设定回填证据，出现“预算更大、内容更少”。回填还会让同一预算的结果依赖后续降级是否发生，难以解释和测试；所以释放的预算只用于让当前状态本身放得下 |

## 后果

- 旧方向和旧场景不被覆盖；继续、重试和换一批都产生新行，历史可回读。确定性 ID 让并发重复请求幂等，不产生重复批次或重复场景；同一进程内按目标 Artifact id 的 in-flight 锁让并发同内容请求只调用一次模型。
- 兄弟分支的状态与摘要互不可见；断裂父子链、跨世界线父节点、深度不连续或循环引用都在构树时 fail closed，不返回部分树。
- 上下文预算有硬上限，manifest 可审计且不泄露正文。代价是预算按字符近似 token，且没有按段配额：降级按固定阶梯进行，先丢证据、旧场景和摘要行，再启用紧凑 `currentState`，最后才用最新场景摘要或 v1 正文截断兜底；只有最后一级仍超预算才 fail closed。降级释放的预算不回填证据，这是刻意取舍：保证预算单调（更大预算绝不保留更少内容）比在大预算下多塞几条低优先级证据更重要。v1 正文只在安全句末边界截断并标记 `（后文已截断）`，不会切进未闭合引号、半个省略号或整段都在引号内的正文。
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
