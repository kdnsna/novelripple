# 0010：世界线树视图、任意节点重开与路径状态

- 状态：Accepted
- 日期：2026-10-18
- 范围：P1 / I2 — Continuation 面板改为只读世界线树大纲，任意节点可重开，并按当前路径展示 Delta 与人物状态；不改变 Source、Story Map、Impact Plan、Worldline、Continuation 生成合同、Prompt、Schema、数据库或上下文预算

## 背景

0007 已把续写建模为不可变场景节点树：方向批次记录 `parentSceneId` / `batchIndex`，场景节点记录父节点、深度、`origin` / `attemptIndex` 与摘要，路径状态沿根→当前节点折叠。但阅读层仍只有一条“首选分支 + `selectedSceneId`”的客户端视图：用户看不到旁支与未选择的方向，也不能从路径中间重开；面板只展示 accepted Impact Plan 派生的基础 Delta，人物状态不随路径变化。I2 要在不增加模型调用、不改变生成上下文的前提下，让读者看见自己走过的树、从任意节点重开，并读到该路径上的状态。

## 决定

### 1. 用 `ReadingPosition` 表达阅读位置

新增纯类型 `ReadingPosition`：

```ts
type ReadingPosition =
  | { kind: "default" }
  | { kind: "root" }
  | { kind: "scene"; sceneId: string };
```

`resolveReadingPath(tree, position)` 是唯一解析入口：`default` 保留旧行为，每层优先 `attemptIndex === 0` 的节点，否则取最早的兄弟；`root` 返回空路径，表示分歧点；`scene` 通过 `getScenePath` 返回根→该节点的完整路径，未知节点 id 与 `getScenePath` 一样 fail closed。阅读位置只是客户端状态，不写数据库、URL 或 Artifact；刷新后回到 `default`。

### 2. `buildWorldlineTreeOutline` 生成只读大纲

`buildWorldlineTreeOutline({ tree, directionBatches, currentPath, expandedIds? })` 按先序输出 `WorldlineTreeRow[]`：

- 根行 `id: null`、`level: 0`、标题“分歧点”，场景行 `level = depth`；根行没有 `origin` / `attemptIndex`（统一为 `null`），兄弟字段固定为 `0/1`。
- 每行带标题、深度、`origin` / `attemptIndex`、兄弟下标/数量、子节点数量、未选方向数量、是否在当前路径、是否当前节点、是否展开、是否有子节点。折叠行仍报告 `childCount`，只是不输出子行。
- 默认展开集合是“分歧点 + 当前路径上的全部节点”。显式传入 `expandedIds` 时只在该次调用中替换默认集合；界面把展开集合保存在组件状态，位置变化时用 `expandTreeIdsForPath` 只并入新路径（并始终重新加入根），从不删除用户手动展开的节点。
- 只读取给定的 tree、方向批次与 `currentPath`；`currentPath` 必须与 tree 中该节点的真实路径一致，否则 fail closed，不返回半棵树。

### 3. 角标复用不可变节点，不伪造幽灵节点

`worldlineTreeRowBadges` 以固定顺序输出：

- `重试`：节点的 `origin` 为 `retry`；
- `版本 i/n`：同一父节点下的兄弟数大于 1 时显示，`i` 从 1 开始；
- `+k 个未选方向`：`k > 0` 时显示。`k` 按父节点统计全部已存在方向批次中尚未被任何子场景选择的方向（幽灵方向），同一 `(batchId, directionId)` 只计一次，因此同一方向多次重试只算一次。未选方向只作为角标与方向列表出现，不生成幽灵场景节点，也不预生成内容。

`listDirectionOptions` 按 `batchIndex`、`createdAt`、`id` 升序列出某个父节点的全部方向批次，并附带每个方向已经生成的 `sceneIds`；`latestBatchForParent` 用同一排序返回该父节点的最新批次。两者都是纯函数，供“已生成 n 版”“再写一版”“选择此方向”的状态判断。

### 4. 任意节点重开只读取、只追加

