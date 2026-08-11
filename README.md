# NovelRipple · 涟漪

> 改变一个选择，荡开一整个故事世界。  
> Change one moment. Ripple the whole story.

NovelRipple 把一部已经完成的小说，变成一个可以理解、探索和改写的故事世界。它先从原著中提炼人物、关系、主线、支线、暗线、伏笔、因果与世界规则，再允许用户从任意关键节点创造新的选择，并观察这次改变如何影响整条世界线。

## 核心体验

1. 导入一部小说。
2. 生成一张可追溯原文的「全书故事地图」。
3. 选择一个关键节点，保留原选择或提出新的选择。
4. 先预览人物、线索、因果与结局将受到的影响。
5. 确认后进入新的世界线，继续阅读、推演或创作。

## 故事地图

故事地图不是章节摘要堆叠，也不是一张难以操作的巨型关系图。每个重要节点都应回答：**发生了什么、为什么发生、影响了谁、它由哪段原文支持**。

地图至少覆盖：

- 故事脊柱：开端、目标、冲突、关键转折、高潮与结局；
- 人物网络：关系、动机、认知、秘密与人物弧；
- 叙事线索：主线、支线、暗线、伏笔及其回收状态；
- 世界约束：时间线、地点、规则、资源与因果关系。

原文事实、模型推断和新世界线生成内容必须清楚区分；重要结论应能回到对应的原文章节或片段。

## 两种世界线模式

| 模式 | 保持不变 | 可以变化 |
| --- | --- | --- |
| **严格模式** | 用户选定的原著结局锚点或终局条件 | 通往结局的选择、事件顺序、人物关系与代价 |
| **完全开放模式** | 分叉前已经发生的历史，以及未被用户主动改写的世界规则 | 分叉后的主线、人物命运、冲突与最终结局 |

严格模式不是把故事生硬拉回原剧情。当新的选择与结局锚点无法同时成立时，产品应明确展示冲突，让用户调整约束，而不是牺牲因果合理性。完全开放模式也不是无规则续写；它仍然尊重已经建立的事实、人物认知和世界逻辑。

## 产品原则

- **简单优先**：默认流程只有「导入 → 看图 → 改一点 → 看影响 → 继续故事」。
- **原著不被覆盖**：原始文本和原始世界线保持只读，所有变化发生在独立分支中。
- **先理解，再推演，后写作**：先建立故事地图，再计算连锁影响，最后生成正文。
- **证据可追溯**：事实与推断分开，重要节点能定位到原文。
- **开放源码优先**：每次产品迭代前先检索成熟实现，确认许可和适配度后优先复用；完整规则见 [AGENTS.md](AGENTS.md)。
- **复杂度需要证明**：不因故事天然是图结构，就默认引入图数据库、微服务或多 Agent 系统。

## 第一阶段

第一个可用版本只跑通一条完整路径：

```text
导入一部作品 → 得到故事地图 → 改变一个节点 → 预览涟漪 → 创建一条可继续的世界线
```

第一阶段不做大型通用写作套件、社交发布平台、游戏引擎、多人协作系统，也不预生成所有可能分支。只有真实使用证明需要时，才扩大能力和架构。

## 当前状态

项目已完成 **M0 — First Ripple** 的确定性发布门禁。当前仓库支持创建故事项目，将 UTF-8 `.txt` / `.md` 保存为不可变 Source，并在刷新后从本地 SQLite 继续阅读；同时保留公开基准故事，用来回归验证故事地图与世界线领域合同。真实模型质量通过显式 Live Eval 单独验收，不进入默认 CI。

当前技术基线：

- Next.js App Router + TypeScript；
- React Flow 故事地图；
- SQLite + Drizzle ORM；
- Zod 领域 Schema；
- Vitest 领域测试与 Playwright 浏览器测试。

仓库已经建立最薄的 OpenAI-compatible 模型调用边界，并实现可调用的 Story Map Extractor → Reconciler → 确定性校验 → 版本化 Artifact 管线。模型只返回逐字 Evidence 摘录，服务端在不可变 Source 中唯一匹配后计算 UTF-16 偏移与 Hash；无法定位、存在歧义或领域引用非法时均 fail closed。

