# NovelRipple M1 — Real Story｜Codex 全流程执行命令

> 来源：ChatGPT 对话「项目规划与下一步行动」
> https://chatgpt.com/s/t_6a7ca0c2e0408191bdda5d1238c0a114
> 存档时间：2026-08-13（Hermes 整理入档）
> 用途：Codex 执行 M1 各阶段的指令备查；每一关完成后通用审核命令附于文末。

---

## M1-00｜进入 M1 前的仓库校准

将下面整段直接交给 Codex：
你现在开始 NovelRipple 的 M1 — Real Story 阶段。
本次只做 M1 启动前的仓库校准，不实现新的产品功能。
首先：

1. 读取并完整理解：
- AGENTS.md
- README.md
- docs/mvp.md
- docs/domain.md
- docs/evals.md
- docs/decisions/
- docs/evals/runs/
- package.json
- 当前 .github/workflows/
2. 检查：
- git status
- 当前 branch
- 当前 main HEAD
- v0.1.0 tag 指向
- M1 — Real Story milestone
- 当前 open issues
3. 确认 M0 已冻结：
- 不修改 v0.1.0；
- M0 代码只有发现 P0/P1 bug 时才允许修改；
- M1 必须基于现有 M0 能力向前演进。
重点检查：
A. 当前 README / docs/mvp.md 是否仍然把 M0 当成“当前开发阶段”；
B. docs/evals/runs/ 中哪一份是真正 M0 PASS 的正式封版报告；
C. 是否仍保留历史 FAIL 报告但缺少明显 historical 标记；
D. AGENTS.md 权威索引是否与当前仓库事实一致；
E. M1 milestone 是否已创建且没有具体 Issues。
如果发现文档状态漂移：
只做最小修正，使：

- v0.1.0 和 M0 历史保持不可变；
- main 明确进入 M1 — Real Story；
- 正式 M0 PASS 报告有明确索引；
- 历史失败报告不删除，但标记为 historical；
- 不创建重复 vision / architecture 文档。
不要实现任何 Story Map、Ripple 或 Continuation 新功能。
完成后运行现有仓库完整确定性门禁：

```
npm run lint
```

```
npm run typecheck
```

```
npm run test:unit
```

```
npm run test:contract
```

npm test

```
npm run build
```

```
CI=1 npm run test:e2e
```

最终输出：

1. 当前 main HEAD；
2. M0 tag / Release 状态；
3. 实际修改文件；
4. 是否存在文档漂移；
5. 所有测试结果；
6. 当前是否已干净进入 M1；
7. 明确结论：
M1 FOUNDATION READY
或
M1 FOUNDATION NOT READY
完成后停止，不要进入 M1-01。

## M1-01｜固化 M1 产品合同与真实作品 Benchmark

开始 NovelRipple M1-01。
目标：
在不修改任何业务实现的情况下，正式定义 M1 — Real Story 的产品合同、真实作品验收集和评测标准。
开始前：

1. 阅读 AGENTS.md；
2. 阅读 README.md、docs/mvp.md、docs/domain.md、docs/evals.md；
3. 检查当前仓库和 M0 Release 状态；
4. 完成 AGENTS.md 要求的 Open-source preflight。
Open-source preflight 至少重新核对：

- google/langextract
- booknlp/booknlp
- inkle/ink
- promptfoo/promptfoo
只使用官方仓库、官方文档与许可证信息。
本阶段原则：

- 优先借鉴方法；
- 默认不增加任何新 runtime dependency；
- 不增加 Python 服务；
- 不引入 Promptfoo；
- 不引入 BookNLP runtime；
- 不引入 Ink runtime；
- 不引入多 Agent、RAG、向量数据库或图数据库。
### 一、更新 docs/mvp.md

将“当前开发合同”切换为：
M1 — Real Story
M1 用户结果：
用户可以导入一篇权利清晰、非专门为 NovelRipple 编写的真实中短篇，在不需要理解 Prompt / Schema / Agent / 数据库的情况下：
导入作品
→ 系统理解真实故事
→ 用户低成本核对关键结构
→ 确认 Story Map
→ 选择/获得推荐分叉点
→ 查看 Ripple
→ 必要时反馈并重新推演
→ 创建 Worldline
→ 阅读一个值得继续的新场景
M1 重点验证三个问题：

