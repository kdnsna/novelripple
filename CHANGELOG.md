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

### Changed / 变更

- 评测门禁改为非阻塞的质量仪表盘（ADR 0005）。Evaluation gate became a non-blocking quality dashboard (ADR 0005).
- 四条硬规则仍然阻塞：原文与分歧前历史不被覆盖、证据可溯源、世界线隔离、坏输出被拒绝。Four hard rules still block.
- 真人观察改为可选，缺失只记为 `not_measured`。Real-user observation is optional.
- 作者自评是有效的人工评分。Author self-review is valid.
- 关键人物错误 merge 已从硬失败降级为质量目标（仍会报告，但不阻塞）。Critical character merge mistakes were downgraded from a hard failure to a quality target (reported, non-blocking).

### Fixed / 修复

- 人名归并增加错并防护：`mergedFrom` 候选名必须等于合并后人物的 `name` 或出现在 `aliases` 中，否则 repair 一次后 fail closed。Wrong-merge guard for the roster pass: every merged candidate name must match the merged name or an alias, otherwise one repair then fail closed.
- 分块并发第一处失败即停止调度并中止在途请求；新增 `STORY_MAP_MAX_MODEL_CALLS`（默认 120）与 `STORY_MAP_MAX_CHUNKS`（默认 50）预算，调用前检查、运行中按真实尝试（含 repair）计数，并在达到 20 块时打印一次粗略输入量预警。Fail-fast chunk scheduling with in-flight abort, plus model-call/chunk budgets and a large-input warning.
- 去重因果边和结局时合并全部证据 Unit（保持顺序），包括经 `duplicateEventGroups` 归并的边。Deduplicated edges and endings now merge all evidence Unit IDs, including edges collapsed through `duplicateEventGroups`.
- 分块会先丢弃最旧上下文以避免 core+context 超限；单个自然段超过 `CHUNK_HARD_MAX_CHARS`（2 × `CHUNK_MAX_CHARS`）时在任何模型调用前失败。Chunking drops oldest context first and fails closed on paragraphs above the hard cap instead of splitting Unit IDs.
- 全书合并轮的边证据只能引用该轮看到的事件、已有边与结局的 Unit 并集。Merge-pass evidence is scoped to the events, existing edges and endings shown to that pass.