点击树中的任意行（包括分歧点）会改变 `ReadingPosition`：当前路径只显示根→该节点，`activeBatchId` 被清空，展开集合并入新路径。方向区只为当前节点选批次：`activeBatchId` 只有在仍属于当前节点时生效，否则回退到该节点的最新批次，因此上一个节点的批次不会串到新路径上。节点没有方向批次时显示“继续”以请求方向；已有批次时“换一批”在同一父节点上创建新的 `batchIndex`。

当前批次内每个方向：

- 尚未生成场景时显示“选择此方向”，走既有场景生成 action；
- 已有生成场景时显示“查看已生成（n 版）”，跳到该批次该方向的第一条生成场景；同时显示“再写一版”，走既有的 `retry: true` 路径，创建同父节点、同批次、同方向、`attemptIndex` 递增的兄弟场景。

重开本身不写任何行；只有用户显式选择方向、再写一版或换一批才调用既有生成 action。旧场景与旧批次永不 UPDATE，新内容一律是新行，因此新分支不会覆盖原路径。

### 5. 路径 Delta 与人物状态按当前路径派生

- `baseDelta` 仍由 `deriveWorldlineDelta` 从 Worldline + accepted Impact Plan + Story Map 确定性派生；`derivePathState(baseDelta, currentPath)` 只沿根→当前节点折叠 `statePatch`，复用既有的跨世界线、断裂父子链、深度不连续与补丁校验，兄弟分支与路径外场景不参与。
- 新增 `derivePathCharacterTimeline({ baseDelta, path, characters })`。它先调用 `derivePathState` 复用同一套 fail-closed 校验，再按路径顺序收集人物变化：分歧点条目来自 `baseDelta.characterChanges`（即 accepted Impact Plan 的 `characterChanges`），场景条目来自每个节点 `statePatch.characterChanges`。每个人物的 `current` 直接取最终 `derivePathState` 的 `characterChanges`，因此与路径状态一致；输入中未出现的人物按 id 作为名称排在已知人物之后。
- 面板把 `baseDelta`、`pathState` 与人物时间线放在同一次派生里；任一步失败就整体显示错误，不展示半份 Delta 或人物状态。

### 6. 生成上下文不变

树视图与重开只改变读者看到的内容。方向/场景生成仍以父场景 id、方向 Artifact 与所选方向为输入，服务端照旧从父场景重建当前路径；`worldline_setup` 已经携带路径折叠后的当前状态，`recent_scenes` 与 `path_summary` 也仍只读当前路径。没有新增 Prompt、Schema、数据库迁移或上下文阶梯改动，树渲染本身不调用模型，也不产生 Generation Run。

## 备选方案

| 方案 | 没有采用的原因 |
| --- | --- |
| React Flow（`@xyflow/react`，已是依赖，用于 Story Map 画布） | 续写侧栏很窄；图布局、缩放与拖拽对“读路径、展开节点”是多余交互，还需要额外的画布生命周期与布局状态。大纲 `<ul role="tree">` 更简单，也更容易支持键盘与屏幕阅读器 |
| react-arborist（MIT） | 拖拽、重命名、多选与虚拟列表都不是当前需求，且需要 `react-dnd` 等 peer dependencies；包体和 API 面大于当前约百行的渲染代码 |
| react-complex-tree / Headless Tree（MIT，零依赖） | 许可证可接受且零依赖，但为当前约百行的大纲渲染新增运行时依赖，收益不足；先复用语义化列表与既有组件状态，等树规模或交互真正变复杂再评估 |
| 为未选方向生成幽灵场景节点 | 会把“尚未生成”的方向伪装成场景，等于预生成或伪造内容，违反 candidate-first 与不可变 Artifact；改为角标与方向列表表达即可 |
| 持久化 `headNodeId` | 需要数据库迁移、服务端读取与 URL/恢复语义；本轮先把阅读位置明确为客户端状态，刷新回到默认路径，持久化与命名书签留到后续 |

