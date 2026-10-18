# 质量与评测

M0 将确定性正确性和模型质量分开验证。确定性门槛必须在每次变更中通过；真实模型评测暂不进入默认 CI。

## 阻塞与不阻塞（2026-10-17 起）

见 [`0005：评测从"阻塞门禁"改为"质量仪表盘"`](decisions/0005-eval-dashboard-not-gate.md)。

- **阻塞**：本文件的 11 条硬不变量，以及默认 CI（lint、typecheck、Vitest 单元与合约、build、Chromium E2E）。真实作品评测中只有四条硬规则——原文与分歧前历史不被覆盖、证据可溯源、世界线隔离、坏输出被拒绝——被测到违反时才阻塞，`npm run eval:m1` 以非零退出。
- **不阻塞**：下文 M1 各节列出的召回率、修正成本、人工评分与真人观察阈值是**质量目标**。`npm run eval:m1` 把它们画在仪表盘上（`met` / `below_target` / `not_measured`），用来决定下一步优先改什么，但不再阻止开发、合并或发布内部版本。
- **真人观察可选**；**作者自评是有效人工评分**（人工评分可选填 `reviewer: "author" | "external"`，缺省为 `author`）。
- 缺失数据记为 `not_measured`，不等于失败。
- 阈值数值不因此调低；历史报告（含 M1-07 FAIL）保留原样作为仪表盘历史数据。

## 封版报告索引

- [`v0.1.0 M0 正式封版报告（PASS）`](evals/runs/2026-08-12-v0.1.0-m0-release-pass.md)：M0 确定性发布门禁的唯一正式 PASS 记录，并明确它不代表真实模型 Live Eval PASS。
- [`2026-08-12 Live Eval 配置失败记录（Historical / FAIL）`](evals/runs/2026-08-12-2e85d21-m0-live-eval.md)：保留用于证明配置缺失时 fail closed；它不是封版 PASS 报告。
- [`M1-02 未优化 baseline 输入审计（FAIL）`](evals/runs/m1-baseline-2026-08-12-c9ae2e3.md)：记录 M1-01 后仓库没有三篇冻结 Benchmark、当前运行环境没有真实 Provider 配置，因此没有模型数据，不能作 section-first 架构判断。
- [`M1-02A 错误模型运行记录（Historical / INVALID）`](evals/runs/2026-08-12-m1-02a-provider-evidence-compatibility.md)：三篇均生成 Artifact，但实际 model 为 `deepseek-v4-flash`，不满足与 M1-02 历史 baseline 使用同一 `deepseek-chat` 的前提，不参与 M1-02A 结论。
- [`M1-02A Provider & Evidence Grounding Compatibility（PASS）`](evals/runs/2026-08-12-m1-02a-provider-evidence-compatibility-deepseek-chat.md)：三篇冻结私人作品在与 M1-02 相同的 `deepseek-chat`、显式 `json_object`、Prompt v2 与 Evidence Unit grounding 下均创建 Artifact，Evidence validity 为 100%；完整 M1-02 仍等待人工复核，未授权 M1-03。
- [`M1-02 Real Story baseline（FAIL）`](evals/runs/m1-baseline-2026-08-12-37aeb6b.md)：正式 `deepseek-chat` baseline 的人物与 Ending coverage 未过门槛；人工复核缺少稳定 ID 一对一评分，用户未能理解并完成 First Ripple，数据库中 Ripple / Worldline / Continuation 均为 0。报告保留 section-first 证据，但 M1-02 未完成，不能自动进入 M1-03。
- [`M1-02 架构决策补充（PASS — SECTION-FIRST REQUIRED）`](evals/runs/m1-02-architecture-decision-2026-08-12-1882e37.md)：用户接受现有真实失败数据作为架构门的充分证据；核心人物漏检已单独触发 section-first 条件。原产品质量 FAIL 报告保持不变，M1-03 仍等待独立授权。
- [`M1-03 Section-first 真实作品回归（FAIL）`](evals/runs/m1-03-section-first-2026-08-13.md)：统一 section-first 候选在同一 `deepseek-chat / json_object` 上三篇均因局部逐字 Evidence claim 在一次 repair 后仍无效而未创建 Artifact；按预设 retention gate 已撤销生产实现，不能把不完整运行的 token 降低解释为质量改善。
- [`M1-04 Guided Review 真实候选回归（FAIL）`](evals/runs/m1-04-guided-review-2026-08-13-afd432b.md)：三篇冻结私人候选均可派生优先队列与 readiness，公开 fixture 的全部不可变修正和 E2E 通过；Story A 已取得一次真人计时观察（7 分钟、16 次修正），但 B/C 未测且 A 的 material revisions 超过门槛，不能放行 correction-cost gate。
- [`M1-05 Ripple Suggestions 与反馈重推真实回归（PASS）`](evals/runs/m1-05-ripple-guidance-2026-08-13-97766a5.md)：同一 `deepseek-chat / json_object` 下三篇均生成 3 个推荐、初始 candidate 与反馈后不可变 revision，自动硬不变量全部通过；2026-08-13 人工语义复核完成（每篇推荐价值 ≥2/3、反馈问题解决），M1-05 放行。
- [`M1-06 单场景 Continuation 质量（PASS）`](evals/runs/m1-06-continuation-2026-08-14-d3abd3fd.md)：`deepseek-v4-flash / json_object` 下三篇均一次完成 directions→scene 全链路，场景长度 1274–1396 汉字全在目标区间、六项一致性 hard gate 与五项隔离全部通过；2026-08-14 人工量表完成（三篇 worldline/character/narrative/interest 全 5、愿意继续读 3/3），M1-06 放行。
- [`M1-07 M1 Real Story Eval 聚合与最终 Gate（FAIL）`](evals/runs/m1-07-final-2026-08-14.md)：`npm run eval:m1` 聚合六大块指标与全部门禁；Story Map gate 三篇 FAIL（Ending Candidate recall A/B 66.7%、C 50%，聚合 identity F1 83.3%）、correction cost A 超限（16 revisions）且 B/C 未观察、Ripple strict B/C 通过 A 无法评测（anchor 缺口实证）、Continuation PASS、用户观察未开始；当时判为 v0.2.0 不可发布并停止；按 0005 该结论现在只作为质量仪表盘的历史数据点，不再阻塞后续开发。