1. 真实作品理解是否可靠；
2. 人工修正成本是否足够低；
3. 新世界线是否值得继续阅读。
### 二、明确 M1 范围

M1 必须完成：

- 至少 3 篇真实作品 benchmark；
- 1 万—6 万中文字符作品验证；
- Story Map 真实泛化能力；
- Guided Review；
- 人物/事件/Edge 的最小必要修正；
- Ripple Suggestions；
- Impact Plan feedback regeneration；
- 一个真实高质量 Continuation scene；
- M1 Eval；
- 真实用户观察测试；
- v0.2.0 发布门禁。
明确 Non-goals：

- PDF
- EPUB
- DOCX
- 百万字长篇
- 无限续写
- 多 Agent
- RAG
- 向量数据库
- 图数据库
- 模型路由
- 多模型投票
- 用户系统
- 云同步
- 多人协作
- 世界线合并
- 社交分享
- 角色聊天
- Prompt 编辑器
- 插件系统
- 复杂后台任务系统
### 三、建立 benchmarks/m1/

建议：
benchmarks/
m1/
README.md
manifest.schema.json
public/
private/   # gitignored
private 必须加入 .gitignore。
定义三类 Benchmark：
Story A：清晰线性故事

- 10k—25k 中文字符
- 4—6 核心人物
- 明确冲突/转折/结局
Story B：复杂人物和时间

- 25k—45k 中文字符
- 8—12 核心人物
- 别名/称谓/回忆/时间跳跃
- 至少一组容易错误合并人物
Story C：软因果与开放结局

- 15k—35k 中文字符
- 动机存在解释空间
- 软性 Anchor
- 非简单“删除事件”型分叉
至少一篇必须是：
“没有被 NovelRipple Prompt 作者用于调试过的真正未见作品”。
公共仓库只能存：

- 原创作品；
- 公版作品；
- 明确许可公开作品。
私人作品：

- 只存在 benchmarks/private；
- 不进入 Git；
- 不进入日志；
- 不进入截图；
- 不进入 GitHub Actions。
### 四、建立 M1 benchmark manifest

至少记录：
id
title
rights
language
characterCount
expectedCoreCharacters
expectedKeyEvents
expectedEndingCandidates
testDivergences
不要构建复杂数据平台。

### 五、更新 docs/evals.md

新增 M1 门禁：
Story Map：

- 核心人物召回 100%
- 总体人物身份 F1 >= 90%
- 单篇关键事件召回 >= 85%
- 三篇聚合 >= 90%
- Evidence validity = 100%
- 无证据关键事件 = 0
- 核心人物错误 merge = 0
- 关键 Ending Candidate 召回 = 100%
- 主要因果 Edge 人工认可率 >= 75%
人工修正成本：
<=30k 字：

- median review time <= 15 min
- material revisions <= 6
- 人工新增关键 Event <= 2
30k—60k：

- review time 目标 <= 25 min
- 系统必须提供优先核对队列
Ripple：

- 每篇至少 strict + open 各一个 divergence
- direct impact 人工认可 >= 85%
- Anchor 判断 100%
- pre-divergence mutation = 0
- 推荐 3 个分叉点中至少 2 个被人工认为有价值
Continuation：

- 硬事实冲突 = 0
- 恢复 deleted fact = 0
- pre-divergence rewrite = 0
- strict Anchor violation = 0
- worldline consistency >= 4/5
- narrative continuity >= 3.5/5
- 至少 2/3 作品“愿意继续阅读”
真实用户观察：
至少 3 次；
至少 2 名非开发参与者；
无需开发者代操作完成 First Ripple。

### 六、建立 M1 人工评测模板

例如：
docs/evals/m1-review-template.md
记录：

- Story identity
- Commit SHA
- Provider/model
- Prompt versions
- extraction metrics
- correction cost
- Ripple quality
- Continuation quality
- user observation
- PASS / FAIL
严格脱敏。

### 七、记录 Open-source preflight

可以新增：
docs/decisions/0003-m1-real-story-evaluation.md
只记录决策，不重复 mvp/evals。

