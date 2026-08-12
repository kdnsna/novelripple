# 0003：M1 真实作品评测方法

- 状态：Accepted
- 日期：2026-08-12
- 范围：M1 — Real Story / M1-01

## 问题与边界

M1 需要用 3 篇 1 万—6 万中文字符的真实中短篇验证故事理解、人工修正成本和新世界线阅读价值。必要接口只有现有 Source、Story Map、Impact Plan、Worldline、Continuation 与同一套 Eval 报告；本决策不修改 Prompt、Schema、生产 pipeline，不实现 chunking、Review UI、Ripple Suggestions 或 Continuation 改造。

选择标准是：优先借鉴已验证的方法，但默认不增加 runtime dependency、Python 服务、第二套 Provider 或第二套 Eval 系统。候选代码不复制，许可证只用于判断未来可复用边界。

## Open-source preflight

检索日期：2026-08-12。只核对官方 GitHub 仓库、仓库内官方文档、依赖清单、Release 与许可证。Stars、Forks、Issues 和最近活动是当日快照，只作为维护与采用信号。

| 候选 | 许可证、维护与采用快照 | 依赖、适配与隐私判断 | 决定 |
| --- | --- | --- | --- |
| [google/langextract](https://github.com/google/langextract) `v1.6.0` | Apache-2.0；约 38.3k Stars / 2.7k Forks；74 个 open Issues；2026-07-02 发布，2026-08-11 仍有提交 | Python ≥3.10，16 个基础 runtime dependencies，包含 Google GenAI、Cloud Storage、NumPy、Pandas 等；官方方法强调逐字 span grounding、长文 chunking/并行多轮与 HTML 可视化。云模型会接收正文，JSONL/HTML 也可能携带正文 | **只借鉴方法**：保留精确 Evidence 定位和低成本人工核对。M1-01 不采用 Python runtime、Provider 插件、chunking、并行多轮或可携带正文的可视化产物 |
| [booknlp/booknlp](https://github.com/booknlp/booknlp) `1.0.7` | MIT；约 926 Stars / 118 Forks；23 个 open Issues；无 GitHub Release，最近代码提交为 2024-07-31 | 面向英文书籍；依赖 Torch、TensorFlow、spaCy、Transformers 和额外模型，官方输出包含 token、quotation、entity 及带全文的 HTML。人物 name clustering / coreference 对错误合并很有启发，但不适配中文和当前 Node 单体 | **只借鉴 Benchmark 压力项**：别名、称谓、回忆、时间跳跃和易错误合并人物。不得引入 BookNLP runtime、模型或 Python 服务 |
| [inkle/ink](https://github.com/inkle/ink) `v1.2.1` | MIT；约 4.9k Stars / 538 Forks；355 个 open Issues；2026-05-05 发布 | C# / .NET 6+ 的互动叙事语言、编译器与 runtime，适合执行作者显式编写的分支脚本，不负责从自然语言作品提取 Canon。采用会要求第二种叙事表示和编译/runtime 生命周期 | **只借鉴方法**：显式选择、分支身份和状态连续性。不得引入 Ink DSL、编译器、runtime 或把 Worldline 转成第二套故事系统 |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) `0.122.0` | MIT；约 24.1k Stars / 2.2k Forks；109 个 open Issues；2026-08-04 发布，2026-08-12 仍有提交 | Node ≥22.22；80 个 runtime 与 42 个 optional dependencies。提供声明式 Eval、Provider、缓存、报告与分享；官方 Security Policy 明确配置可执行未沙箱化代码，本地/共享报告可能包含 prompts、datasets、outputs 与 traces | **只借鉴方法**：声明式用例矩阵、阈值和回归比较。M1 已有固定 Provider、Generation Run、Artifact 与 Eval，接入 Promptfoo 会建立第二套系统并扩大私人正文与密钥暴露面，因此不引入 |

所有许可证都允许在满足各自条款时复用，但本次不复制或改编候选代码，不产生归属文件，也不新增依赖。

## 决定

M1-01 采用仓库原生、文件化的最小方案：

- `docs/mvp.md` 只拥有 M1 产品范围与用户结果；
- `benchmarks/m1/` 只拥有 Benchmark 分类、权利边界和 manifest contract；
- `docs/evals.md` 只拥有指标口径与发布门禁；
- `docs/evals/m1-review-template.md` 复用现有 Eval 报告流程；
- 生产 Source、Artifact、Provider、Generation Run 与 Worldline 继续是唯一事实系统。

新依赖为 **none**。不增加 Python、Promptfoo、BookNLP、Ink、多 Agent、RAG、向量数据库、图数据库、模型路由或多模型投票。

## 数据与回滚边界

- 公共 Benchmark 只有在原创、公版或明确许可公开且权利记录完整时才可提交；
- 私人正文、manifest 和本地标注只存在于被 Git 忽略的 `benchmarks/private/`，不进入 CI、日志、截图或公开报告；
- 报告只保存稳定 ID、计数、比例、评分和简短理由，不复制正文或 raw output；
- manifest schema 是 Eval 元数据合同，不是第二套 Story Map Schema，也不改变生产数据库；
- 若 M1 baseline 证明现有能力不足，后续 Issue 只能针对已测得的失败引入最小改动，并重新执行本预检。
