# 0011：路径作用域设定增量（setting_delta Artifact）

- 状态：Accepted
- 日期：2026-10-18
- 范围：P1 / I2 Phase 3 — Continuation 新增读者写下的路径作用域设定规则、stale 方向批次与生成后分歧前 Canon 校验；不改变 Source、Story Map、Impact Plan、Worldline Delta、Evidence 或 fail-closed 合同；不新增数据库表、迁移或运行时依赖；生效规则进入独立的可裁剪上下文段

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

`statement` 与术语 `name` 在写入时做 NFC + trim，长度按存储的 NFC 文本检查（200 / 40）；存储与 Prompt 渲染使用同一份文本。NFC 保留读者输入的 `，！？：（）；…①` 等字符；NFKC 只用于术语主体匹配（`subjectKey`）。按 Unicode 大类拒绝 `Cc` / `Cf` / `Cs` / `Co` / `Zl` / `Zp`，并单独拒绝变体选择符 U+FE00–FE0F / U+E0100–E01EF；这覆盖零宽 U+200B/U+200D/FEFF/00AD、bidi U+200E/202E/2066、孤立代理、标签字符与私用区。错误为「设定说明/词条名不能包含控制字符、不可见字符或换行」。Zod Schema、服务端与界面共用同一个 `findForbiddenSettingDeltaChar` 与 NFC helper，因此不存在“测量去不可见字符、渲染保留不可见字符”的双口径。

它不调用模型，因此没有 Generation Run，也没有 `basedOnArtifactId`。写入只追加，永不 UPDATE；修订规则等于追加一条更新的设定增量。

停用、重新启用与软删除同样只追加，不 UPDATE 原 `setting_delta`。它们保存为 `artifactType: "setting_delta_lifecycle"`、`schemaVersion: 1` 的 continuation Artifact，payload 为 `SettingDeltaLifecycleV1`：

- `id`、`worldlineId`；
- `targetDeltaId`：被操作的 `setting_delta` id；
- `status`：`deactivated` / `reactivated` / `deleted`；
- `contentKind: "user"`、`createdAt`。

同一 `targetDeltaId` 按 `(createdAt, id)` 取最新一条生命周期；没有生命周期视为 active。`deleted` 是软删除：不进入界面列表与生成上下文，也不占 active 名额；`deactivated` 在界面显示为“已停用”、不进入上下文、不占 active 名额，可被 `reactivated` 恢复（恢复时仍使用原规则说明）。这些事件不复制规则正文，也不写 `statePatch`。

### 2. 确定性 ID 与幂等

Artifact id 由 `(worldlineId, anchorSceneId ?? "root", idempotencyKey)` 的 SHA-256 确定性派生：

```text
artifact_setting_delta_<sha256("setting_delta:<worldlineId>:<anchor|root>:<key>") 前 24 位>
```

同一世界线、同一锚点、同一幂等键的重复或并发写入返回同一行；不同键总是新行。生命周期事件的 id 由 `(worldlineId, targetDeltaId, idempotencyKey)` 的 SHA-256 派生为 `artifact_setting_delta_lifecycle_<24 位>`，同样幂等；它还必须校验目标存在、属于同一 Worldline 且确实是 `setting_delta`。客户端在每次打开表单或点击停用/删除/重新启用时生成新的 `crypto.randomUUID()`。服务端仍会校验项目、Worldline、confirmed Story Map 基线、锚点场景和人物引用，任一不成立都 fail closed。

### 3. 可见性只沿当前路径

`deriveActiveSettingDeltas({ tree, deltas, lifecycles, path })` 是生成上下文的唯一派生入口；`derivePathSettingDeltas` 使用同一套可见性/覆盖逻辑，但保留停用主体供界面展示：

