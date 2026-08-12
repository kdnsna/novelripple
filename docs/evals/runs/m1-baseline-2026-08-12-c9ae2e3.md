# M1-02 未优化 baseline 输入审计（FAIL）

> 本报告记录一次真实的 M1-02 启动审计，不包含 Source 正文、作品标题、人物名、完整 Prompt、密钥、raw model output 或可恢复正文。由于前置输入不成立，本次没有调用模型，不能用它支持任何管线重构。

## Run identity

- 审计日期：2026-08-12
- 生产基线 Commit SHA：`c9ae2e38e1015f6122272cb37dfb83310f6f4ebc`
- Provider / model：`not-run / not-run`
- Structured Output mode：`not-run`
- Prompt versions：生产文件仍为 `story-map.v1`、`story-map-reconcile.v1`、`impact-plan.v2`、`continuation.v1`；本次调用数为 0
- Prompt / Story Map Schema / chunking /生产模型调用流程变更：0
- 新 runtime dependency：0

## Frozen input audit

| 项目 | 要求 | 实际 | 结果 |
| --- | --- | --- | --- |
| Story A manifest + Source | 1 | 0 | FAIL |
| Story B manifest + Source | 1 | 0 | FAIL |
| Story C manifest + Source | 1 | 0 | FAIL |
| 经独立复核的人工 Gold | 3 | 0 | FAIL |
| `unseenByPromptAuthors` 可验证声明 | 至少 1 | 0 | FAIL |
| 真实 OpenAI-compatible 配置 | provider、model、mode、credential 完整 | 当前进程与仓库 env 文件均未提供有效配置 | FAIL |

仓库中的 `benchmarks/m1/public/` 只有目录规则，`benchmarks/private/` 没有本地文件。根据 M1-01 合同，不能由被测生产模型反向生成 Golden，也不能在未知 Prompt 作者阅读历史时自行把作品标成 unseen。为了得到指标而临时降低这些条件会污染 baseline。

## Actual baseline data

| 指标 | 实际值 |
| --- | --- |
| 可用作品 | 0 / 3 |
| Story Map generation | 0 / 3 |
| 人工 review / confirmed Story Map | 0 / 3 |
| strict divergence / Ripple | 0 / 3 |
| open divergence / Ripple | 0 / 3 |
| Continuation scene | 0 / 3 |
| 模型调用 | 0 |
| input / output tokens | not available；未调用 |
| wall-clock generation duration | not available；未调用 |
| repair count | 0 |
| Event / Character / Evidence / Edge / Ending metrics | not available；不得推断 |
| 修正成本 | not available；无人工作业 |

因此 A—K 失败分类没有作品级样本。当前可记录的只是运行前阻塞，不是 extraction、identity、grounding、Ripple、Continuation、性能或 provider/schema 质量结论。

| 分类 | 本次数据状态 |
| --- | --- |
| A. extraction coverage | not evaluated；0 个 candidate |
| B. character identity | not evaluated；0 个 candidate |
| C. evidence grounding | not evaluated；0 个 candidate |
| D. chronology | not evaluated；0 个 candidate |
| E. causal edges | not evaluated；0 个 candidate |
| F. ending candidates | not evaluated；0 个 candidate |
| G. review UX | not evaluated；0 次人工 review |
| H. Ripple quality | not evaluated；0 个 Ripple |
| I. Continuation quality | not evaluated；0 个 scene |
| J. performance/context window | not evaluated；0 次模型调用 |
| K. provider/schema compatibility | not evaluated；调用前配置缺失，不能等同于兼容性失败 |

## Architecture decision gate

以下 section-first 证据均无法计算：Event recall <80%、核心人物漏检、Evidence grounding 下降、context window failure、频繁 timeout、30k+ 质量下降、双全书调用 Token/成本不可接受。零样本既不能推出 `KEEP CURRENT PIPELINE`，也不能推出 `SECTION-FIRST REQUIRED`。

在三篇冻结 Benchmark、至少一篇可信 unseen 声明、真实 Provider 配置和独立人工复核都具备前，不允许开始 M1-03 或修改 Prompt、Schema、chunking 与模型调用流程。

## Final result

**M1-02 FAIL**