## 后果

- 树、路径 Delta 与人物时间线都是确定性派生；展开、切换阅读位置与重开不写库、不调用模型，也不会改变任何既有 Artifact 或 Worldline。
- 任意节点重开、再写一版与换一批都只追加新行；旧场景仍可从树中回读，兄弟场景继续沿用 `‹ i/n ›` 导航。
- 路径 Delta 与人物状态只在当前路径上成立：兄弟分支、路径外场景与未来节点不会被读取，跨世界线或断裂路径 fail closed。
- 失败是整体失败：未知节点、路径不一致或补丁非法时显示错误，不展示部分 Delta 或部分人物状态。

### 已知限制

- 阅读位置只存在于客户端；刷新后回到默认路径，目前没有 URL 深链或跨设备恢复。持久化 `headNodeId` 与命名书签仍未实现。
- 树显示展开父节点下的全部节点，没有虚拟化；几十个节点足够，节点数达到数百时需要折叠策略或虚拟列表。
- 未选方向只统计已经存在的方向批次；没有批次的节点不会显示未来可能的方向，也不会预生成。
- 沿路径生效的设定增量（Novelcrafter Progression 式）不在本次范围内；当前只展示既有 `statePatch` 派生的事实、线索与人物变化，设定增量留给后续 PR。
- 角标按全部批次统计未选方向，而方向区只展示该节点最新批次；两者数量可能不同，旧批次目前没有独立切换入口。

## 不变的部分

- Source 不可变、candidate-first、Artifact / revision 只追加不 UPDATE；重开、重试与换一批不会覆盖任何旧行。
- 世界线隔离不变：所有派生只读当前 Worldline 的当前路径，兄弟分支的状态、摘要与场景互不可见。
- `selectContinuationContext`、上下文七段顺序、`CONTINUATION_CONTEXT_MAX_CHARS` 降级阶梯、Prompt、Schema、Generation Run 与数据库结构均不变。
- 失败仍然 fail closed：未知节点、非法路径或不合法补丁不会产生部分树、部分 Delta 或半提交内容。

## 后续工作

1. **持久化阅读位置与书签**：保存 `headNodeId` 与命名书签，刷新或换设备后可恢复；需要迁移与服务端读取，沿用 0007 P1 第 3 项。
2. **路径作用域设定增量**：按代码/设定条目的 `name ∪ aliases` 命中，只读取分叉前与当前路径上的内容，并允许场景 `characterChanges` 转成以场景节点为锚的 progression；仍沿用 0007 P1 第 1 项。
3. **大树与批次切换**：真实数据证明需要时再评估树虚拟化、两档渲染与旧批次切换；不为假想规模提前引入图库或复杂状态。
4. **阅读位置持久化的语义收口**：Story Map revision 变化时如何标记旧世界线 stale、旧版本只读继续或按新版本重开，仍在 0007 P1 第 3 项范围内，本次不处理。

## Open-source preflight

检索日期：2026-10-18。本轮受任务约束不执行网络访问，也不下载或复制第三方代码；以下候选的许可证与主要依赖成本按官方仓库公开信息记录，采用与否基于当前窄侧栏大纲的实际需要：

- [react-arborist](https://github.com/jameskerr/react-arborist)：MIT；需要 `react-dnd` 等 peer dependencies，拖拽/重命名超出当前需求，不采用。
- [react-complex-tree](https://github.com/lukasbach/react-complex-tree)：MIT；零依赖，但为当前约百行大纲渲染新增依赖不划算，不采用。
- [Headless Tree](https://github.com/lukasbach/headless-tree)：MIT；同样零依赖，能力超过当前所需，不采用。
- [@xyflow/react](https://github.com/xyflow/xyflow)：MIT；仓库已有依赖，仅用于 Story Map 画布，不用于窄侧栏的线性大纲。
- 决定：复用现有 React、语义化 `<ul role="tree">` 与仓库内纯派生函数，不复制第三方代码。

新依赖：**none**。
