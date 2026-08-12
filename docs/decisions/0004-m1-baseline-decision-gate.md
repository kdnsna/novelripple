# 0004：M1 未优化 baseline 决策门

- 状态：Accepted
- 日期：2026-08-12
- 范围：M1 — Real Story / M1-02

## 问题与边界

M1-02 必须先用冻结的真实作品、当前生产 Prompt、当前 Story Map Schema 与当前双全书调用管线采集未经优化的 baseline，再根据失败数据判断是否需要 section-first extraction。runner 只负责可重复运行现有生产路径、记录脱敏指标与暴露人工复核队列；它不是新的 Provider、Artifact、Story Map 或 Eval 平台。

baseline 产生前不得修改 Prompt、Story Map Schema、chunking、模型调用流程或 Benchmark Gold。没有经过独立人工标注的 manifest 时，runner 必须停止并报告输入缺失，不能由被测生产模型反向生成 Golden。

## Open-source preflight

检索日期：2026-08-12。只核对官方仓库、官方 Release 与许可证；维护和采用数据是当日快照。

| 候选 | 官方状态 | 适配判断 | 决定 |
| --- | --- | --- | --- |
| [colinhacks/zod](https://github.com/colinhacks/zod) `v4.4.3` | MIT；约 43.4k Stars / 2.1k Forks；2026-05-04 发布，2026-08-11 仍有提交 | 仓库已锁定该版本；可直接读取 M1 JSON Schema，并校验脱敏报告，不增加第二份 manifest contract | **复用现有依赖** |
| [ajv-validator/ajv](https://github.com/ajv-validator/ajv) `v8.20.0` | MIT；约 14.8k Stars / 1.0k Forks；2026-04-24 发布 | JSON Schema 支持成熟，但为一个现有 Zod 已能完成的边界新增 runtime dependency，没有净复杂度收益 | **不引入** |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) `0.122.0` | MIT；约 24.1k Stars / 2.2k Forks；2026-08-04 发布，2026-08-12 仍有提交 | 会叠加 Provider、缓存、报告与分享体系，并扩大私人正文、Prompt 与 raw output 暴露面 | **不引入** |
| [google/langextract](https://github.com/google/langextract) `v1.6.0` | Apache-2.0；约 38.3k Stars / 2.7k Forks；2026-07-02 发布，2026-08-11 仍有提交 | span grounding 方法有参考价值，但 Python、额外 Provider 与长文并行/分块会提前改变被测架构，污染 baseline | **不引入** |

本次不复制候选代码。Node 22 的内置参数解析、文件系统和计时能力足够完成显式命令；生产模型仍只通过仓库现有 OpenAI-compatible 边界调用。

## 决定

- 新增一个不进入默认 CI 的显式 M1 baseline 命令；
- 直接调用现有 Source 导入、Story Map 生成与 Generation Run 实现；
- 用只观察、不改变请求的 Provider wrapper 记录 token、时长与 repair；
- Gold 只在 Story Map candidate 已完整生成后进入评分函数；
- 原始指标只写入已被 Git 忽略的 `.data/evals/`，公开报告只保存稳定 ID、计数、比率和失败分类；
- 人工复核、修正成本、strict/open Ripple 与 Continuation 继续使用生产 Artifact/revision/Worldline 和现有 M1 人工模板，不创建平行状态系统。

新依赖为 **none**。

## 架构判定规则

M1-02 的公开报告只根据冻结 baseline 数据套用 `docs/evals.md` 与用户指定证据门。没有三篇完整运行和人工复核数据时，只能判定 M1-02 FAIL；不得把缺失数据解释为支持或反对 section-first。