### 八、禁止事项

本任务不得：

- 修改 AI Prompt；
- 修改 Story Map Schema；
- 修改生产 pipeline；
- 加新依赖；
- 做 chunking；
- 做 Review UI；
- 做 Ripple Suggestion；
- 做 Continuation 改造。
### 九、验证

运行：

```
npm run lint
```

```
npm run typecheck
```

```
npm run test:unit
```

```
npm run test:contract
```

npm test

```
npm run build
```

```
CI=1 npm run test:e2e
```

最终报告：

- 实际修改；
- Benchmark 设计；
- Open-source preflight；
- 新依赖：必须为 none，除非有无法反驳的必要性；
- M1 quality gates；
- 测试结果；
- M1-02 是否可以开始。
最终结论：

### M1-01 PASS

或

### M1-01 FAIL

完成后停止。

## M1-02｜真实作品基线测试——禁止先优化

开始 NovelRipple M1-02。
这是整个 M1 最重要的决策门。
目标：
使用当前 M0/M1-01 之后的真实生产管线，对至少三篇 M1 Benchmark 建立未经优化的 baseline。
本任务核心原则：
“先测真实失败，再决定架构。”
禁止在采集 baseline 之前：

- 改 Prompt；
- 改 Story Map Schema；
- 改 chunking；
- 改模型调用流程；
- 引入 RAG；
- 引入向量数据库；
- 引入 Python；
- 引入多 Agent；
- 为了让指标好看修改 Benchmark。
### 一、读取

AGENTS.md
docs/mvp.md
docs/domain.md
docs/evals.md
benchmarks/m1/
当前 Story Map generation pipeline
Generation Run
Live Eval 实现

### 二、建立 M1 baseline runner

新增显式命令，例如：

```
npm run eval:m1:baseline
```

它不能进入默认 CI。
要求：

1. 接受 benchmark manifest；
2. 对每篇可用作品运行真实 Story Map pipeline；
3. 使用当前生产 Prompt；
4. 不使用 Golden 内容帮助生成；
5. 只在生成结束后做评分；
6. 记录：
- provider
- model
- prompt versions
- input/output tokens
- wall-clock duration
- repair count
- Story Map event count
- character count
- Event recall
- Character recall / identity errors
- Evidence validity
- Edge manual review queue
- ending candidate recall
- model failures
7. 输出脱敏 JSON report；
8. private story 不写正文。
### 三、完整跑当前实现

每篇至少完成：
Source
→ Story Map generation
→ human review
→ confirmed Story Map
→ 一个 strict divergence
→ 一个 open divergence
→ Ripple
→ 一个 Continuation

### 四、人工记录修正成本

至少记录：

- Review 总时间；
- update_event 次数；
- character correction 次数；
- merge/split 需求次数；
- 删除 Event 数；
- 新增遗漏 Event 数；
- Edge correction 数；
- Evidence correction 数；
- Ending Candidate correction 数；
- 是否必须打开源码/数据库/Prompt 才能修正。
即使当前 UI 做不了某类修改，也要记录：
“产品能力缺失导致无法低成本修正”。

### 五、诊断失败

将所有问题分类到：
A. extraction coverage
B. character identity
C. evidence grounding
D. chronology
E. causal edges
F. ending candidates
G. review UX
H. Ripple quality
I. Continuation quality
J. performance/context window
K. provider/schema compatibility
不要直接设计解决方案。

### 六、建立架构决策门

最终必须根据数据回答：
是否需要 M1-03 section-first extraction？
只有出现以下任一证据才推荐 YES：

- 任一作品关键 Event recall < 80%
- 核心人物漏检
- Evidence grounding 明显下降
- context window failure
- frequent timeout
- 30k+ 作品质量明显下降
- 当前双全书调用成本/Token 不可接受
如果三篇已经达到 M1 Story Map 门槛：
明确推荐：
SKIP M1-03
不得为了“更高级”主动重构。

### 七、产物

建立类似：
docs/evals/runs/m1-baseline-<date>-<sha>.md
和 gitignored JSON 原始指标。
公开报告不得包含 private Source 正文。

