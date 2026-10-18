# 0012：连续阅读（持久化 head 与书签）与按路径人物状态

- 状态：Accepted
- 日期：2026-10-18
- 范围：P1 / I2 收尾 — 持久化阅读游标、命名书签，并让 Continuation 场景显式记录人物在路径上的运行状态；不改变 Source、Story Map、Impact Plan、Worldline Delta、Evidence 或 Continuation 生成合同

## 背景

0007 已把续写建模为不可变场景节点树，并留下 P1“书签与位置”事项；0010 交付了只读树与任意节点重开，但 `ReadingPosition` 只存在于客户端，刷新后回到默认路径，也没有命名书签。另一方面，路径状态能折叠人物 summary，却无法区分“故事地图中的角色功能”和“该世界线路径上人物现在是否在世/在场”。I2 剩余工作要在不改变生成上下文、提取管线或评分器的前提下补齐这两块读者体验。

## 决定

### 1. 人物路径状态与 Character.role 分离

`Character.role` 仍是 Story Map 的叙事功能（`protagonist` / `antagonist` / `supporting` / `minor` / `deceased`），只用于地图浏览与提取定向，不随分支变化，也不迁移旧 Story Map。

分歧后某条路径上的运行时状态只存在于场景输出与路径折叠：

```text
alive | dead | absent | unknown
```

- `CharacterChangeSchema` 保持 Impact Plan 的严格合同：只有 `characterId` + `summary`，没有 `status`。Impact Plan Prompt / JSON Schema 与 b0efefc 一致。
- 新增 `SceneCharacterChangeSchema = { characterId, summary, status?: CharacterStatus | null }`；`StatePatchSchema` 与 `WorldlineDeltaSchema` 使用它，因此旧 Artifact 没有 status 仍可解析。
- `null` 与缺省都表示“本场景没有改变该人物的生死/在场”，不会覆盖更早状态；只有显式非 null 值生效。
- 场景模型输出在 strict 线缆 Schema 中仍必须包含 `status`：nullable enum 追加 `""` 哨兵，`normalizeStrictResponse` 将 `""` 还原为 `null`。因此模型永远不必猜测一个会覆盖旧状态的值。
- 折叠顺序（唯一实现 `derivePathCharacterStatuses`）：原著基线 → `baseDelta`（Impact Plan 只有 summary）→ 分歧点读者覆盖 → 路径上每个场景（先 statePatch，再该场景的读者覆盖）。
- `applyStatePatch` 用共享 `mergeCharacterChange` 合并：新 summary 替换旧 summary，新非 null status 覆盖旧 status，null/缺省沿用旧 status。`derivePathState` 本身就是 UI 与 Prompt 共用的折叠结果；`derivePathCharacterTimeline` 的 `currentStatus` 直接读取它，不再独立 fold。
- 整条路径从未出现非默认状态时为 `unknown`，**不从 `Character.role` 推断**。`PathCharacterState` / `DerivedCharacterStatus` 附带状态来源与历史，界面显示「在世 / 已故 / 不在场 / 未知」及来源（原著推断 / 影响计划 / 第 n 幕 / 读者设定 / 默认）。

#### 原著推断基线（启发式）

`deriveSourceBaselineStatuses` 是确定性纯函数，不调用模型。只有同时满足以下条件才把人物基线设为 `dead`：

- Story Map `status === "confirmed"`；草稿/候选一律不推断（全体 `unknown`）；
- 事件 `sequence` 严格早于分歧事件（分歧事件自身与之后事件不算），且 `evidenceKind === "fact"`、evidence 非空；
- 事件**恰好只有一名参与者**，且该参与者是已知 Character。多参与者事件一律不推断，即使 `stateChanges` 只点名其中一人：当前 Event Schema 没有结构化的「死者」字段（`stateChanges` 是自由文本），无法可靠挑人，也绝不解析自由文本去猜；
- 某条 `stateChanges` 包含死亡关键词，且不含否定/假死措辞（没死/未死/不死/假死/装死/诈死/险些/差点）；
- 歧义守卫：该条 stateChange 若整词提到**其他** Story Map 角色的姓名/别名，跳过（死亡可能属于别人）。整词匹配规则：少于 2 个字符的姓名/别名永不命中；命中不得落在另一个角色的更长姓名/别名内部（「张三」不算命中「张三丰」）；ASCII 姓名两侧不得是字母/数字（「Li」不算命中「Lily」）。所有匹配只用于让推断更保守。

其余人物默认为 `unknown`（source `default`）。这是有意保守的启发式：宁可漏报，也不把多人混战、传闻、推断或否定句当成原著死亡。若未来 Event Schema 增加结构化的 deceased 字段，可在该字段上放开多人事件，而不是依赖本启发式。

#### 读者覆盖

新增 `worldline_character_status_overrides`：`id`、`worldline_id`（FK cascade）、`anchor_scene_id`（null = 从分歧点起）、`character_id`、`status`、`idempotency_key`、`created_at`；`(worldline_id, idempotency_key)` 唯一。只追加，不 UPDATE/DELETE。

