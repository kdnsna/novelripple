# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
This file follows the Keep a Changelog structure; versions follow Semantic Versioning.

## [Unreleased]

### Added / 新增

- 按稳定 Evidence Unit 分块召回 Story Map（ADR 0006）：目标 6,000 字符、最小/最大 3,000/9,000、2 个只读上下文 Unit、4 路并发。Chunked Story Map recall over stable Evidence Units (ADR 0006): 6k target, 3k/9k bounds, 2 context units, 4-way concurrency.
- 每块一轮补抽，并用确定性人名候选（含对白说话人）驱动人名归并。One gleaning pass per chunk; deterministic name hints, including dialogue speakers, seed the roster pass.
- 末尾约 20%（至少 3 个 Unit）的结局轮次，输出故事结局与 `【人物结局】` 人物结局。Endings pass over the last ~20% of units (min 3), including character endings.
- 全书合并跨块去重、补充跨块因果边；最终候选仍经 Evidence 解析和领域校验。Final merge dedupes cross-chunk events and adds cross-chunk edges; the candidate still passes Evidence resolution and domain validation.
- 证据继续只使用稳定 Unit ID；M1-03（`ca705d3`）的 sectionId + exactQuote 路径保持撤销。Evidence stays on stable Unit IDs; the M1-03 (ca705d3) sectionId + exactQuote path remains reverted.
- 真实模型 A/B/C 的 Phase 1 仪表盘数字尚未重测，私有基准正文不在仓库。Real-model Phase 1 dashboard numbers for A/B/C are not yet re-measured; private benchmark texts are not in the repo.
- M1 baseline runner 支持可选的 `NOVELRIPPLE_BENCH_ROOT`：该目录的 realpath 作为额外 private 根，manifest 必须为 `visibility: private` 且 Source 留在该根内；未设置或为空时行为不变。Optional `NOVELRIPPLE_BENCH_ROOT` adds an extra private benchmark root; manifests must be private and sources must stay inside it.
- M1 baseline 新增可选私有 `gold.json` 自动匹配 Event / Causal Edge / Ending / lenient identity，Unit 窗口为 2；只报告 ID、计数与比例，且仅作近似调参指标、绝不作为门禁。Optional private `gold.json` adds approximate automatic matching for events, causal edges, endings and lenient identity with a 2-unit window; IDs/counts/rates only and never a gate.
- `eval:m1:baseline` 新增 `--tuning`：允许 1—2 篇，跳过正式 baseline 的 A/B/C、unseen 断言，报告 `kind: "m1_tuning"`。New `--tuning` mode allows 1–2 manifests, skips the formal A/B/C/unseen suite assertion, and reports `kind: "m1_tuning"`.
- 人物提取改为模型主导：`story-map-chunk.v2` 不再接收规则人名提示；`story-map-glean.v2` 只把过滤后的人名候选当作“可能漏名”提示逐个核对；`story-map-names.v2` 强调给定名/昵称只有原文确认才是别名，禁止错并。Model-first names: chunk v2 receives no rule-based hints; glean v2 uses filtered hints as “possible misses”; names v2 treats given-name/nickname forms as aliases only when the text confirms them.
- 抽取/补抽候选新增 `kind: "individual" | "group"`；无名的具体个体只要在场景中行动或说话就是 `individual`（即使只出现一次），固定两人小组合可作为一条 `individual`，模糊人群/复数集体仍为 `group`。组装时确定性丢弃群体、家族、机构候选并从事件参与者中移除，仅当事件只剩群体时保留一个群体作为最小例外。Candidate characters now carry `kind`; an unnamed but specific individual who acts or speaks is an `individual` even in a single scene, a fixed pair acting as a unit may be one `individual`, and vague crowds remain `group`. Assembly deterministically drops groups, households and institutions from the pool and event participants, keeping one group only when an event would otherwise have no participant.
- 人名候选新增确定性垃圾过滤（多数出现后接 了/着/过/地/得、姓氏后虚词碎片、常见非人名 STOP_WORDS）和非姓氏昵称规则（`阿/小/老` + 单字或 ASCII 字母，出现 ≥2 次）。Deterministic junk filtering and a non-surname nickname rule were added to name hints.
- 事件粒度改为场景/情节节拍级（通常每 600–1000 字一个），同一连续场景或对话不拆条；因果边只为直接、重要关系保留，约每事件至多一条出边。Event granularity is now scene/plot-beat level (roughly one per 600–1000 characters) and causal edges are restricted to direct, important relations.
- 新增 `story-map-merge.v2`：除跨块重复外，还合并相邻块把同一场景拆得更细的事件，并用 `duplicateEndingGroups` 合并在同一人物/故事主线上得到同一结果的结局候选；不同人物的命运即使相似也不算重复。New merge v2 also folds finer-grained adjacent scene events and duplicate ending candidates for the same character or storyline; different characters' fates are never duplicates.
- 人名轮新增 `rejectedCandidateIds`：每个候选必须恰好归入一个人物的 `mergedFrom` 或列入拒绝列表一次；只被提及/回忆、群体/家族/机构、只评论的作者叙事者应被拒绝，行动或说话者、参与情节的主角/第一人称叙事者不得拒绝。被拒候选从人物与事件参与者中移除，事件只剩被拒参与者时保留第一个作为人物。The names pass now requires `rejectedCandidateIds`: every candidate must be merged once or rejected once; only-mentioned/remembered people, groups and comment-only narrators may be rejected, while anyone who acts or speaks (including the protagonist/first-person narrator) may not. Rejected candidates are removed from characters and participants, keeping one only when an event would otherwise be empty.
- 全书合并 prompt 新增 `<granularity_hint>`（核心文本字符数与目标事件范围，下限 3）；事件明显超出上限时折叠相邻同场景/更细节拍，范围内只合并真正重复，绝不合并不同场景或转折点。The merge prompt now includes a `<granularity_hint>` with core text length and a target event range (lower bound 3); clearly over-budget lists fold adjacent same-scene/finer beats, within-range lists merge only true duplicates, and different scenes or turning points are never merged.
- `story-map-chunk.v2` / `story-map-glean.v2` 明确：只被提到、回忆或谈论、并未在本片段行动或说话的人不得列为人物。Chunk/glean v2 now explicitly exclude people who are only mentioned, remembered or talked about without acting or speaking in the chunk.
- 新增 `story-map-endings.v2`：只产出 1 个故事级结局；对每个结尾命运已定或被明确留白的角色（含已离场配角与主角/叙述者本人）各产出 1 个人物结局，不重复同一结果。New endings v2 emits one story-level ending and one ending for every character whose fate is resolved or explicitly left open, including departed supporting characters and the protagonist/narrator.
- 最终候选在 Evidence 解析前清理 ID：去掉块冲突产生的 `__c<chunk>` 后缀，碰撞时保留裸 ID 并按 `-2`、`-3` 顺延，同时重写全部引用。Final candidate IDs drop `__c<chunk>` suffixes before Evidence resolution, with deterministic `-2`/`-3` collision handling and reference rewrites.
- `NOVELRIPPLE_BENCH_ROOT` 在 realpath 后拒绝文件系统根和仓库内路径，只放行仓库外目录或 Git 忽略的 `<repo>/benchmarks/private`。`NOVELRIPPLE_BENCH_ROOT` now rejects the filesystem root and repository-internal paths after realpath, allowing only outside directories or the git-ignored `<repo>/benchmarks/private`.