后续运行不得覆盖既有报告；每次 Eval 使用新文件记录 commit、模型、Prompt 版本和结论。同一运行在人工复核后结论翻转（如 FAIL → PASS）时，应在原报告追加"人工语义复核记录"章节并同步更新本索引条目，两处结论必须一致；跨运行的新结果始终写入新文件。真实模型质量只有在自动阈值和脱敏人工复核均完成时才能标记"达标"；未达标只记录在仪表盘上，不阻塞（见 0005）。

## 硬不变量

以下规则全部是放行条件。任一失败都必须拒绝当前候选、阻止状态推进并返回可诊断错误：

1. **Source 不可覆盖**：已有 Source 的原文、规范化文本和内容 Hash 不得被导入、重试、分歧或续写操作修改；正文变化必须创建新 Source。
2. **Evidence 必须定位到有效原文**：引用的 Source 与 section 必须存在，偏移必须为原文边界内的非空范围，切片 Hash 必须与 `excerptHash` 一致。
3. **Event ID 唯一**：同一 Story Map 版本内不得出现重复 Event ID。
4. **Edge 不可悬空**：每条 Edge 的起点和终点 Event 必须存在于同一 Story Map 版本，类型只能是 `causes`、`enables` 或 `foreshadows`。
5. **participant 必须存在**：Event 的每个 participant 都必须引用同一 Story Map 版本中存在的 Character。
6. **Worldline 不修改 Canon**：创建或继续任何 Worldline 后，Source、Canon、父世界线和兄弟世界线必须保持不变。
7. **未确认 Impact Plan 不可改变 Worldline**：Preview 可保存候选 Artifact 和 Generation Run，但未接受、失效或校验失败的 Impact Plan 不得创建 Canonical / 子 Worldline、写入 Delta 或触发 Continuation。
8. **严格模式不可静默破坏 Anchor**：每个结局 Anchor 都必须有明确状态；无法兼容时必须返回 `incompatible` 并阻止严格模式世界线创建。
9. **Story Map 必须绑定明确版本**：Story Map 必须绑定 Source 和自身版本；确认、Divergence 与 Impact Plan 都必须引用具体版本，不得自动漂移到其他版本。
10. **非法 AI 输出必须 fail closed**：所有模型结构化输出必须先通过 Schema，再通过 Evidence、引用完整性和领域不变量校验。缺字段、未知枚举、无效引用或语义不变量失败时拒绝整个候选，不得猜测、补字段、部分采用或静默 fallback。
11. **Continuation 不得恢复或倒改世界线事实**：方向必须引用已存在人物；场景新增事实只能进入 `generated:` 命名空间，不得恢复已删除事实，也不得删除 accepted Delta、分歧前 Canon 或严格模式 Anchor 目标。一次定向 repair 仍失败时，Generation Run 标记失败且不得写入场景 Artifact。