- 仓储校验 Worldline/项目、人物存在于该 Worldline 绑定的 confirmed Story Map、锚点场景属于同一 Worldline。
- 覆盖只在锚点为 null 或位于当前路径时生效；同一人物同一锚点按 `(createdAt, id)` 取最新。
- `setCharacterStatusOverrideAction` 只 append；界面在每条人物状态行提供小选择器，锚点为当前阅读位置（分歧点时 null）。

### 2. 阅读游标：head_kind + head_node_id

迁移 `0012_worldline_reading_position.sql` 给 `worldlines` 增加 `head_kind`（`root` / `scene`，可空）与 `head_node_id`：

- `head_kind = null` 表示**从未设置**：首次进入走默认路径（与迁移前行为一致）。
- `head_kind = 'root'` 表示用户明确停在分歧点；`head_node_id` 为 null。
- `head_kind = 'scene'` 表示停在某个场景；`head_node_id` 必须是该 Worldline 上真实存在的 Continuation 场景 Artifact。
- 旧行迁移后为 null，不会把“从未设置”误当成 root，也不会在刷新后跳到默认路径叶子。
- 迁移同时加 DB CHECK：`head_kind` 只能是 `root` / `scene` / NULL；`head_node_id` 必须与 `head_kind` 一致（NULL/NULL、root/NULL、scene/非空），非法组合在 INSERT 与 UPDATE 时都被 SQLite 拒绝。仓库当前没有 drizzle `check()` 模式，schema.ts 只留注释说明约束由迁移 0012 维护，避免 schema 快照漂移。
- 这是 Artifact/revision 不可变合同之外唯一允许 UPDATE 的指针列；它不参与 Delta、路径状态、摘要或生成上下文，也不产生 Generation Run。
- 不建到 `artifacts` 的外键，避免循环/删除语义耦合；由仓储层做领域校验。

`WorldlineSchema` 的 `head` 为 `{ kind: "root" } | { kind: "scene", sceneId } | null`；canonical 世界线只能为 null。纯 helper `readingPositionFromHead` / `headFromReadingPosition` / `assertHeadOnTree` 负责与客户端 `ReadingPosition` 互转；`default` ↔ null、`root` ↔ `{kind:"root"}`，未知节点抛错。

### 3. 命名书签

新增表 `worldline_bookmarks`：`id`、`worldline_id`（FK cascade）、`scene_node_id`（可空，null 表示分歧点/根路径）、`name`、`created_at`；`(worldline_id, name)` 唯一，`worldline_id` 建索引。`scene_node_id` 与 head 使用同一校验（必须是本 Worldline 的场景，不能是 directions 等其它 Artifact，也不能是兄弟世界线的场景），不建 artifacts 外键。

- 名称写入前做 NFC + trim，按存储文本检查 1–40 字符。
- 复用 `findForbiddenSettingDeltaChar` 拒绝零宽、bidi 控制符、换行等不可见/畸形字符，文案「书签名称包含不允许的字符（U+XXXX）」。
- 每条 Worldline 最多 50 个书签（`WORLDLINE_BOOKMARK_MAX_PER_WORLDLINE`）；名称查重、上限检查与插入在同一事务内。
- 错误类型：`invalid_name` / `duplicate_name` / `bookmark_limit` / `scene_not_found` / `bookmark_not_found` / `worldline_not_found` / `invalid_head`；只有 `(worldline_id, name)` 唯一约束映射为同名书签，其它数据库异常原样抛出，由 Action 回退到「书签保存失败，请重试。」
- 创建、列表、删除都是阅读游标操作，不写 Artifact、不写路径状态、不调用模型。删除未知 id 或不属于该 Worldline 的书签 fail closed；Worldline 删除时级联清理书签。

### 4. 服务端与界面

在 `actions.ts` 末尾追加 `setWorldlineHeadAction`、`createWorldlineBookmarkAction`、`deleteWorldlineBookmarkAction`、`setCharacterStatusOverrideAction`，全部先做 Zod 解析，返回 typed result；不改既有 setting-delta / canon action。

续写面板：

- 初始 `ReadingPosition` 从 `worldline.head` 恢复；head 失效时显示错误并回退到默认路径，**不静默改写**数据库。
- 选择分歧点写入 root，选择场景写入 scene；移动阅读位置、选择兄弟节点、重开任意树节点、生成并选中新场景后，按提交顺序串行调用 `setWorldlineHeadAction`，服务端最后落库的是最后一次点击。
- 书签区提供名称输入、“加书签”、列表与“跳转 / 删除”；跳转复用同一 `ReadingPosition` 路径并持久化 head。
- 人物状态行显示状态、来源与历史，并可把当前阅读位置上的状态覆盖为四种值之一；覆盖成功后在本地追加新行。
- 生成与上下文组装除 `characterStatuses` 外不变；head 与书签不进入 Prompt。

### 5. Prompt

Continuation 场景 Prompt 升级为 `continuation-scene.v7`（保留 v6）：v6 曾把 `status` 放进共享 `CharacterChangeSchema`，导致 strict JSON Schema 要求 Impact Plan 与场景都为每个人物输出状态，既改变 Impact Plan 合同，也会用猜测值覆盖既有 `dead`。v7 明确：