- `anchorSceneId === null` 的规则从分歧点起整条世界线可见；
- 场景锚点的规则只在锚点位于当前路径（祖先或当前节点）时可见；
- 兄弟分支、路径外场景与未来节点的规则永不出现；
- 跨世界线 delta / lifecycle、未知锚点、未知生命周期目标、断裂路径、重复 id 都抛错，不返回部分列表。

生命周期在主体覆盖之后应用：软删除的生效版本让整个主体从结果中消失（不回退到更早版本），也不出现在任何 history 中；停用的生效版本以 inactive 返回但不进入生成上下文。因此同一 Worldline 的兄弟分支互不可见；设定增量也不会写入 `statePatch`、路径状态或 Worldline Delta。

### 4. 同一主体按更深/更新覆盖

主体身份是稳定 key：

- 人物：`character:<characterId>`；
- 术语：`term:<规范化名称>`，规范化做 NFKC、去首尾空白、合并内部空白、大小写折叠，因此“旧 灯塔”和“旧　灯塔”是同一主体。

沿当前路径可见的版本按 `(anchorDepth, createdAt, id)` 排序；同一主体最后一条成为 `active`，更早版本进入只读 `history`。列表按主体首次出现顺序输出，历史通过“此前：…”一行紧凑展示。旧行不删除也不更新。

### 5. 写时上限与序列化上限

- 每条 Worldline 同时受两道行数上限：
  - `SETTING_DELTA_MAX_ACTIVE_ROWS_PER_WORLDLINE = 50` 条未软删除的 `setting_delta` 行（停用仍算行）；
  - `SETTING_DELTA_MAX_ROWS_PER_WORLDLINE = 200` 条全部行，**包含软删除行**。
  软删除只释放 active 与未删除行名额，不释放全部存储行，因此“新增 → 删除”循环不会让总行数无上界。
- 新增与重新启用时，不只检查锚点自己的路径，而是检查锚点子树里的**每一条**根→节点路径：锚点为 `null` 时是空根路径加树中每个节点，锚点为场景 X 时是 X 及其全部后代。对每条路径派生 post-write active 集合（含生命周期），分别检查：
  - active 主体数 ≤ `SETTING_DELTA_MAX_ACTIVE = 20`；
  - 实际渲染进 Prompt 的 `setting_deltas` 文本长度 ≤ `SETTING_DELTA_CONTEXT_MAX_CHARS = 2000`。
- 渲染函数只有一个：`renderSettingDeltaContextText(items)` 返回 `<setting_deltas>` 标签内部逐条文本（`\n` 连接）的精确字符串。组装器与写时检查都调用它，写时 `.length` 就是 Prompt 实际长度；不再使用 `normalizedContextChars` 之类的第二套测量。NFC 组合字符（例如谚文 jamo）在存储、测量、渲染三处一致。
- 任一路径或世界线上限超限即 fail closed，中文错误指出具体路径（如「会使「第 3 幕 · 标题」所在路径的生效设定增量超过 20 条」/「…的设定增量超过 2000 字」）。同一主体替换不增加 active 数，但仍必须让所有受影响路径都通过检查。
- 仓储与领域检查统一抛 `SettingDeltaError`，带稳定 `code`（`forbidden_char`、`path_active_limit`、`path_text_limit`、`worldline_active_rows_limit`、`worldline_total_rows_limit`、`deleted_terminal`、`invalid_anchor` 等）与已面向读者的中文 `message`。Server Action 对该类型直接返回 `error.message`，不再维护易漂移的字符串白名单。
- 检查与插入之间没有 `await`，并发写入只能有一个越过上限；重新启用同样对整棵锚点子树检查，不增加行数但必须尊重 50 条未删除行与 20 个 active 主体。
- 界面在当前路径 active ≥ 20、世界线未删除行 ≥ 50 或全部行（含已删除）≥ 200 时提示并禁用添加。服务端仍独立校验，不依赖界面。

### 6. 独立的 `setting_deltas` 上下文段