### 八、验证现有确定性门禁

```
npm run lint
```

```
npm run typecheck
```

```
npm run test:unit
```

```
npm run test:contract
```

npm test

```
npm run build
```

```
CI=1 npm run test:e2e
```

### 九、最终只能输出一个架构结论：

### M1-02 PASS — KEEP CURRENT PIPELINE

或

### M1-02 PASS — SECTION-FIRST REQUIRED

或

### M1-02 FAIL

并给出真实数据依据。
完成后停止。
绝对不要自动进入 M1-03。

## M1-03｜仅在基线证明需要时：统一 Section-first Extraction

如果 M1-02 结论是
KEEP CURRENT PIPELINE
，这一整步跳过。
开始 NovelRipple M1-03。
前提：
M1-02 已明确给出：
SECTION-FIRST REQUIRED
如果不存在该证据，立即停止，不实现本任务。
目标：
在不引入 RAG、向量数据库、Python 服务、多 Agent 或后台队列的前提下，将 Story Map generation 改为统一、最小的 section-first extraction。
重要：
不是同时保留：
small-story pipeline
+
large-story pipeline
而是建立一条统一路径：
Source
→ Analysis Segments
→ local extraction
→ global reconcile
→ Evidence resolution
→ deterministic validation
→ Story Map Artifact
短作品只有一个 Segment。

### 一、Open-source preflight

重点研究 Google LangExtract 官方实现/文档：
只借鉴：

- segmentation
- multi-pass extraction
- precise source grounding
- overlap / dedupe 思路
禁止：

- 加 Python runtime；
- 直接复制不必要代码；
- 引入 LangExtract 依赖。
记录 preflight。

### 二、实现 deterministic AnalysisSegment

不要新建数据库表。
AnalysisSegment 由 Source 派生。
至少：
id
sourceId
sectionIds
coreStart
coreEnd
contextStart
contextEnd
原则：

- 只能在 SourceSection 边界切；
- 目标 core text 约 6k—10k 中文字符；
- 可附带最多一个相邻 section 作为 context；
- Event 只有 Evidence 主体位于 core 范围时才能由该 Segment claim；
- 不改变 Source offsets。
### 三、局部 Extract

每个 Segment：

- 使用同一个 Extractor Prompt；
- 输出 local Characters / Events / Edges；
- Evidence 仍返回 exactQuote；
- 不产生正式 IDs；
- 每段最多一次 repair。
并发：
最多 2 个 segment。
不引入 queue。

### 四、Global Reconcile

Global Reconcile 输入：

- Segment candidates；
- Source section index；
- 必要 Evidence references。
不要再次把整部 Source 原文全部发送一遍，除非 M1-02 数据证明必须。
Global Reconcile 负责：

- alias merge；
- duplicate Event merge；
- global chronology；
- cross-segment edges；
- ending candidates。
### 五、重复检测

必须防止 overlapping context 导致：

- 重复人物；
- 重复事件；
- 重复 Edge。
### 六、失败语义

任意 Segment 失败：

- 不保存正式 Story Map；
- Generation Run 保留；
- 不保存半成品 Artifact；
- 最多一次 repair；
- 不无限 retry。
### 七、兼容现有领域模型

禁止改变：

- Source immutability；
- Evidence format；
- Story Map revision model；
- Impact Plan；
- Worldline；
- Continuation。
除非 M1-02 有明确数据证明 Schema 必须改变。

### 八、测试

增加：

- 1-segment story；
- multi-segment story；
- boundary Event；
- overlapping context dedupe；
- alias across segments；
- cross-segment causal edge；
- failure rollback；
- Evidence offsets unchanged。
### 九、真实 Benchmark 回归

重新跑 M1 baseline。
必须证明：

- 至少解决 M1-02 的真实失败；
- 质量达到/接近 M1 门槛；
- 没有明显增加 correction cost；
- Token/latency 有记录。
如果没有改善：
本步骤必须报告失败，不得因为实现了新架构就保留。

### 十、全量门禁

```
npm run lint
```

```
npm run typecheck
```

```
npm run test:unit
```

```
npm run test:contract
```

npm test

```
npm run build
```