## 四层验证

### 1. 领域单元测试

使用 Vitest 覆盖：

- Zod Schema 拒绝非法结构；
- Evidence Offset 与 Hash；
- Story Map 唯一 ID、参与人物和边引用；
- Anchor 状态与 fail-closed；
- Worldline 创建前必须接受 Impact Plan；
- 幂等键与父/兄弟世界线隔离。
- Worldline Delta 确定性派生与 Canon 不变；
- Continuation 方向人物引用与 state patch 冲突检测。

### 2. 合约测试

使用固定模型响应样本验证：

- 合法响应可以形成候选 Artifact；
- 非法 JSON、缺证据和悬空引用被拒绝；
- 如需重试，只能重新请求一个新的完整响应并从头校验；不得修补或部分采用非法响应，失败后不留下半提交状态；
- Prompt / Schema 版本变化必须显式迁移。

独立运行命令为 `npm run test:contract`；`npm test` 仍会执行完整 Vitest 集合。

### 3. 浏览器 E2E

使用 Playwright 和公开夹具覆盖：

```text
创建项目 → 导入基准故事 → 生成并确认 Story Map → 查看 Evidence
→ 生成涟漪预览 → 接受 → 创建 Worldline → 生成三个方向
→ 选择一个方向 → 生成一个场景 → 继续 / 重试本幕 / 换一批 → 刷新恢复
```

默认只运行 Chromium；增加浏览器矩阵前先证明存在兼容性需求。

### 4. Live Eval 与人工复核

`npm run eval:live` 使用真实 OpenAI-compatible 配置和 `ripple-001`，不属于 `npm test`、`npm run check` 或默认 CI。它在临时 SQLite 数据库中实际运行 Story Map、三个 Ripple 案例和一条 Continuation，向终端打印摘要，并将不含 Source 正文、Prompt、密钥或原始模型响应的 JSON 报告写入 `.data/evals/m0-live-eval/<run-id>.json`（每次运行新文件，不覆盖历史）。供应商、模型与 Structured Output 模式来自 `.env.local` / `.env` 中的现有服务端配置；Mock 配置会被明确拒绝。

自动评分只判断可以确定重现的合同：

- 关键事件通过 Golden 与候选 Evidence 区间的一对一重叠映射计算，避免依赖模型措辞或内部 ID；
- 人物通过姓名和别名归并计算；
- Evidence 逐条检查 Source、section、Offset 与 Hash；
- 一级影响按映射后的受影响事件、变化类型和同一领域 Validator 的 `reasonPath` 合同共同计算；路径合同失败时不得命中，并直接阻止 Live Eval 放行；
- Anchor 按映射后的结局目标比较，严格不兼容案例必须得到 `incompatible`；
- Continuation 对照 accepted Worldline Delta 检查结构化 `statePatch`。

Live Eval 跨运行比较时，Golden Source 与本次导入的 Candidate Source 可以拥有不同 ID；评分器先要求两者 `contentHash` 相同，再分别依据各自 Source 校验 Story Map 与 Evidence，只有校验有效的引用才按 section、offset 和双向覆盖率参与事件映射。这是 Eval 专用的同内容比较规则，不改变生产路径的绑定语义：Story Map 和每条 Evidence 仍必须引用其所属 Source 的真实 ID。

Golden 没有穷举全文所有合理事件。因此，有合法 Source Evidence 但未匹配 Golden 的事件只进入 `source-backed unmatched` 人工复核清单，不自动判为 hallucination；叙事语义幻觉、主要因果边认可率和场景正文语义仍由人工按 `fixtures/ripple-001/rubric.md` 复核。确定性非法引用、无有效 Evidence 事件与恢复已删除事实则直接使 Live Eval 失败。