项目页已接入 Story Workspace：用户可以显式生成 draft Story Map，在三栏界面中对照完整 Source、自动布局的事件图与 Evidence，按角色过滤、拖动视图节点，并对标题、摘要、参与人物、明显错误的 Edge 和 Evidence 确认进行最小人工修正。任何修正和确认都会创建新的 revision Artifact，不覆盖 AI 原始版本；只有 `confirmed` Story Map 才能进入 Ripple。

Ripple Simulator 已支持 `prevent` / `choice` / `outcome`、严格与开放模式、结构化 Impact Plan 和四种 Anchor 状态。Preview 只使用已确认 Story Map 构造只读 Canonical 上下文；用户接受后才在同一事务中保存 accepted Impact Plan revision、幂等 Canonical Worldline 和子 Worldline。严格模式的 `incompatible` 会在写入前被拦截。

接受后的 Worldline 以 confirmed Story Map 为只读基线，并从 accepted Impact Plan 确定性派生 Delta，不复制 Canon。Continuation 先生成恰好 3 个未来方向，用户选择其一后只生成 1 个带 `statePatch` 的完整场景；方向和场景分别保存为可追踪 Artifact，刷新后可恢复。场景若恢复已删除事实、删除 accepted Delta / Anchor / 分歧前 Canon，或占用非 `generated:` 事实命名空间，会在一次定向 repair 后 fail closed，不写入 Artifact。

Source 只在本地 SQLite 中持久化且永不被生成内容覆盖；执行 Story Map 生成时，正文会发送到你在环境变量中配置的 OpenAI-compatible 模型端点。请只配置你信任且符合数据处理要求的服务。

所有结构化结果都要经过本地 Zod Schema；Schema 与领域校验共享一次明确 repair，二次失败即关闭本次生成且不写入 Artifact。单元测试和浏览器测试使用确定性 Mock，不依赖外部模型。

真实端点通过服务端 `OPENAI_API_KEY`、可选 `OPENAI_BASE_URL`、`OPENAI_MODEL` 与 `OPENAI_STRUCTURED_OUTPUT_MODE` 配置；每次调用显式指定模型以及 `json_schema` 或 `prompt_json` 模式，使用 120 秒请求超时，不自动探测能力、不切换供应商。兼容端点需要实现 OpenAI Chat Completions 协议。版本化 prompt 位于 [`prompts/`](prompts/)；Story Map、Impact Plan 与两阶段 Continuation 均进入固定管线。

## 本地启动

需要 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

`npm run dev` 会先幂等执行本地 SQLite migration；也可单独运行 `npm run db:migrate`。

打开 `http://localhost:3000` 即可创建项目并导入 Source。重复导入规范化后内容相同的文件会打开已有 Source；内容发生变化时会创建新版本，旧 Source 不会被覆盖。

常用验证命令：

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm test
npm run test:e2e
npm run build
```

配置真实 OpenAI-compatible 模型后，可以显式运行 `npm run eval:live` 对 `ripple-001` 做非默认 Live Eval；终端摘要与 `.data/evals/m0-live-eval.json` 会报告模型、Prompt 版本、事件/人物召回、Evidence、一级影响、Anchor 和 Continuation 合同结果。该命令不会被默认测试或 `npm run check` 调用。

产品范围、领域语义和评测门槛分别见 [`docs/mvp.md`](docs/mvp.md)、[`docs/domain.md`](docs/domain.md) 与 [`docs/evals.md`](docs/evals.md)。

参与开发或使用编码 Agent 前，请先阅读 [AGENTS.md](AGENTS.md)。安装、启动与验证命令以 `package.json` 中的脚本为准。

## 内容权利与隐私

只应导入拥有合法使用或改编权利的作品。实现、测试、日志和截图不得泄露用户原稿；公开测试夹具优先使用自建内容或公版作品。