```
CI=1 npm run test:e2e
```

最终：

### M1-03 PASS

或

### M1-03 FAIL

完成后停止。

## M1-04｜Guided Story Map Review

开始 NovelRipple M1-04。
目标：
把 M0 的“看整张 Story Map 并手工修改”升级为：
系统主动告诉用户最值得核对什么，
用户用尽可能少的操作让 Story Map 达到可信状态。
不要做通用图编辑器。

### 一、建立 Review Queue

Review Queue 必须是 Story Map 派生视图，不新增数据库事实源。
优先展示：

1. inference Events；
2. confidence 较低的 Event/Edge；
3. alias 较多人物；
4. 潜在 identity merge 风险；
5. Ending Candidates；
6. High-leverage divergence candidates；
7. 未确认的重要 Evidence；
8. 领域 validator 无法自动确认但不构成硬失败的项目。
不能创建“AI 评分 92 分”这种不可解释总分。

### 二、Readiness Checklist

界面明确展示：

- 关键 Event 均有 Evidence
- 核心人物已核对
- Ending Candidates 已核对
- 无非法引用
- 无悬空 Edge
- 当前 Story Map 可以进入 Ripple
### 三、人物修正

实现最小能力：

- rename Character
- edit aliases
- edit role
- merge Characters
- split Character（仅在真实 benchmark 有需求时）
- reassign Event participants
merge/split 必须：

- 创建 revision；
- 更新所有关联引用；
- 使受影响 Evidence confirmations 失效；
- deterministic validation；
- old Artifact immutable。
### 四、事件修正

支持：

- update Event
- delete erroneous Event
- add missing Event from selected Evidence
- reorder Event
- reassign participants
“新增 Event”必须：
先选择 Source Evidence
→ 再填写 Event
禁止无 Evidence 新增 Canon Event。

### 五、Edge 修正

支持：

- delete Edge
- add Edge between existing Events
- change Edge type
- update explanation
- attach/confirm Evidence
Edge type 永远只有：
causes
enables
foreshadows

### 六、版本语义

每次 material correction：
新 Story Map revision。
不得：

- 原地修改；
- 自动覆盖；
- 修改 Source；
- 跳过 stale revision check。
### 七、Review 操作统计

为了 M1 correction-cost evaluation，记录派生指标或轻量 operation metadata：

- correction type
- timestamp
- Story Map version
不要建立分析平台。

### 八、UX

用户默认只看 Review Queue。
完整图属于 secondary view。
Review 完成后给唯一主操作：
“确认 Story Map 并进入 Ripple”

### 九、E2E

至少覆盖：

- Character merge；
- Event add with Evidence；
- Event delete；
- reorder；
- Edge add/change/delete；
- confirmation invalidation；
- stale revision；
- final confirmed；
- refresh recovery。
### 十、真实 Benchmark

重新测三篇：

- review time
- material revision count
- manual Event additions
- 是否达到 M1 correction-cost gate。
### 十一、测试

```
npm run lint
```

```
npm run typecheck
```

```
npm run test:unit
```

```
npm run test:contract
```

npm test

```
npm run build
```

```
CI=1 npm run test:e2e
```

最终：

### M1-04 PASS

或

### M1-04 FAIL

完成后停止。

## M1-05｜Ripple Suggestions + Feedback Regeneration

开始 NovelRipple M1-05。
目标：
解决两个真实用户问题：

1. 我不知道应该从哪里改；
2. AI 的 Ripple 有一个关键判断不对，我希望指出后重新推演，而不是进入聊天。
### 一、Ripple Suggestions

仅对 confirmed Story Map 生成。
返回最多 3 个 suggestion。
每个包括：

- eventId
- divergenceType
- instruction
- whyInteresting
- affectedCharacterIds
- anchorRisk
建议类型仍然只能：
prevent
choice
outcome
要求：

- recommendation 只是候选；
- 不自动生成 Impact Plan；
- 不自动创建 Worldline；
- 不预生成分支；
- 手动地图选点入口永远保留。
### 二、Suggestion Artifact

优先使用现有 Artifact 机制。
不要建立新服务。
如果现有 artifact.kind enum 需要扩展：
只增加明确的 `ripple_suggestions`。
不要新建 suggestions 表。