最终人工验收使用脱敏的 [`M0 Live Eval 人工复核模板`](evals/m0-live-review-template.md)。自动报告中的每个 `source-backed unmatched` Event 都必须在人工报告中记录 disposition；即使列表为空也要明确记录 `none`。人工报告只保存 ID、比例、判断和简短理由，不得保存 Source 正文、完整 Prompt、密钥或 raw model output。

真实模型质量不进入默认 CI。存在待验收模型输出时，报告记录供应商、模型、全部 Prompt 版本、事件与人物召回、Evidence 有效率、一级影响命中、Anchor 结果、非法/待复核事件和 Continuation 矛盾；人工补充因果认可率与相对上次退化项。

## `ripple-001` 最低质量门槛

- 核心人物识别率：100%；
- 人工标记关键事件召回率：至少 80%；
- 关键事件证据有效率：100%；
- 主要因果边人工认可率：至少 70%；
- 预设分歧的一级影响召回率：100%；
- 明确不兼容 Anchor 案例必须 100% 返回 `incompatible` 并被拦截；
- Continuation 恢复已被世界线删除或否定事实的次数必须为 0。

这些是 M0 工程基线，不是长期产品 KPI。

## M1 — Real Story 评测集

M1 使用 [`benchmarks/m1/`](../benchmarks/m1/) 定义的 Story A、B、C。三篇作品必须分别运行并单独报告，不允许只用聚合结果掩盖单篇失败；至少一篇必须满足真正未见作品条件。公共作品可提交脱敏报告，私人作品的正文、manifest、原始输出和本地报告只保存在被 Git 忽略的 `benchmarks/private/` 或 `.data/evals/`。

`NOVELRIPPLE_BENCH_ROOT` 的 realpath 只能是仓库外目录，或 Git 忽略的 `<repo>/benchmarks/private` 及其子目录；文件系统根和仓库内其它路径（如 `docs/`、`src/`）会在运行前被拒绝。

完成报告使用 [`M1 人工评测模板`](evals/m1-review-template.md)。每次运行创建新报告，不覆盖旧报告；报告只记录稳定 ID、计数、比例、评分和简短理由。

`npm run eval:m1:baseline -- --manifest <A> --manifest <B> --manifest <C>` 是 M1 的显式、非 CI baseline 入口。它必须使用 Story A/B/C、至少一篇经 Prompt 作者确认的 unseen 作品和真实 OpenAI-compatible 配置，直接运行当前生产 Story Map 管线。每次新建 `.data/evals/m1-baseline/<run-id>/metrics.json` 与 `eval.db`；Gold 只在 candidate 完整生成后评分。自动报告中的 Event recall、Ending Candidate recall 和 Edge 队列在独立人工复核前保持 `null` / pending，不得把字符串近似或被测模型自评冒充人工事实。

### 自动 Gold 匹配（loose 邻近信号 / strict 内容匹配 / chance 与对抗基线）

私有 Benchmark（`benchmarks/private/` 或 `NOVELRIPPLE_BENCH_ROOT` 指向的根）可以在 manifest 同目录放一份 `gold.json`。baseline 在运行前加载并校验它，candidate 完整生成后只用它评分；公共根不读取 gold。报告只写入稳定 ID、计数与比例，不写入 gold 文本。

自动匹配同时报告 loose、strict、chance baseline 与对抗基线，只用于调参观察，**不得作为放行门禁**：

