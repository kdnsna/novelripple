# 0012：连续阅读（持久化 head 与书签）与按路径人物状态

- 状态：Accepted
- 日期：2026-10-18
- 范围：P1 / I2 收尾 — 持久化阅读游标、命名书签，并让 Continuation 场景显式记录人物在路径上的运行状态；不改变 Source、Story Map、Impact Plan、Worldline Delta、Evidence、生成上下文或 fail-closed 合同

## 背景

0007 已把续写建模为不可变场景节点树，并留下 P1“书签与位置”事项；0010 交付了只读树与任意节点重开，但 `ReadingPosition` 只存在于客户端，刷新后回到默认路径，也没有命名书签。另一方面，路径状态能折叠人物 summary，却无法区分“故事地图中的角色功能”和“该世界线路径上人物现在是否在世/在场”。I2 剩余工作要在不改变生成上下文、提取管线或评分器的前提下补齐这两块读者体验。

## 决定

### 1. 人物路径状态与 Character.role 分离

`Character.role` 仍是 Story Map 的叙事功能（`protagonist` / `antagonist` / `supporting` / `minor` / `deceased`），只用于地图浏览与提取定向，不随分支变化，也不迁移旧 Story Map。

分歧后某条路径上的运行时状态由 `CharacterChangeSchema` 新增的可选 `status` 表示：

```text
alive | dead | absent | unknown
```

- `characterId` 与 `summary` 仍必填；旧 Artifact 没有 `status` 仍可解析。
- 折叠顺序与路径状态一致：`baseDelta`（accepted Impact Plan 的 `characterChanges`）在前，根→当前节点的每个 `statePatch.characterChanges` 按路径顺序在后。
- 同一人物最后一条**显式** `status` 生效；只写 summary、没有 status 的变化不会清空更早状态。整条路径从未出现 status 时 `currentStatus = null`，**不从 `Character.role` 推断**。
- 仅沿当前路径折叠；兄弟分支、路径外场景或未来节点不参与，沿用 `derivePathState` 的跨世界线/断裂父子链/深度校验。
- `PathCharacterState` 增加 `currentStatus`，历史条目在显式状态时附带 `status`；界面显示「在世 / 已故 / 不在场 / 未知」角标，未设置时不显示。

Continuation 场景 Prompt 升级为 `continuation-scene.v6`（保留 v5）：当本场景改变人物生死或是否在场时，`statePatch.characterChanges[]` SHOULD 显式包含 `status`，每人最多一条，状态未变时省略。方向 Prompt、Story Map Prompt、Impact Plan Prompt 不变；不从角色文本自动推断或回填状态。

### 2. `headNodeId` 是阅读游标，不是叙事 Artifact

迁移 `0012_worldline_reading_position.sql` 给 `worldlines` 增加可空 `head_node_id`：

- `null` 表示默认路径（与迁移前行为一致；也用于分歧点/根路径）；旧行迁移后保持 `null`。
- 非空必须是该 Worldline 上真实存在的 Continuation 场景 Artifact id；仓储写入前用 `getContinuationArtifact` 校验项目、世界线与 `artifactType === "scene"`，失败即 fail closed。
- 这是 Artifact/revision 不可变合同之外唯一允许 UPDATE 的指针列；它不参与 Delta、路径状态、摘要或生成上下文，也不产生 Generation Run。
- 不建到 `artifacts` 的外键，避免循环/删除语义耦合；由仓储层做领域校验。

`WorldlineSchema` 增加 `headNodeId: string | null`（缺省 `null`）；canonical 世界线没有场景，因此只能为 `null`。纯 helper `readingPositionFromHead` / `headNodeIdFromReadingPosition` 负责与客户端 `ReadingPosition` 互转，`assertHeadOnTree` 对未知节点抛错。

### 3. 命名书签

新增表 `worldline_bookmarks`：`id`、`worldline_id`（FK cascade）、`scene_node_id`（可空，null 表示分歧点/根路径）、`name`、`created_at`；`(worldline_id, name)` 唯一，`worldline_id` 建索引。`scene_node_id` 与 head 使用同一校验，不建 artifacts 外键。

- 名称写入前做 NFC + trim，按存储文本检查 1–40 字符；同名书签 fail closed。
- 创建、列表、删除都是阅读游标操作，不写 Artifact、不写路径状态、不调用模型。
- 删除未知 id 或不属于该 Worldline 的书签 fail closed；Worldline 删除时级联清理书签。

### 4. 服务端与界面