### 三、生成策略

输入最小上下文：

- confirmed Story Map；
- key events；
- character roles；
- ending candidates；
- causal graph。
不得发送整部 Source，除非必要 Evidence excerpt。

### 四、推荐质量

不得推荐：

- 无实际后续影响的装饰性事件；
- 已经没有后续空间的结局后事件；
- 纯世界背景说明；
- 改了却几乎没有涟漪的节点。
### 五、Ripple Preview 对比

现有 Preview 增加更直观差异：
原路径
新路径
删除
修改
新增
保持不变的关键事实
不要增加复杂 Timeline 引擎。

### 六、用户反馈

用户可以针对当前 candidate 输入一个明确反馈，例如：
“周岚虽然没拿到原件，但看过照片，所以不应退出调查。”
这不是聊天。
只有一次明确反馈 → 生成新 candidate。

### 七、Candidate Lineage

必须保存：
priorCandidateArtifactId
feedback
newGenerationRunId
sameStoryMapArtifactId
sameDivergence
sameMode
sameAnchors
旧 Candidate 永远保留。
新 Candidate：
必须重新经过：

- Schema
- Evidence/domain references
- reasonPath
- Anchor
- pre-divergence invariants
不能只局部 patch 原 JSON。

### 八、Feedback 限制

M1 允许连续再次反馈，但每次都是新的明确 Candidate revision。
不得建立：

- chat_messages
- conversation memory
- autonomous agent loop。
### 九、测试

覆盖：

- exactly <=3 suggestions
- invalid Event rejected
- suggestion no worldline writes
- manual selection still works
- feedback produces new candidate
- old candidate immutable
- feedback cannot change divergence silently
- feedback cannot change anchors silently
- invalid regenerated candidate fail closed
- accepted candidate only one chosen lineage
### 十、Benchmark

三篇作品：

- 每篇生成三个推荐节点；
- 人工判断至少 2/3 “值得改变”；
- 每篇至少测试一条 feedback；
- feedback 后问题被解决且没有硬违规。
### 十一、全量门禁

```
npm run lint
```

```
npm run typecheck
```

```
npm run test:unit
```

```
npm run test:contract
```

npm test

```
npm run build
```

```
CI=1 npm run test:e2e
```

最终：

### M1-05 PASS

或

### M1-05 FAIL

完成后停止。

## M1-06｜真实作品单场景 Continuation 质量

开始 NovelRipple M1-06。
目标：
不增加无限续写，不增加章节系统，只提高“一条新世界线的第一个场景”在真实作品上的一致性、连续性和阅读价值。
仍然保持：
3 directions
→ user selects 1
→ 1 scene

### 一、保持现有硬约束

不能破坏：

- Source immutability
- accepted Impact Plan
- Worldline Delta
- strict Anchors
- pre-divergence Canon
- statePatch validator
- generated fact namespace
### 二、Scene 长度

目标：
1200—2000 中文字符。
这是目标范围，不要用截断制造假合规。
过短应视为质量问题。

### 三、风格上下文

不要建立 Style Model、embedding 或 Style Artifact。
使用 deterministic representative excerpts。
最多选择：

- 开头代表片段
- 中段代表片段
- 结尾代表片段
- divergence 周边片段
- selected characters 相关 Evidence
设置总字符预算。

### 四、风格原则

目标不是“复制作者文风”，而是：

- 叙事人称一致；
- 时态/视角一致；
- 对话密度相近；
- 句式不突兀；
- 不突然变成说明文；
- 不复制长段 Source。
### 五、Context Selector

建立纯函数：
selectContinuationContext(...)
输入：
Story Map
Source
Worldline
accepted Impact Plan
selected direction
输出：
bounded context packet
必须测试：

- deterministic；
- source grounded；
- no unrelated whole-book dump；
- max context budget。
### 六、Scene Quality Contract

模型输出保持：
title
prose
statePatch
不要增加复杂文学评分字段到生产 Schema。
质量通过 Eval 评判。

### 七、Consistency

自动检查继续覆盖：