- **loose**（顶层 `events` / `edges` / `endings`，保持旧行为）：Event 的候选 Evidence 偏移映射到 Unit；与 gold 事件的最小 Unit 距离不超过 `UNIT_WINDOW`（2）且人物有交集才算候选匹配，再按共享 Unit、距离、共享人物和 ID 做一对一贪心。Causal Edge 经同一 Event 匹配映射到 gold，方向必须一致；任意 edge type 都算命中。Ending 的候选自身或目标事件 Unit 距 gold 结局不超过 2 且人物有交集。loose 只说明“位置接近”，不比较文本内容。
- **strict**（`strict` 块）：Event 要求至少一个候选 Evidence Unit 与 gold Unit **精确相等**（`STRICT_UNIT_WINDOW = 0`），人物交集规则与 loose 相同，并通过内容检查：`recall >= STRICT_CONTENT_RECALL`（0.2）且 `precision >= STRICT_CONTENT_PRECISION_FLOOR`（0.08）。`contentOverlap(goldText, candidateText, characterNames)` 返回 `{ recall, precision, f1 }`，tokenisation 与旧口径相同：文本先去掉空白、标点和符号，CJK 取字符 bigram，ASCII 取小写单词；两侧都剔除中文停用 bigram（`CJK_STOPWORD_BIGRAMS`，以及两个字符都在 `CJK_STOP_CHARS` 中的 bigram）和所有 gold / candidate 人物名（含别名）覆盖的文本；再计算 `R = |G∩C|/|G|`、`P = |G∩C|/|C|`（token SET，任一侧为空为 0）。recall 承载短 gold label 对更长转述的匹配；precision floor 拒绝整段抄原文（复制源文段落的 precision 通常低于 0.05）与堆砌。Event 的候选文本是 `title + summary`；strict 事件按 `(recall desc, Unit distance asc)` 做一对一贪心。strict Edge 只使用 strict Event 映射，其余规则与 loose 相同。strict Ending 只接受候选自身 Evidence Unit 与 gold Ending 自身 Unit **精确相等**，不再使用“目标事件 Unit”替代；gold Ending 有 `characterIds` 时要求人物交集，并对 `gold.label` 与候选 `requirement` 应用同一 recall + precision floor 检查。`strictMinimumContentRecall` / `strictContentPrecisionFloor` 可覆盖两个默认值；loose 匹配不变。
- **chance baseline**（`chanceBaseline`）：纯确定性、不调用模型。`matched` 使用与 gold 相同的事件数，把 Evidence Unit 均匀铺满全篇，按 gold 的 Edge 数上限串联相邻事件，并把与 gold 相同数量的结局均匀放在最后 20% 的 Unit；`dense` 每 3 个 Unit 放一个空事件。两者都使用全部 gold 人物作为参与者，事件标题为“事件 n”、摘要/结局要求不含内容，并分别用 loose 与 strict 评分（F1/P/R 分 events / edges / endings）。
- **对抗基线**（同一 `chanceBaseline` 下的 `stuffing` / `sourceCopy`，也分别用 loose 与 strict 评分）：`stuffing` 与 `matched` 布局相同，但每条 title / summary / requirement 都填入源文最高频的 30 个非停用 CJK bigram（按频次降序、token 升序确定）；`sourceCopy` 与 `matched` 布局相同，但事件 title 复制证据 Unit 的前 20 个字符、summary 复制该 Unit 全文，结局 requirement 复制其证据 Unit 全文。两者都使用全部 gold 人物作为参与者。
- **whole-unit gold-aligned copy 基线**（`chanceBaseline.goldAlignedCopy`，同样 loose / strict 评分）：每个 gold 事件生成一条事件，证据只取该 gold 事件自身的 Evidence Unit（按顺序去重），title 为拼接 Unit 文本的前 20 个字符、summary 为拼接全文；每个 gold 结局生成一条结局，证据取该结局自身 Unit、requirement 为拼接原文，target 指向 sequence 最大的 gold 对齐事件；边按 matched 方式串联（数量为 `min(gold causal links, events - 1)`），participants 为全部 gold 人物。
- **truncated gold-aligned copy 基线**（`chanceBaseline.goldAlignedTruncatedCopy2x` / `.goldAlignedTruncatedCopy4x`，同样 loose / strict 评分）：位置、participants 与 edges 和 `goldAlignedCopy` 完全相同，但每个事件 summary / 结局 requirement 只保留 gold 对齐拼接原文的前 `factor × gold label 的 Unicode code point 数` 个字符（至少 1 个、最多全文），事件 title 取截断文本前 20 个字符；`factor` 分别为 2 和 4，对应常量 `GOLD_ALIGNED_TRUNCATION_FACTORS`。`goldAlignedCopy` 与两条 truncated 基线都不是复制能拿到的上界，只用于观察不同复制长度下的得分变化。
- **strict 内容检查的已知限制**（2026-10-18，按 #6 最终运行 `563c27b` 逐对核对）：
  - precision 下限 0.08 紧贴真实摘要的 precision 分布：真实 strict 事件匹配中最低的 precision 分别为 A 0.083、B 0.089、C 0.080，余量很小。模型摘要如果变长，strict 分数会无声下滑；解读 strict 时请同时看候选摘要长度。
  - 长摘要仍会被稀释：评审确认的 26 对真实事件对中有 8 对未匹配，其中 5 对 recall 已过 0.2（0.26–0.42），但候选文本（内容检查用的是事件 title + summary）共 78–151 字，precision 只有 0.037–0.072，被精度下限拒绝；2 对 recall 不足（0.10、0.14），是真正没有词面重合的转述；1 对内容检查已过，只是该 gold 在一对一分配中被另一个候选占用（该 gold 仍计为命中）。
  - 结局：strict 结局还要求结局自身 Unit 与人物交集，比人工判断保守；评审人工判为真命中的结局里只有少数被 strict 匹配，strict 结局分数应视为下界式的保守信号。
  - 所有 gold-aligned copy 基线（整段与截断）都不是“复制能拿多少分”的上界。
  - 复制基线与真实结果的余量在结局上很小：同样只用 gold 位置，截取对齐原文**末尾**（尾部截断）时，strict 结局可达 A 0.67（真实 0.77，尾部 2× label 长度）、C 0.25（真实 0.33，尾部 4×）；截取**开头** 3× label 长度时，strict 事件可达 A 0.43、C 0.28（真实 0.75、0.69）。报告内置的只是开头 2× / 4× 两条截断基线，因此 strict 结局分数的“高于复制”结论应谨慎解读。