- 每个 `characterChanges[]` 项必须包含 `status`；未改变时用 `null`，null 永不覆盖旧状态；只有场景明确改变生死/在场时才设置非 null 值。
- `currentState.characterStatuses[]` 是当前路径已成立的状态；未列出的角色一律视为 `unknown`。
- 完整与紧凑 `worldline_setup` 都携带同一份 `characterStatuses`（只含 characterId/status/source），紧凑形式不裁剪状态。

方向 Prompt、Story Map Prompt、Impact Plan Prompt 不变；不从角色文本自动推断或回填状态。

### 6. 测试与文档

单测覆盖：Impact Plan 线缆 Schema 不含 status；场景线缆 status 为 nullable enum 且含 `""` 哨兵；null/缺省不覆盖旧状态；基线只取分歧前 fact 事件并排除 inference/否定/分歧事件本身；读者覆盖的锚点与兄弟隔离；UI 折叠与 Prompt full/compact 的 `characterStatuses` 一致；head root/scene 持久化与恢复；书签名禁用字符、50 条上限、directions/兄弟场景拒绝、重复与通用失败映射。E2E 覆盖生成场景后刷新仍停在 head、分歧点刷新后仍是 root、创建书签、跳走再跳回。

文档更新 `docs/domain.md` 与 CHANGELOG；0007 / 0010 的既有决策不变。旧数据无需迁移：`head_kind` 为 null、书签/覆盖表为空，旧 `characterChanges` 没有 status 仍可解析。

## 备选方案

| 方案 | 没有采用的原因 |
| --- | --- |
| 从 `Character.role === "deceased"` 自动生成路径状态 | 角色功能是 Story Map 的静态叙事描述，不等于某条分支的运行时状态；自动推断会伪造分支事实，也无法表达 absent/unknown。 |
| 把 status 留在 Impact Plan 的共享 CharacterChange | 会让 strict JSON Schema 强制 Impact Plan 输出状态，改变已冻结合同，并诱导模型为每个人物猜一个值覆盖旧状态。 |
| 把 status 写进 `Character` 或 Story Map revision | 同一状态会被所有世界线共享，违反世界线隔离；Story Map 已确认版本不可变。 |
| 每条路径保存完整人物状态快照 | 祖先/后代重复存储，修正时需回填且容易漂移；沿不可变节点折叠已足够。 |
| 用“空 head”同时表示默认路径和分歧点 | 无法在刷新后区分“从未阅读”和“用户明确停在分歧点”，会跳回默认路径叶子。 |
| 给 head/bookmarks 新建成独立“进度服务”或事件表 | 当前是本地单用户、单存储，两个指针列加两张小表已覆盖需求。 |
| 给 `head_node_id` / bookmark 建 artifacts 外键 | 会造成 artifacts/worldlines 的循环引用与删除顺序耦合；仓储校验已经能 fail closed。 |

## 后果

- 刷新或重新进入 Worldline 后回到最近阅读位置，包括用户明确选择的分歧点；命名书签可跨刷新跳转。
- head/bookmark 是少数可 UPDATE/DELETE 的阅读游标，但叙事 Artifact、路径状态和生成上下文仍只追加/确定性派生。
- 人物状态只在当前路径成立；`role` 保持 Story Map 语义，不会因分支事件被写回或迁移。
- 状态缺失仍合法：模型写 null/缺省时保留此前状态；整条路径都没有状态时界面显示默认 unknown，不猜测。
- 原著推断只提供一个保守的 dead 基线；读者可以在任意阅读位置用追加行覆盖，旧覆盖不被删除。

### 已知限制

- 原著基线是关键词启发式，不处理隐喻、转述或跨事件的复杂否定；多人事件、草稿 Story Map、短名/同名歧义一律保持 `unknown`，优先避免把活人标死。
- 书签没有重命名；改名等于删除后新建。
- 状态不校验模型是否在正文里兑现该状态。
- head/bookmark 没有版本历史；它们被设计成可覆盖的阅读游标，而不是可审计叙事行。
- head 失效时只提示并回退，不自动清空；需要用户再次移动位置才会写入新值。

## 不变的部分

- Source、Story Map、Impact Plan、Worldline Delta、Evidence 与 Continuation 生成合同不变。
- Artifact / revision 只追加不 UPDATE；head/bookmark/override 不是叙事 Artifact。
- 世界线隔离、candidate-first、fail-closed 和确定性纯函数约束不变。
- 上下文段顺序、预算降级阶梯、`selectContinuationContext`、提取 Prompt 与评分器不变。

## Open-source preflight

检索日期：2026-10-18。本次不执行网络访问、不下载或复制第三方代码，也不新增依赖。

- 复用仓库已有的 Zod、Drizzle/SQLite、Next Server Actions、`ReadingPosition` / 路径折叠与既有测试设施；没有引入日程、书签或状态管理库。
- 设计只借鉴公开产品“按路线记录人物状态、持续阅读位置”的交互模式，未复制代码、Prompt 或私有数据。
- 新依赖：**none**。