- resurrected removed facts
- deleted accepted facts
- pre-divergence mutation
- Anchor deletion
- invalid character
- invalid thread
### 八、人工量表

新增：
Worldline consistency 1—5
Character continuity 1—5
Narrative continuity 1—5
Scene interest 1—5
Would continue reading yes/no
M1 gate：

- worldline >= 4
- narrative >= 3.5
- 至少 2/3 benchmark 愿意继续阅读
### 九、测试

增加：

- bounded context
- correct excerpts
- no whole source
- output length
- prose non-empty
- existing statePatch hard gate
- real benchmark manual report structure
### 十、不要做

- Scene 2
- Chapter 2
- auto continue
- long-term memory
- summary compaction
- vector retrieval
- agent writer
- style fine-tuning
### 十一、全量门禁

```
npm run lint
```

```
npm run typecheck
```

```
npm run test:unit
```

```
npm run test:contract
```

npm test

```
npm run build
```

```
CI=1 npm run test:e2e
```

随后运行三篇真实 benchmark Continuation。
最终：

### M1-06 PASS

或

### M1-06 FAIL

完成后停止。

## M1-07｜建立 M1 Real Story Eval 与真实用户测试

开始 NovelRipple M1-07。
本步骤禁止新增产品功能。
目标：
建立可以真正回答“NovelRipple 在真实故事上是否已经达到 v0.2.0 发布标准”的完整证据链。

### 一、建立 npm run eval:m1

不得进入默认 PR CI。
必须读取 M1 benchmark manifest。
对每篇输出：
IDENTITY

- benchmark id
- rights mode
- character count
- commit SHA
- provider/model
- prompt versions
STORY MAP

- core character recall
- identity F1
- key event recall
- evidence validity
- unsupported event count
- critical merge mistakes
- ending candidate recall
- causal edge manual approval
CORRECTION COST

- review duration
- revision count
- manual event additions
- character fixes
- edge fixes
RIPPLE

- suggestion approval
- direct impact approval
- anchor result
- pre-divergence violations
- feedback resolution
CONTINUATION

- statePatch conflict
- worldline consistency
- character continuity
- narrative continuity
- scene interest
- would continue reading
PERFORMANCE

- model calls
- repair count
- tokens
- wall-clock duration
### 二、聚合门禁

自动计算：

- per-story thresholds
- aggregate thresholds
- hard invariant failures
### 三、真实用户观察

至少三次 session。
至少两名用户不是 NovelRipple 开发者。
测试流程：

1. 给用户作品；
2. 不解释内部架构；
3. 用户自己导入；
4. 自己完成 Story Map review；
5. 自己选择或使用 recommendation；
6. 看 Ripple；
7. 创建 Worldline；
8. 阅读 Continuation；
9. 回答四个问题：
- 原故事最重要的冲突是什么？
- 你改变了什么？
- 为什么后面会变化？
- 新世界线与原作最大差别是什么？
记录：

- 是否独立完成；
- 阻塞点；
- 错误理解；
- 是否需要开发者代操作；
- 用户是否愿意继续使用。
不得录入隐私正文。

### 四、人工报告

建立：
docs/evals/runs/m1-<date>-<sha>.md
可公开的只放脱敏数据。

### 五、最终 Gate

只有同时满足：

- 三篇 benchmark Story Map gate；
- correction-cost gate；
- Ripple gate；
- Continuation gate；
- user observation gate；
- hard invariants 0 failures；
才输出：
M1 EVAL PASS
否则：
M1 EVAL FAIL

### 六、禁止

不要为了过线：

- 修改 threshold；
- 删除失败 benchmark；
- 给模型看 Golden；
- 手工修改模型输出后当自动结果；
- 用 Fixture 代替真实作品。
### 七、全量确定性验证

```
npm run lint
```

```
npm run typecheck
```

```
npm run test:unit
```

```
npm run test:contract
```

npm test

```
npm run build
```

```
CI=1 npm run test:e2e
```

### 八、最终报告

明确列出：
PASS metrics
FAIL metrics
known limitations
P0/P1 blockers
whether v0.2.0 can release
完成后停止，不进入 M1-08。

## M1-08｜最终封版 v0.2.0 Gate