- **只有 strict 减去对应 chance / 对抗 baseline 才能作为抽取质量证据**：loose F1 只是 Unit 邻近信号，内容无关的 dummy Story Map 也可能把它刷高；chance 与对抗基线给出“不比较内容 / 只堆高频词 / 直接抄原文”也能碰巧得到多少分。因此不允许只用 loose 的 events/edges/endings F1 声称抽取质量提升。
- 控制台每篇打印 `goldEvents loose=F1 strict=F1 chance(loose/strict)=x/y dense(loose/strict)=x/y stuffing(loose/strict)=x/y sourceCopy(loose/strict)=x/y goldAlignedCopy(loose/strict)=x/y gaTrunc2x(loose/strict)=x/y gaTrunc4x(loose/strict)=x/y`，edges / endings 同样；`gaTrunc2x` / `gaTrunc4x` 分别是 2x / 4x truncated gold-aligned copy 基线，完整 F1/P/R 见报告里的 `chanceBaseline`。
- 严格人物 identity 数字保持不变；lenient identity 只把匹配 gold `mentionedOnly` 的候选从 precision 分母中排除。
- 分层人物 identity（`tieredIdentity`）：minor 候选不计入 precision 分母，也不为 precision 分子贡献命中；recall 仍按任何候选（含 minor）匹配 expected；同时报告 `minorCandidateTotal`。该块在旧报告中可缺失，baseline 控制台摘要打印 `tieredIdentityF1`。
- 人物 identity F1 依赖每名人物 12 个别名上限（`MAX_CHARACTER_ALIASES = 12`）和跨 pass 的 alias union：`applyRoster` 会把人名轮别名与所有 `mergedFrom` 候选的 name / aliases 合并，因此在 cap 以内，别名并集越完整，精确匹配 recall 只会上升而不会下降。baseline 在 `identity.aliasStats` 中报告 `{ aliasCap, characters, totalAliases, meanAliases, maxAliases, charactersAtCap }`（旧报告可缺失），控制台打印 `aliases(mean/max/atCap)`。

`npm run eval:m1:baseline -- --tuning --manifest <A> [--manifest <B>]` 是调参入口：只允许 1—2 篇，跳过正式 baseline 的 A/B/C 与 unseen 断言，报告 `kind: "m1_tuning"`。未加 `--tuning` 时行为不变，仍要求三篇正式 baseline。

M1-02A 允许端点配置显式选择 `json_object`，但它不是自动降级路径；baseline 必须记录实际的 `json_schema`、`json_object` 或 `prompt_json` 模式。Story Map Candidate 的 Evidence Unit ID 只负责让模型选择证据，最终 Evidence 仍由服务端确定性解析为现有 `SourceReference[]` 并接受全部领域校验。

当前生产 Story Map 管线（Phase 1 分块召回）使用五个版本化 Prompt：`story-map-chunk.v5`、`story-map-glean.v5`、`story-map-names.v2`、`story-map-endings.v3`、`story-map-merge.v5`。历史报告中的 `story-map.v2` + `story-map-reconcile.v2` 只代表旧的两步式管线，不用于新运行。结局轮次 v3 输出 1–3 个故事级结果（主线最终结果，可选另一个不同最终处境或文本明确的收束判断/反应）；每条 `requirement` / `fate` 恰好一个结果、约 15–45 个汉字，复用证据 Unit 的原文措辞，证据取结果实际被写出的 1–2 个 Unit。

