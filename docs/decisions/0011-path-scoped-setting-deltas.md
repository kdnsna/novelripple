# 0011：路径作用域设定增量（setting_delta Artifact）

- 状态：Accepted
- 日期：2026-10-18
- 范围：P1 / I2 Phase 3 — Continuation 新增读者写下的路径作用域设定规则；不改变 Source、Story Map、Impact Plan、Worldline Delta、Evidence 或 fail-closed 合同；不新增数据库表、迁移、运行时依赖或上下文裁剪层级

## 背景

0007 已把续写建模为不可变场景节点树，路径状态只沿根→当前节点折叠。读者在分支里常常会确认一些原著没有、但该路径已经成立的短规则，例如“旧灯塔已被封锁”“夜班渡船已经停航”。如果这些规则只写在场景正文里，后续方向与场景生成只能靠模型自己回忆；如果把它们塞进 `statePatch`，又会把“读者规则”和“分支事实”混成同一种状态，兄弟分支也可能串线。

0007 的 P1 第 1 项曾把“路径作用域设定条目”留给后续迭代。本决定记录已落地的存储、可见性、覆盖、上限、上下文注入与 Prompt 合同，以及本轮没有做的关键词触发与 progression。

## 决定

### 1. 存储为不可变 continuation Artifact

设定增量仍是既有 `artifacts` 表中的 `kind: "continuation"`、`artifactType: "setting_delta"` 行，`schemaVersion: 1`，payload 为 `SettingDeltaV1`：

- `id`、`worldlineId`；
- `anchorSceneId`：`null` 表示从分歧点起整条世界线生效，否则只在该场景及其后代生效；
- `subject`：`{ kind: "character", characterId }` 或 `{ kind: "term", name }`；
- `statement`：读者规则，1–200 字；
- `contentKind: "user"`、`createdAt`。

它不调用模型，因此没有 Generation Run，也没有 `basedOnArtifactId`。写入只追加，永不 UPDATE；修订规则等于追加一条更新的设定增量。

### 2. 确定性 ID 与幂等

Artifact id 由 `(worldlineId, anchorSceneId ?? "root", idempotencyKey)` 的 SHA-256 确定性派生：

```text
artifact_setting_delta_<sha256("setting_delta:<worldlineId>:<anchor|root>:<key>") 前 24 位>
```

同一世界线、同一锚点、同一幂等键的重复或并发写入返回同一行；不同键总是新行。客户端在每次打开表单时生成新的 `crypto.randomUUID()`，成功后关闭表单，因此一次表单提交最多对应一条规则。服务端仍会校验项目、Worldline、confirmed Story Map 基线、锚点场景和人物引用，任一不成立都 fail closed。

### 3. 可见性只沿当前路径

`deriveActiveSettingDeltas({ tree, deltas, path })` 是唯一派生入口：

- `anchorSceneId === null` 的规则从分歧点起整条世界线可见；
- 场景锚点的规则只在锚点位于当前路径（祖先或当前节点）时可见；
- 兄弟分支、路径外场景与未来节点的规则永不出现；
- 跨世界线 delta、未知锚点、断裂路径、重复 delta id 都抛错，不返回部分列表。

因此同一 Worldline 的兄弟分支互不可见；设定增量也不会写入 `statePatch`、路径状态或 Worldline Delta。

### 4. 同一主体按更深/更新覆盖

主体身份是稳定 key：

- 人物：`character:<characterId>`；
- 术语：`term:<规范化名称>`，规范化做 NFKC、去首尾空白、合并内部空白、大小写折叠，因此“旧 灯塔”和“旧　灯塔”是同一主体。

沿当前路径可见的版本按 `(anchorDepth, createdAt, id)` 排序；同一主体最后一条成为 `active`，更早版本进入只读 `history`。列表按主体首次出现顺序输出，历史通过“此前：…”一行紧凑展示。旧行不删除也不更新。

### 5. 上限