这一条只在 M1-07 PASS 后执行。
开始 NovelRipple M1-08 最终 Release Gate。
前提：
M1-07 已明确：
M1 EVAL PASS
如果不是，立即停止。
本步骤只做发布检查与必要的发布文档，不新增产品功能。

### 一、读取

AGENTS.md
README.md
docs/mvp.md
docs/domain.md
docs/evals.md
M1 最终 Eval Report
M0 Release v0.1.0
GitHub Actions
open issues
M1 milestone

### 二、检查 M1 全部验收

确认：

1. 至少三篇 Real Story；
2. Story Map 指标过线；
3. Correction Cost 过线；
4. Ripple 指标过线；
5. Continuation 指标过线；
6. 用户观察过线；
7. 无 P0/P1；
8. 当前 main GitHub Actions 全绿；
9. Source / Artifact / Worldline 不变量未回归；
10. M0 v0.1.0 未被修改。
### 三、README

更新 Current Status：
M1 — Real Story complete
只描述真实已验证能力。
不要写未来承诺。

### 四、docs/mvp.md

将 M1 标记为完成。
保留验收事实。
不要开始写 M2 产品合同。

### 五、Release Notes 草案

准备：
v0.2.0
M1 — Real Story
内容聚焦：

- Real Story support
- Guided Review
- Character/Event/Edge correction
- Ripple Suggestions
- Ripple feedback regeneration
- Real Story Continuation
- M1 Eval
- user observation evidence
### 六、最终验证

从干净依赖开始：
npm ci

```
npm run lint
```

```
npm run typecheck
```

```
npm run test:unit
```

```
npm run test:contract
```

npm test

```
npm run build
```

```
npx playwright install chromium
```

```
CI=1 npm run test:e2e
```

```
npm run eval:m1
```

确认最新 GitHub Actions main gate 为 green。

### 七、Git 状态

确保：

- 没有意外文件；
- 没有 private benchmark；
- 没有 .env；
- 没有 database；
- 没有 raw model output；
- 没有 private source；
- 没有 secrets。
### 八、不要自行执行以下操作

除非我明确要求：

- git tag
- git push
- GitHub Release
- close milestone
- start M2
### 九、最终只能给：

M1 PASS — READY FOR v0.2.0
或
M1 FAIL — NOT READY
同时列出阻塞项。
完成后停止。
每一关完成后通用审核命令
每次 Codex 完成一个 M1 Issue 后，如果你想让它自己先做一次最终自查，再交给我审核，可以追加下面这一条：
现在不要继续下一阶段。
请作为独立 Reviewer 对你刚刚完成的本阶段做一次反向审查。
要求：

1. 重新读取 AGENTS.md 和本 Issue 验收条件。
2. 不相信你自己的实施报告，只检查实际代码、diff、测试和数据。
3. 重点寻找：
- 是否扩大范围；
- 是否引入未经证明的复杂度；
- 是否产生第二事实源；
- 是否破坏 immutable Source / Artifact / Worldline；
- 是否存在 fail-open；
- 是否存在 silent fallback；
- 是否有测试只证明实现而没证明用户结果；
- 是否给未来 M2 提前铺架构；
- 是否使用 Benchmark Golden 污染模型输入；
- 是否泄露真实作品。
4. 实际重新运行必要测试。
5. 最后只给：
PASS
或
FAIL

6. FAIL 时按 P0/P1/P2 列问题。
7. 不自行修复，不进入下一阶段。
整体执行原则
整个 M1 开发过程中始终遵循：
先测真实问题
→ 再修最痛问题
→ 再验证真实改善
→ 没有证据就不加复杂度
任何时候如果 Codex 提议：
RAG
Embedding
Vector DB
Graph DB
Multi-Agent
Workflow Engine
Redis
Queue
Microservices
LangChain
Python service
Model router
都必须先回答：
“哪一项已经存在的 M1 Benchmark 数据证明，没有它就无法达到当前验收标准？”
无法回答，则不允许引入。
你现在可以直接从
M1-00
开始。真正最关键的是
M1-02
：在那之前不要让 Codex“聪明地”优化 Story Map 管线，因为这一步会决定后面的 M1-03 到底需不需要存在。