### Changed / 变更

- 评测门禁改为非阻塞的质量仪表盘（ADR 0005）。Evaluation gate became a non-blocking quality dashboard (ADR 0005).
- M1 仪表盘遇到任一篇 private manifest（或来自 `NOVELRIPPLE_BENCH_ROOT`）时不再写入 `docs/evals/runs/`：报告默认与 `metrics.json` 同落在 `.data/evals/`，拒绝指向仓库 `docs/` 的 `--report-dir`，并把私有 benchmark ID 脱敏为 `private:<storyClass>`。Private M1 dashboard runs no longer write into `docs/evals/runs/`: the report stays next to `metrics.json` under `.data/evals/`, `--report-dir` under `docs/` is rejected, and private benchmark IDs are redacted as `private:<storyClass>`.
- 四条硬规则仍然阻塞：原文与分歧前历史不被覆盖、证据可溯源、世界线隔离、坏输出被拒绝。Four hard rules still block.
- 真人观察改为可选，缺失只记为 `not_measured`。Real-user observation is optional.
- 作者自评是有效的人工评分。Author self-review is valid.
- 关键人物错误 merge 已从硬失败降级为质量目标（仍会报告，但不阻塞）。Critical character merge mistakes were downgraded from a hard failure to a quality target (reported, non-blocking).