方向与场景生成不再把规则塞进 `worldline_setup`。组装器新增 `setting_deltas` 段，位于 `canon_events` 之后、`path_summary` 之前；每条规则包含稳定 id（delta id）与一行“主体（作用域）：说明”文本。完整与 compact `worldline_setup` 都不再携带 `settingDeltas`，compact 的移除字段列表也不再声明 `settingDeltas[].anchor`。设定增量不是 Canon 证据，也不出现在 `canon_events` / `canon_evidence` 中。

### 7. Prompt v5 / v4 与分歧前 Canon 保护

`continuation-scene.v5` 与 `continuation-directions.v4` 都用同一句规则：

> `setting_deltas` 是读者为当前路径写下的设定规则：与更早的路径状态或分歧后的推演冲突时以它为准，后续内容不得违背；它不能改写分歧点之前已发生的原著事实，也不是 Canon 证据。

前半句保证读者规则覆盖更早路径状态与分歧后的模型推演；后半句保留“分歧点之前的原著事实不可倒改”的硬边界。两个 Prompt 都是新版本、尚未发布，因此直接原地修正措辞，不保留旧版本。

### 8. 界面与失败方式

续写面板在“人物状态（本路径）”之后展示“设定增量（本路径生效）”：生效规则显示主体、说明与“自分歧点起” / “自第 n 幕起”，有历史时显示“此前：…”；停用规则额外显示“已停用”并提供“重新启用”；软删除规则完全不显示。每条规则提供“停用 / 删除”（停用时为“重新启用 / 删除”）。空路径显示“本路径还没有设定增量。”。派生失败与路径 Delta / 人物状态一致：整段显示错误，不展示部分列表。

添加表单折叠在“添加设定增量”按钮后：

- 主体类型可选人物（下拉使用 Story Map 人物）或设定词条（≤40 字文本）；
- 规则说明 ≤200 字并显示剩余字数；
- 锚点固定为当前节点：根/空路径为 `null`，否则为当前场景 id；
- 提交使用打开表单时生成的幂等键，并有与其它 pending 操作相同的同步双击保护；
- 成功后把返回 Artifact 追加到视图并关闭表单，失败显示 `role="alert"` 错误；
- 表单无效、当前路径 active ≥ 20、世界线未删除行 ≥ 50 或达到每条世界线 200 行总上限（含已删除）时禁用提交/添加；
- 停用、重新启用、软删除各调用独立 Server Action，全部 `revalidatePath` 且不调用模型；服务端错误已是中文可执行提示且经类型化错误原样到达读者。已删除规则不在列表中，因此界面不会提供重新启用；服务端也拒绝对 deleted 规则执行 reactivated / deactivated，新的重复删除同样 fail closed（相同幂等键的重放仍返回原行）。

### 9. 陈旧方向批次与生成后分歧前 Canon 校验

设定增量发生变化后，已确认场景永不改变；未确认的方向批次只要早于当前规则就视为 stale。新 v2 方向批次在**组装上下文时**记录当前 active 集合的稳定指纹 `settingDeltaFingerprint`；服务端与界面比较“当前该父路径的指纹”与批次的指纹。这样即使规则是在模型调用进行中新增、落库时间晚于批次，也会被识别为 stale；旧批次没有该字段时退回按 `createdAt` 回放。停用后重新启用回同一条规则时指纹相同，不 stale；兄弟路径上的规则不可见，不会误报。

- 界面显示 `data-testid="setting-delta-stale-banner"`、文案固定为「设定已更新，请换一批以生效」，禁用「选择此方向」与「再写一版」，保留「换一批」与「查看已生成」。已生成场景是 confirmed 内容，仍可回读。
- 系统绝不自动重新生成方向；只有用户显式点击「换一批」（`newBatch: true`）才创建新批次。`generateContinuationScene` 在服务端重新派生并检查批次，stale 时以同一中文文案 fail closed，不写新场景 Artifact；`generateContinuationDirections(newBatch: false)` 遇到 stale 的最新批次同样拒绝复用。

