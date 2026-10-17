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

### Changed / 变更

- 评测门禁改为非阻塞的质量仪表盘（ADR 0005）。Evaluation gate became a non-blocking quality dashboard (ADR 0005).
- 四条硬规则仍然阻塞：原文与分歧前历史不被覆盖、证据可溯源、世界线隔离、坏输出被拒绝。Four hard rules still block.
- 真人观察改为可选，缺失只记为 `not_measured`。Real-user observation is optional.
- 作者自评是有效的人工评分。Author self-review is valid.
- 关键人物错误 merge 已从硬失败降级为质量目标（仍会报告，但不阻塞）。Critical character merge mistakes were downgraded from a hard failure to a quality target (reported, non-blocking).