### 指标口径

- `characterCount`：Source 规范化后按 Unicode code point 计数并排除空白；只用于作品规模分组，不进入生产 Schema。
- 人物身份匹配：人工 gold identity 与 candidate identity 一对一匹配；别名属于同一 identity。总体人物身份 F1 在三篇作品的 gold / candidate identity 上做 micro aggregation。
- 关键事件召回：人工 gold key event 与 candidate event 一对一匹配；匹配必须有语义一致的事件和有效 Source Evidence，不能只靠相似标题。
- Evidence validity：沿用生产 Validator 检查 Source、section、offset、非空范围与 Hash；无有效 Evidence 的关键事件同时计入未召回与无证据事件。
- 主要因果 Edge 认可率：人工逐条判断 gold 主要因果关系是否被 candidate 正确表达；`foreshadows` 不得冒充因果命中。
- material revision：一次改变人物 identity、关键 Event、主要 Edge、Evidence 结论或 Ending Candidate 的语义修正。纯浏览、缩放、拖动布局和 Evidence 确认不计入。
- review time：从首次展示 candidate Story Map 到确认 revision 的主动操作时间；等待模型、休息和环境故障不计入，并在报告中单列。
- “愿意继续阅读”：参与者在看完场景后明确选择 `yes`；缺席或未回答不得按 `yes` 计。

## M1 Story Map 质量目标

以下是质量目标，进入仪表盘、不阻塞。其中 Evidence validity 100% 与"无有效 Evidence 的关键事件 0"属于**可溯源硬规则**，被违反时阻塞。

每篇作品的目标：

- 核心人物召回率：100%；
- 关键事件召回率：至少 85%；
- Evidence validity：100%；
- 无有效 Evidence 的关键事件：0；
- 核心人物错误 merge：0；
- 关键 Ending Candidate 召回率：100%；
- 主要因果 Edge 人工认可率：至少 75%。

三篇聚合目标：

- 总体人物身份 F1：至少 90%；
- 关键事件召回率：至少 90%。

错误 merge 是最严重的质量问题：将两个真实人物合成同一 identity 时，仪表盘会单独列出，即使总体 F1 仍达标也应优先修复；它不属于四条硬规则，不阻塞。

## M1 人工修正成本质量目标

对不超过 30k 字的作品：

- 同规模已完成评测的 median review time：不超过 15 分钟；
- 每篇 material revisions：不超过 6；
- 每篇人工新增关键 Event：不超过 2。

对 30k—60k 字的作品：

- review time 目标：不超过 25 分钟；该值在 M1 作为必须报告的目标，不单独覆盖其他硬失败；
- 系统必须提供基于风险的优先核对队列，至少覆盖人物 merge、缺失/无效 Evidence、关键 Event、主要 Edge 与 Ending Candidate；
- 每篇 material revisions 与人工新增关键 Event 必须报告，不用未验证阈值掩盖实际成本。

## M1 Ripple 质量目标

`pre-divergence mutation：0` 属于**原文与分歧前历史不被覆盖**硬规则，被违反时阻塞；其余为质量目标。

- 每篇至少评测一个 strict divergence 和一个 open divergence；
- direct impact 人工认可率：每篇至少 85%；
- Anchor 判断与人工 gold 一致率：100%；
- pre-divergence mutation：0；
- 系统推荐的 3 个分叉点中，每篇至少 2 个被人工认为“有明确因果空间且值得探索”；
- 用户反馈后的 Impact Plan 必须生成新的 candidate revision，原 candidate 与任何已接受版本保持不变。

## M1 Continuation 质量目标

硬事实冲突、恢复 deleted fact、pre-divergence rewrite 与 strict Anchor violation 四项为 0 属于硬规则（分别对应坏输出被拒绝、世界线隔离、原文与分歧前历史不被覆盖、坏输出被拒绝），被违反时阻塞；评分类指标为质量目标。

每篇选择一个已接受 Worldline 并评测一个完整场景：

- 硬事实冲突：0；
- 恢复 deleted fact：0；
- pre-divergence rewrite：0；
- strict Anchor violation：0；
- worldline consistency：至少 4/5；
- narrative continuity：至少 3.5/5。