生成后、保存 Artifact 前增加确定性校验 `validateAgainstPreDivergenceCanon`：

- **锁定集合**与 `validateContinuationStatePatch` 的“分歧前”定义一致：Story Map 中 `sequence < 分歧事件.sequence` 且不在**当前路径状态** `factsRemoved`（`derivePathState(baseDelta, path)`）中的事件。分歧后事件永不锁定；路径上合法删除的事件也不锁定。
- **精度**：只硬拒绝高置信的字面否定——锁定事件标题与“未发生 / 不存在 / 是假的 / 是捏造的”等明确谓词直接绑定，且否定词后必须确实跟“发生/存在”类谓词（例如 `从来没有发生过<title>`、`<title>根本没有发生过`、`<title>是捏造的`），中间最多几个助词（过/了/这件事/那场等，≤4 字），且在同一句内。裸 `没有<title>`、`没有忘记<title>`、反事实（如果/要不是/若是/假如/倘若）、失去义（没有了/再也没有）、回忆（`想起<title>……不再…`）、因果（`因为<title>，她不再…`）、附近出现 `取消了`、提及其它否定词，都只产生 warning，不阻断保存。
- **召回边界**：换一种说法的否定、隐含矛盾、与已确认设定的矛盾不会被这个字面护栏抓到。它是低召回护栏，不是语义判定。
- **策略开关**：环境变量 `CONTINUATION_CANON_GUARD` 由服务端配置 helper 解析，缺省 `strict`；`warn` 把所有信号降级为 warning，`off` 关闭生成后检查（Prompt 护栏仍保留）。非法值在任何模型调用前 fail closed。
- **硬拒绝**仍走既有 validation-issue → repair → fail-closed 路径：Generation Run 记为 failed、保留原始输出、不落 Artifact。服务端边界把可识别的 Canon 硬拒绝映射为「生成内容明确否定了分歧前已确认的原著事件「<title>」，已拒绝且未保存；请重试或换一批。」，不回显模型正文。
- **warning** 不阻断保存：作为可选 `canonWarnings: Array<{ eventId, field, reason }>` 附加在 v2 方向/场景 payload 上（旧行没有该字段仍可解析），界面显示一条非阻断的「原著一致性提示」。永不静默修补或删句。
- 方向校验覆盖标题、前提与预期后果，场景校验覆盖标题、正文与摘要。

标注探针（`tests/unit/canon-guard-probe.test.ts`，自建迷你故事地图，不含原文）测得：**catch 5/11，hard false-reject 0/17，legit warnings 8/17，中性长文 hard reject 0**。11 条应拒绝样本包含可被字面规则抓住的直接否定、前缀否定与“是捏造的/根本不存在”，也包含明确抓不到的改写；17 条合法样本覆盖回忆、因果、`没有忘记`、附近 `取消`、裸 `没有<title>`、反事实/失去义、分歧后事件、路径删除事件与中性提及。测试同时断言硬假阳性必须为 0。

### 10. 上下文阶梯与单调性

`setting_deltas` 是可裁剪段，不再依赖“20 × 260 字必有界”的假设；写时已按锚点子树里的每条路径检查 20 个 active 主体与真实渲染 2k。`CONTINUATION_CONTEXT_MAX_CHARS` 的降级阶梯仍是单一嵌套序列，顺序更新为：

完整内容 → 丢 `canon_evidence` 中的非 pinned 条目 → 丢 `setting_deltas` → 丢旧 `recent_scenes` → 裁 `path_summary` → compact `worldline_setup` → 最新场景摘要 → v1 句末截断 → fail closed。

