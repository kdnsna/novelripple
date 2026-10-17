# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
This file follows the Keep a Changelog structure; versions follow Semantic Versioning.

## [Unreleased]

### Changed / 变更

- 评测门禁改为非阻塞的质量仪表盘（ADR 0005）。Evaluation gate became a non-blocking quality dashboard (ADR 0005).
- 四条硬规则仍然阻塞：原文与分歧前历史不被覆盖、证据可溯源、世界线隔离、坏输出被拒绝。Four hard rules still block.
- 真人观察改为可选，缺失只记为 `not_measured`。Real-user observation is optional.
- 作者自评是有效的人工评分。Author self-review is valid.
- 关键人物错误 merge 已从硬失败降级为质量目标（仍会报告，但不阻塞）。Critical character merge mistakes were downgraded from a hard failure to a quality target (reported, non-blocking).
- Phase 1：Story Map 分块召回管线（见 PR）
