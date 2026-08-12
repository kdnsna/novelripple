# M0 — First Ripple

## 阶段状态

`v0.1.0` 是已冻结的 M0 基线，本文件保留 M0 的范围、验收场景与硬门槛，不把历史承诺改写成 M1 功能。当前 `main` 已进入 **M1 — Real Story** 启动状态；M1 只能由具体 Issue 定义新的用户结果和验收标准，在此之前不新增 Story Map、Ripple 或 Continuation 范围。M0 代码除 P0/P1 bug 外不再修改。

## 用户结果

读者可以打开一篇权利清晰的短篇，核对有原文证据的故事地图，改变一个关键事件，先理解连锁影响，再明确确认一条不会覆盖原著的新世界线，并生成一个符合新世界线状态的后续场景。

## 最小验收场景

使用公开夹具 `ripple-001`：

1. 从首页创建 Project，并导入 `fixtures/ripple-001/source.md`；
2. 查看故事地图中的原事件、参与人物和原文证据，确认当前 Story Map 版本；
3. 选择“许澄没有交出红色账簿”；
4. 选择“事件不发生”并生成结构化涟漪预览；
5. 看见立即、中期和结局影响，以及严格模式锚点状态；
6. 确认当前 Impact Plan 后创建一条子世界线；
7. 基于该世界线生成一个后续场景，场景不恢复已被 Delta 删除的事实；
8. 刷新页面后仍能看到该世界线，原著基线保持不变。

## 核心闭环

```text
导入故事
→ 生成可追溯 Story Map
→ 用户确认 Story Map
→ 选择一个事件并改变
→ 生成 Ripple Preview
→ 检查 Anchor
→ 用户确认 Impact Plan
→ 创建新的 Worldline
→ 生成一个后续场景
```

确认门不可跳过。任何 Evidence、Schema、引用完整性或领域不变量校验失败，都必须停止当前步骤并明确报错，不得猜测、部分采用或静默 fallback。

## M0 范围

### Source

- 接受并持久化 UTF-8 `.txt` 与 `.md`；
- 保存原文、规范化文本、内容 Hash 与字符偏移；
- Source 创建后不可修改；
- 重复内容返回已有 Source，修改后的内容创建新版本。

### Story Map

- Characters、Events、`causes` / `enables` / `foreshadows` 三类边；
- 重要事件至少一个合法 Evidence Reference；
- 用户可以查看证据、选择节点并确认地图版本；
- M0 不提供任意图结构编辑器。

### Ripple Preview

- 支持 `prevent`、`choice`、`outcome` 三类分歧；
- 输出立即、中期、结局影响、因果路径、不确定项和 Anchor 状态；
- Impact Plan 是版本化候选，Preview 阶段只构造只读 Canonical 上下文，用户确认前不创建或改变 Worldline；
- Anchor 冲突采用 fail-closed，不用巧合强行满足。

### Worldline

- 新世界线引用父世界线、Story Map 版本、Divergence 与已接受 Impact Plan；
- 只保存相对父世界线的增量，不复制原著；
- 创建操作具有幂等键；
- 页面刷新后仍能恢复已创建世界线。

### Continuation

- 先生成恰好 3 个未来方向，用户显式选择后再生成场景；
- 每次 First Ripple 只生成一个后续场景；
- 场景绑定已创建的 Worldline 和已接受 Impact Plan；
- 场景输出正文与结构化 `statePatch`；
- 场景必须遵守 Delta，不得恢复已被删除或否定的事实；
- 方向与场景分别持久化，刷新后恢复，不提供聊天或无限续写。

## 第一阶段 Non-goals

- PDF / EPUB / DOCX；
- 长篇百万字小说；
- 多 Agent；
- 图数据库；
- 向量数据库；
- 完整小说编辑器；
- 无限续写；
- 世界线合并；
- 社交和分享；
- 多用户协作；
- 账号权限；
- 支付；
- 插件系统；
- 多模型路由；
- 自动预生成大量分支；
- 角色聊天。

## 交付阶段

1. **Foundation**：文档、公开夹具、领域 Schema、不变量测试与可运行 Web 壳；
2. **Traceable Map**：真实 `.txt` / `.md` 导入、结构化模型调用与轻量地图确认；
3. **First Ripple**：真实 Impact Plan、Anchor 检查、持久化 Worldline；
4. **One Scene**：生成一个与 Worldline 状态一致的后续场景。

当前仓库已经交付 Foundation、Traceable Map、First Ripple 与 One Scene：真实 Source 导入、双阶段 Story Map 生成、确定性校验、不可变人工 revision、Ripple Preview、Anchor 拦截、幂等 Worldline 创建，以及“三个方向 → 一个场景 → 刷新恢复”均已接入项目页。

## 硬门槛

以下任一失败均不能标记对应能力完成：

1. Source 或 canonical worldline 被覆盖；
2. 关键事件缺少合法 Evidence Reference；
3. 图中出现悬空边或不存在的参与人物；
4. Impact Plan 未确认就改变世界线；
5. 严格模式静默破坏 Anchor；
6. 重复确认创建重复世界线；
7. 无效模型输出被宽松解析并写入；
8. Continuation 恢复已被 Delta 删除或否定的事实；
9. 页面刷新后正式状态丢失。
10. Impact Plan 或 Continuation 倒改 Divergence 之前的 Canon 事实。