评分采用模板中的 1—5 分量表；多人评分时取该场景的算术平均。目标是三篇中至少 2 篇得到“愿意继续阅读”。任何结构化硬失败都不能被主观评分抵消。

## M1 真实用户观察（可选）

真人观察是可选的参考数据，有就进入仪表盘，没有记为 `not_measured`。进行观察时的目标是：

- 至少完成 3 次独立观察；
- 至少 2 名不同的非开发参与者；
- 参与者无需开发者代操作即可完成从导入到阅读一个新场景的 First Ripple；
- 报告只记录匿名参与者 ID、完成情况、主动操作时长、阻塞点分类和脱敏观察，不记录姓名、联系方式、录屏或作品正文。

## M1 质量仪表盘与版本

`npm run eval:m1 -- --manifest <A> --manifest <B> --manifest <C> [--human-dir <dir>]` 读取人工评分（`story-map.json`、`correction-cost.json`、`ripple.json`、`continuation.json`，可选 `users.json`），生成：

- `.data/evals/m1-eval/<run-id>/metrics.json`（`kind: "m1_dashboard"`，被 Git 忽略）；
- `docs/evals/runs/m1-dashboard-<timestamp>-<random>-<sha>.md`（脱敏，可提交）；
- 指定 `--report-dir <dir>` 时，Markdown 改写到 `<dir>/<run-id>/report.md`，与 `metrics.json` 同目录。

任一篇 manifest 为 `visibility: "private"`，或来自 `NOVELRIPPLE_BENCH_ROOT` / `benchmarks/private` 时，整次运行按 private 处理：不再写入 `docs/evals/runs/`，Markdown 默认与 `metrics.json` 同目录，私有 benchmark ID 脱敏为 `private:<storyClass>`；此时 `--report-dir` 只允许仓库外路径，或位于 Git 忽略的仓库内路径（脚本用 `git check-ignore -q` 判断），其它仓库内目录（包括 `docs/`）都会被拒绝。判断前会先对 `--report-dir` 做 realpath：找到最深的已存在祖先解析真实路径，再拼回不存在的剩余部分；因此忽略目录里的符号链接指向受版本控制目录、或仓库外链接指回仓库内，都不能绕过检查；脚本实际落盘也使用 realpath 后的目录。向上查找时如果某个路径片段是符号链接、但 realpath 失败（目标尚未创建的悬空链接），则以 `report_dir_dangling_symlink` 拒绝，不把链接位置当作目标；`lstat` 与 `realpath` 一样可注入，脚本传入 `fs.lstatSync` / `fs.realpathSync`。

`<run-id>` 精确到毫秒并带随机后缀，重复运行不会互相覆盖。人工评分文件缺失记为 `not_measured`；文件存在但 JSON 非法或对应 Story 未通过 Schema 校验时命令报错并以非零退出。manifest 必须提供正整数 `characterCount`（或 `characterCountByClass` / `scale.characters`），否则同样报错，避免静默套用错误的修正成本档位。

只有硬规则被违反时命令以非零退出。质量目标未达标、数据缺失都不影响退出码。

发布版本时：

1. 四条硬规则在已测数据上没有违反，M0 硬不变量和默认 CI 全部通过；
2. 附上最新一次质量仪表盘，说明哪些目标已达成、哪些未达成，以及相对上一次的变化；
3. 有数据就记录：至少一篇真正未见作品、人工修正成本、Ripple Suggestions、feedback regeneration、Continuation 与（可选）真实用户观察；
4. 每份报告记录 Story ID、commit SHA、Provider / model、全部 Prompt 版本、硬规则状态与各质量目标状态；
5. Prompt 变化有对应的新真实 Eval，不以旧报告代替；
6. Git、CI、日志、截图、报告和公开夹具均不含私人作品正文或可恢复正文的 raw output。

## 分享前检查

1. `npm run lint`；
2. `npm run typecheck`；
3. `npm run test:unit`；
4. `npm run test:contract`；
5. `npm test`；
6. `npm run build`；
7. `CI=1 npm run test:e2e`；
8. 检查所有已提交报告不含绝对路径、开发机用户名或私人路径细节；
9. 配置真实模型时运行 `npm run eval:live`；
10. 人工检查首页、故事地图、证据抽屉、Ripple Preview 和刷新恢复；
11. 确认截图、日志、数据库和夹具不含真实用户作品或密钥。