- 每条 Worldline 最多 `SETTING_DELTA_MAX_PER_WORLDLINE = 50` 条；
- 派生当前路径时最多保留 `SETTING_DELTA_MAX_ACTIVE = 20` 个生效主体，超过时保留最深/最新的主体。

术语名上限 40 字、说明上限 200 字，因此 `worldline_setup.settingDeltas` 有界（约 20 × 260 字），不进入上下文裁剪阶梯。达到每条世界线上限后写入 fail closed，界面禁用添加并说明原因。

### 6. 注入 `worldline_setup` 的 full 与 compact

方向与场景生成的 `worldline_setup.settingDeltas` 都携带当前路径生效的规则；每条包含 id、主体、说明与锚点标签（“分歧点” / “第 n 幕”）。compact 形式只省略锚点标签（`settingDeltas[].anchor`），不会省略主体或规则正文，因为它们是读者明确要求后续内容遵守的设定。设定增量不是 Canon 证据，也不出现在 `canon_events` / `canon_evidence` 中。

### 7. Prompt v5 / v4 与分歧前 Canon 保护

`continuation-scene.v5` 与 `continuation-directions.v4` 都用同一句规则：

> `worldline_setup.settingDeltas` 是读者为当前路径写下的设定规则：与更早的路径状态或分歧后的推演冲突时以它为准，后续内容不得违背；它不能改写分歧点之前已发生的原著事实，也不是 Canon 证据。

前半句保证读者规则覆盖更早路径状态与分歧后的模型推演；后半句保留“分歧点之前的原著事实不可倒改”的硬边界。两个 Prompt 都是新版本、尚未发布，因此直接原地修正措辞，不保留旧版本。

### 8. 界面与失败方式

续写面板在“人物状态（本路径）”之后展示“设定增量（本路径生效）”：每条显示主体、说明与“自分歧点起” / “自第 n 幕起”，有历史时显示“此前：…”。空路径显示“本路径还没有设定增量。”。派生失败与路径 Delta / 人物状态一致：整段显示错误，不展示部分列表。

添加表单折叠在“添加设定增量”按钮后：

- 主体类型可选人物（下拉使用 Story Map 人物）或设定词条（≤40 字文本）；
- 规则说明 ≤200 字并显示剩余字数；
- 锚点固定为当前节点：根/空路径为 `null`，否则为当前场景 id；
- 提交使用打开表单时生成的幂等键，并有与其它 pending 操作相同的同步双击保护；
- 成功后把返回 Artifact 追加到视图并关闭表单，失败显示 `role="alert"` 错误；
- 表单无效或达到每条世界线上限时禁用提交。

### 9. 上下文阶梯与单调性不变

设定增量是有界的必需素材，不是新的可裁剪段。`CONTINUATION_CONTEXT_MAX_CHARS` 的降级阶梯仍是原来的单一嵌套序列：完整内容 → 丢 `canon_evidence` → 丢旧 `recent_scenes` → 裁 `path_summary` → compact `worldline_setup` → 最新场景摘要 → v1 句末截断 → fail closed。compact 只省略锚点标签，且释放的预算不回填证据，因此更大预算仍然只会停留在更早（或相同）的阶梯状态。`tests/unit/context-assembler.test.ts` 的阶梯单调性与全预算扫描保持通过。

## 备选方案