在 `actions.ts` 末尾追加 `setWorldlineHeadAction`、`createWorldlineBookmarkAction`、`deleteWorldlineBookmarkAction`，全部先做 Zod 解析，返回 typed result；不改既有 setting-delta / canon action。读取位置与书签由页面服务端加载，刷新后恢复。

续写面板：

- 初始 `ReadingPosition` 从 `worldline.headNodeId` 恢复；head 失效时显示错误并回退到默认路径，**不静默改写**数据库。
- 移动阅读位置、选择兄弟节点、重开任意树节点、生成并选中新场景后，按提交顺序串行调用 `setWorldlineHeadAction`；服务端最后落库的是最后一次点击。
- 书签区提供名称输入、“加书签”、列表与“跳转 / 删除”；跳转复用同一 `ReadingPosition` 路径并持久化 head。
- 生成与上下文组装完全不变；head 与书签不进入 Prompt。

### 5. 测试与文档

单测覆盖状态折叠顺序、缺失 status → `null`、兄弟分支隔离、四种中文标签、head ↔ ReadingPosition 映射、canonical head 约束、书签名规范化与重复/未知 id fail closed。E2E 覆盖生成场景后刷新仍停在 head、创建书签、跳走再跳回。文档更新 `docs/domain.md`、0007 / 0010 后续工作、CHANGELOG。

## 备选方案

| 方案 | 没有采用的原因 |
| --- | --- |
| 从 `Character.role === "deceased"` 自动生成路径状态 | 角色功能是 Story Map 的静态叙事描述，不等于某条分支的运行时状态；自动推断会伪造分支事实，也无法表达 absent/unknown。 |
| 把 status 写进 `Character` 或 Story Map revision | 会让同一状态被所有世界线共享，违反世界线隔离；Story Map 已确认版本不可变，也不应因阅读路径变化而重写。 |
| 每条路径保存完整人物状态快照 | 与路径状态相同的信息在祖先/后代重复存储，修正时需回填所有后代且容易漂移；沿不可变节点折叠已足够。 |
| 为 head/bookmarks 新建成独立“进度服务”或事件表 | 当前是本地单用户、单存储，两个指针列加一张小表已覆盖需求；引入服务/事件流会增加部署与一致性成本。 |
| 给 `head_node_id` 建 artifacts 外键 | 会造成 artifacts/worldlines 的循环引用与删除顺序耦合；仓储校验已经能 fail closed。 |
| 用 URL 深链代替持久化 head | 只能恢复单个链接，不能表达“最近阅读位置”；书签也需要跨刷新可读。 |

## 后果

- 刷新或重新进入 Worldline 后回到最近阅读场景；命名书签可跨刷新跳转，删除书签不影响任何场景。
- head/bookmark 是少数可 UPDATE 的阅读游标，但叙事 Artifact、路径状态和生成上下文仍只追加/确定性派生。
- 人物状态只在当前路径成立；`role` 保持 Story Map 语义，不会因分支事件被写回或迁移。
- 状态缺失仍合法：模型不写 `status` 时保留此前显式状态；整条路径都没有状态时界面不显示角标，不猜测。
- 旧数据无需迁移：`head_node_id` 为 null，书签表为空；旧 `characterChanges` 没有 status 仍可解析。

### 已知限制

- 书签没有重命名；改名等于删除后新建。
- 状态只来自 Impact Plan / 场景 `characterChanges` 的显式字段；不从正文语义推断，也不校验 model 是否在正文里兑现该状态。
- head/bookmark 没有版本历史；它们被设计成可覆盖的阅读游标，而不是可审计叙事行。
- head 失效时只提示并回退，不自动清空；需要用户再次移动位置才会写入新值。

## 不变的部分

- Source、Story Map、Impact Plan、Worldline Delta、Evidence 与 Continuation 生成合同不变。
- Artifact / revision 只追加不 UPDATE；head/bookmark 不是 Artifact。
- 世界线隔离、candidate-first、fail-closed 和确定性纯函数约束不变。
- 上下文段顺序、预算降级阶梯、`selectContinuationContext`、提取 Prompt 与评分器不变。

## Open-source preflight

检索日期：2026-10-18。本次不执行网络访问、不下载或复制第三方代码，也不新增依赖。

- 复用仓库已有的 Zod、Drizzle/SQLite、Next Server Actions、`ReadingPosition` / `derivePathCharacterTimeline` 与既有测试设施；没有引入日程、书签或状态管理库。
- 设计只借鉴公开产品“按路线记录人物状态、持续阅读位置”的交互模式，未复制代码、Prompt 或私有数据。
- 新依赖：**none**。