### Fixed / 修复

- 结构化生成新增瞬时网络错误识别与重试：OpenAI SDK 连接/超时错误及 `terminated`、`fetch failed`、`ECONNRESET`、`ETIMEDOUT`、`UND_ERR_SOCKET`、`socket hang up` 等错误，首轮与 repair 各重试一次；中止、HTTP 4xx 与校验错误不重试。每次重试仍经 `onAttempt` 计入 Story Map 模型调用预算。Transient network errors (OpenAI SDK connection/timeout errors and matching causes/messages) now retry once for both the initial and repair calls, while aborts, HTTP 4xx and validation errors never retry; retries still count through `onAttempt` in the Story Map model-call budget.
- 人名归并增加错并防护：`mergedFrom` 候选名必须等于合并后人物的 `name` 或出现在 `aliases` 中，否则 repair 一次后 fail closed。Wrong-merge guard for the roster pass: every merged candidate name must match the merged name or an alias, otherwise one repair then fail closed.
- 错并比较先做 NFKC、转小写、去首尾空白并折叠内部空白，全角/半角与大小写变体不再误判。The roster guard normalizes names with NFKC, lowercasing and whitespace folding so full-width/case variants compare equal.
- 分块按整块 core 文本控制在 `CHUNK_MAX_CHARS` 内：下一段会超限时即使当前块未到最小长度也换块；单段超长仍独占一块，短尾回并只在结果不超限时发生。Chunking now caps the whole chunk core at `CHUNK_MAX_CHARS`, starts a new chunk before an overflow even below the minimum, lets a single oversized paragraph stand alone, and only folds a short tail when the result stays within the max.
- 结构化输出首轮不合法且调用方已中止时，不再发送 repair 请求，直接抛出 abort reason 并结束 Generation Run。When the caller has already aborted after an invalid first pass, the structured-output path throws the abort reason instead of sending a repair request.
- 显式传入的 Story Map `limits` 与环境变量走同一正整数校验；NaN、0、负数、小数和 Infinity 都在任何模型调用前失败。Explicit Story Map `limits` now share the env-var positive-integer validation and fail before any model call.
- 分块并发第一处失败即停止调度并中止在途请求；新增 `STORY_MAP_MAX_MODEL_CALLS`（默认 120）与 `STORY_MAP_MAX_CHUNKS`（默认 50）预算，调用前检查、运行中按真实尝试（含 repair）计数，并在达到 20 块时打印一次粗略输入量预警。Fail-fast chunk scheduling with in-flight abort, plus model-call/chunk budgets and a large-input warning.
- 去重因果边和结局时合并全部证据 Unit（保持顺序），包括经 `duplicateEventGroups` 归并的边。Deduplicated edges and endings now merge all evidence Unit IDs, including edges collapsed through `duplicateEventGroups`.
- 因果边按 `(from, to)` 去重并保留第一条的类型/说明；故事级结局只在目标事件与规范化后的 `requirement` 文本都相同时折叠，人物结局按人物名去重；事件合并后端点相同的边直接丢弃。Edges collapse by `(from, to)` keeping the first type/label; story endings collapse only when both the target event and normalized requirement text match, character endings collapse by character name, and edges whose endpoints merged into one event are dropped.
- 分块会先丢弃最旧上下文以避免 core+context 超限；单个自然段超过 `CHUNK_HARD_MAX_CHARS`（2 × `CHUNK_MAX_CHARS`）时在任何模型调用前失败。Chunking drops oldest context first and fails closed on paragraphs above the hard cap instead of splitting Unit IDs.
- 全书合并轮的边证据只能引用该轮看到的事件、已有边与结局的 Unit 并集。Merge-pass evidence is scoped to the events, existing edges and endings shown to that pass.