| 方案 | 没有采用的原因 |
| --- | --- |
| 新建 `setting_deltas` 表并迁移 | 既有 `artifacts` 已提供不可变行、项目/世界线隔离、版本与统一解析；再建表会多一套所有权、迁移与幂等逻辑，而当前规模只需按 Worldline 读取后在领域层派生 |
| 把条目写成 `statePatch.factsAdded` | 会把读者规则混成分支生成事实，必须占用 `generated:` 命名空间，还要进入路径状态折叠；无法自然表达“人物/术语主体”和“同主体覆盖”，也让兄弟状态与规则语义纠缠 |
| 关键词触发的 lorebook（Novelcrafter / SillyTavern 式 `name ∪ aliases` 命中） | 需要别名索引、触发时机与未命中语义，容易因别名不全静默漏掉规则；当前每条 Worldline 最多 20 个生效主体，全部注入仍有界且更可预测。等真实数据证明条目数量影响预算或信噪比，再评估关键词触发 |
| 直接编辑或删除已有设定增量 | 违反 Artifact 只追加不 UPDATE 的不可变合同；读者要改规则时追加一条更新的同主体增量即可，旧行保留为 history，可审计且不影响历史分支 |
| 为每条规则保存完整路径快照 | 同一规则会在祖先与后代重复存储，修正时必须回填所有后代；沿路径派生已足够，且天然保证兄弟隔离 |

## 后果

- 读者可以在任意场景节点写下短规则；规则只沿该节点及其后代可见，兄弟分支与分歧点不会看到，刷新后仍从不可变 Artifact 恢复。
- 同一主体的新规则会覆盖旧规则，旧版本保留在“此前：…”中；没有 UPDATE、DELETE 或隐式迁移。
- `worldline_setup` 的 full 与 compact 都携带规则，compact 只省略锚点标签；上下文体积有界，裁剪阶梯与单调性不变。
- Prompt 同时要求规则优先于更早路径状态/分歧后推演，并明确禁止改写分歧点之前的原著事实。模型仍可能不遵守，系统只做指令约束，没有对生成场景逐条自动验证规则是否被违反。
- 失败是整体失败：派生错误不返回部分列表；写入错误不留下半条规则；达到上限时服务端 fail closed、界面禁用添加。

### 已知限制

- 还没有删除、隐藏或停用规则的能力；只能追加同主体更新。
- 主体只有人物与术语两类，没有地点/组织/物品等独立类型；这些暂时用术语表达。
- 没有关键词触发或 `name ∪ aliases` 匹配；所有当前路径生效规则都会注入，依赖 20 个主体的上限保持有界。
- 没有把场景 `statePatch.characterChanges` 自动转成以场景为锚的 progression；人物变化仍只属于路径状态，设定增量由读者显式添加。
- 模型只被 Prompt 约束，没有被系统自动校验每一个场景是否遵守了规则；若需要硬保证，应在后续加入生成后校验与 repair，而不是把规则伪装成 Canon。

## 不变的部分

- Source、Story Map、Impact Plan、Worldline 与 Worldline Delta 合同不变；设定增量不是 Canon 证据，也不能覆盖分歧点之前的原著事实。
- Artifact / revision 只追加不 UPDATE；确定性 ID 让重复提交幂等，不产生重复规则。
- 世界线隔离不变：派生只读当前 Worldline 的当前路径，兄弟分支的规则、状态与场景互不可见。
- `selectContinuationContext`、上下文七段顺序、`CONTINUATION_CONTEXT_MAX_CHARS` 降级阶梯、Generation Run 与数据库结构均不变。

## Open-source preflight

检索日期：2026-10-18。本轮受任务约束不执行网络访问，也不下载或复制第三方代码；以下候选仅按官方公开文档记录模式与许可证，采用与否基于当前窄侧栏与有界上下文的实际需要：

- [Novelcrafter Codex Progressions](https://www.novelcrafter.com/help/docs/codex/progressions)：产品文档，不是开源代码；只借鉴“按分支/进度记录设定条目”的产品模式，未复制代码、Prompt 或私有数据。
- [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)：SillyTavern 采用 AGPL-3.0；只借鉴 `name ∪ aliases` 关键词触发的 lorebook 模式，未复制任何代码；因当前上限已让“全部注入”保持有界，本次不引入关键词触发。
- 复用 NovelRipple 既有的 Zod Schema、Drizzle `artifacts` 存储、确定性派生函数、`worldline_setup` 组装与 fail-closed 测试设施；没有新增上下文框架、lorebook 库或 UI 组件库。

新依赖：**none**。