`canon_evidence` 中分歧事件自身及其直接依赖的分歧前事件证据是 pinned，与 `worldline_setup`、`canon_events`、`selected_direction`、`anchor_reminder` 同属必需下限，任何阶梯步骤都不裁剪；放不下时抛类型化预算错误。`setting_deltas` 每次整条丢弃最浅（`anchorDepth` 最小）再最旧（`createdAt`）再按 id 的规则，因此更深/更新的路径规则保留更久；被丢弃 id 写入 manifest 的 `droppedItemIds`。规则裁剪排在证据之后、最近场景之前，且释放的预算不回填证据；更大预算只会停留在更早（或相同）的阶梯状态。`tests/unit/context-assembler.test.ts` 的阶梯单调性、全预算扫描与“必需段单独放得下时 20 条规则必不导致失败”测试保持通过。

## 备选方案

| 方案 | 没有采用的原因 |
| --- | --- |
| 新建 `setting_deltas` 表并迁移 | 既有 `artifacts` 已提供不可变行、项目/世界线隔离、版本与统一解析；再建表会多一套所有权、迁移与幂等逻辑，而当前规模只需按 Worldline 读取后在领域层派生 |
| 把条目写成 `statePatch.factsAdded` | 会把读者规则混成分支生成事实，必须占用 `generated:` 命名空间，还要进入路径状态折叠；无法自然表达“人物/术语主体”和“同主体覆盖”，也让兄弟状态与规则语义纠缠 |
| 关键词触发的 lorebook（Novelcrafter / SillyTavern 式 `name ∪ aliases` 命中） | 需要别名索引、触发时机与未命中语义，容易因别名不全静默漏掉规则；当前每条 Worldline 最多 20 个生效主体且序列化 ≤2k，全部注入仍可预测。等真实数据证明条目数量影响预算或信噪比，再评估关键词触发 |
| 直接 UPDATE 规则的 `deletedAt` / `active` 字段 | 违反 Artifact 只追加不 UPDATE 的不可变合同，也会让历史路径无法回读“当时规则是否生效”。停用/软删除改为追加 `setting_delta_lifecycle` 事件，原规则行保持字节不变 |
| 用硬 DELETE 删除规则行 | 不可追溯，且会破坏已有路径/场景的审计；软删除只追加生命周期事件，存储仍保留旧行，但派生、界面与上下文都忽略它 |
| 把规则继续放在永不裁剪的 `worldline_setup` | 会让读者规则无限挤占必需段，导致预算错误无法通过“停用/删除规则”解决；独立可裁剪段让规则在预算紧张时先让位于最近场景，同时保留更深/更新的路径规则更久 |
| 为每条规则保存完整路径快照 | 同一规则会在祖先与后代重复存储，修正时必须回填所有后代；沿路径派生已足够，且天然保证兄弟隔离 |

## 后果

- 读者可以在任意场景节点写下短规则；规则只沿该节点及其后代可见，兄弟分支与分歧点不会看到，刷新后仍从不可变 Artifact 恢复。
- 同一主体的新规则会覆盖旧规则，旧版本保留在“此前：…”中；停用/重新启用/软删除只追加生命周期事件，原规则永不 UPDATE。
- 生效规则进入独立的 `setting_deltas` 段，写时已保证锚点子树里每条路径 ≤20 个生效主体且实际渲染 ≤2k；上下文预算不足时规则会从最浅/最旧开始整条裁剪，不影响必需段。
- 任一受影响路径已有 20 个生效主体、世界线已有 50 条未删除行或 200 条总行数时，新规则写入会 fail closed；替换已有主体仍可写入，但必须所有受影响路径都不超限。界面提前提示并禁用添加。
- 设定变化后，受影响的未确认方向批次显示 stale 提示并禁止继续选择/重试；系统不会自动换批，已确认场景保持可读。
- Prompt 同时要求规则优先于更早路径状态/分歧后推演，并明确禁止改写分歧点之前的原著事实。生成后还会对“被改写的分歧前事件”做确定性校验，命中即拒绝整个候选；但校验基于标题/摘要与固定线索字符串，不能理解所有同义改写，也不会逐条验证每条读者规则是否被遵守。
- 失败是整体失败：派生错误不返回部分列表；写入错误不留下半条规则；达到 active / 真实渲染 2k / 未删除 50 行 / 世界线总行数（含删除）200 行上限时服务端 fail closed、界面禁用添加；stale 批次或 `strict` 下明确否定分歧前事件的候选不写 Artifact。

### 已知限制

- 软删除与停用是只追加的生命周期事件，不做物理删除。`deleted` 是终态：不能重新启用、停用或再次删除，界面也不提供“撤销删除”；未软删除的停用规则仍可重新启用。世界线未删除行上限 50，全部行（含已删除）上限 200。
- 主体只有人物与术语两类，没有地点/组织/物品等独立类型；这些暂时用术语表达。
- 没有关键词触发或 `name ∪ aliases` 匹配；所有当前路径生效规则都会注入，依赖每条路径 20 个主体、真实渲染 2k、每条世界线 50 条未删除行与 200 行总上限（含删除）保持有界。
- 裁剪只按锚点深度/创建时间决定，不按规则对当前场景的重要性排序；更深/更新的规则保留更久，但同层规则可能被整条丢弃。
- 没有把场景 `statePatch.characterChanges` 自动转成以场景为锚的 progression；人物变化仍只属于路径状态，设定增量由读者显式添加。
- 生成后校验只覆盖高置信字面否定，召回率低：同义改写、隐含矛盾、与已确认设定的矛盾不会被硬拒绝；也不校验每条读者设定规则是否被遵守。warning 只是提示，不阻断保存。需要更强保证时应扩展同一拒绝路径，而不是静默修补或把规则伪装成 Canon。
- 新批次用生成开始时冻结的指纹判断 stale；只有缺字段的历史批次才使用毫秒 ISO `createdAt` 回放，同一毫秒内的历史顺序可能无法区分。

## 不变的部分

- Source、Story Map、Impact Plan、Worldline 与 Worldline Delta 合同不变；设定增量不是 Canon 证据，也不能覆盖分歧点之前的原著事实。
- Artifact / revision 只追加不 UPDATE；确定性 ID 让重复提交幂等，不产生重复规则。
- 世界线隔离不变：派生只读当前 Worldline 的当前路径，兄弟分支的规则、状态与场景互不可见。
- `selectContinuationContext`、必需段永不裁剪、`CONTINUATION_CONTEXT_MAX_CHARS` 的单一嵌套降级阶梯与单调性、Generation Run 与数据库结构均不变；本次只把规则从必需 `worldline_setup` 移到可裁剪的 `setting_deltas` 段。

## Open-source preflight

检索日期：2026-10-18。本轮受任务约束不执行网络访问，也不下载或复制第三方代码；以下候选仅按官方公开文档记录模式与许可证，采用与否基于当前窄侧栏与有界上下文的实际需要：

- [Novelcrafter Codex Progressions](https://www.novelcrafter.com/help/docs/codex/progressions)：产品文档，不是开源代码；只借鉴“按分支/进度记录设定条目”的产品模式，未复制代码、Prompt 或私有数据。
- [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)：SillyTavern 采用 AGPL-3.0；只借鉴 `name ∪ aliases` 关键词触发的 lorebook 模式，未复制任何代码；因当前上限已让“全部注入”保持有界，本次不引入关键词触发。
- 复用 NovelRipple 既有的 Zod Schema、Drizzle `artifacts` 存储、确定性派生函数、分段上下文组装与 fail-closed 测试设施；没有新增上下文框架、lorebook 库或 UI 组件库。

新依赖：**none**。本次评审修正（stale 批次与生成后分歧前校验）同样不执行网络访问、不新增依赖，复用既有场景树 / 设定增量派生函数与 `generateStructured` 的 validate → repair → fail-closed 路径；stale 判断是纯函数，不引入调度器、缓存或后台自动生成。
