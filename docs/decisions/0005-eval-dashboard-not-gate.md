# 0005：评测从"阻塞门禁"改为"质量仪表盘"，硬规则继续阻塞

- 状态：Accepted
- 日期：2026-10-17
- 范围：Phase 0（解除停滞）；取代 0003 / 0004 与 `docs/plan/m1-real-story-codex-execution-plan.md` 中"FAIL 即停止"的流程规则

## 问题

M1-07（`83921d1`，2026-08-14）聚合评测判定 `M1 EVAL FAIL`，按执行计划"FAIL 后停止，不进入 M1-08"，项目此后两个月没有任何提交。放行条件里包括 3 次真人观察（其中 2 名非开发者）和 B/C 篇的秒表计时修正，对一个个人项目几乎不可能凑齐，因此这道门永远过不了。

同时，这些指标里混着两类性质完全不同的东西：

- **硬规则**：原文不被覆盖、证据可溯源、世界线隔离、坏输出被拒绝。违反就是数据损坏或错误事实，必须阻塞。
- **质量目标**：召回率、修正成本、主观评分、真人观察。它们衡量"好不好"，应该指导下一步改什么，而不是让开发停下。

## 决定

1. `npm run eval:m1` 改为生成 **M1 质量仪表盘**（报告 `kind: "m1_dashboard"`，`schemaVersion: 2`）：
   - 四条硬规则逐条给出 `pass` / `fail` / `not_measured`；任一 `fail` 时报告状态为 `hard_rule_violation`，命令以非零退出。
   - 质量目标逐块给出 `met` / `below_target` / `not_measured`，**只记录，不阻塞，也不影响退出码**。
   - 缺失数据记为 `not_measured`，不再被当成失败。
2. 硬规则与评测指标的对应：

   | 硬规则 | 评测中触发违反的指标 | 生产路径中的强制位置（默认 CI 覆盖） |
   | --- | --- | --- |
   | 原文与分歧前历史不被覆盖 | `preDivergenceMutations > 0`、`preDivergenceRewrites > 0` | Source 不可变、revision 不可变、Worldline 不修改 Canon（`docs/evals.md` 硬不变量 1、6、9） |
   | 证据可溯源 | `evidenceValidityRate < 1`、`eventsWithoutValidEvidence > 0` | Evidence Unit ID → SourceReference 确定性解析与 Hash 校验（硬不变量 2） |
   | 世界线隔离 | `recoveredDeletedFacts > 0` | Delta 确定性派生、父/兄弟世界线隔离（硬不变量 6、11） |
   | 坏输出被拒绝 | `hardConflicts > 0`、`strictAnchorViolations > 0` | Schema + 领域校验 fail closed、严格模式 `incompatible` 拦截（硬不变量 7、8、10、11） |

3. **真人观察改为可选**：有数据就展示，没有就记 `not_measured`。
4. **作者自评是有效人工评分**：人工评分文件可选填 `reviewer: "author" | "external"`，缺省视为 `author`。
5. `eval:m1:continuation` 的人工评分低于目标时状态为 `below_target`（退出码 0）；`failed` 只保留给技术失败、一致性 hard gate 失败和隔离失败。
6. 默认 CI（lint、typecheck、Vitest 单元/合约、build、Chromium E2E）保持不变，仍是每个 PR 的阻塞检查。真实模型评测仍不进默认 CI。
7. **关键人物错误 merge 是质量目标，不是硬失败**：critical character merge mistakes were downgraded from a hard failure to a quality target (reported, non-blocking)。仪表盘会单独列出，即使总体 F1 达标也应优先修复。

## 不变的部分

- `docs/evals.md` 的 11 条硬不变量与 fail-closed 规则一条都没有放宽。
- 质量目标的阈值数值不变，只改变它们的作用（从门禁变为目标线）。不得为了"变绿"而调低阈值。
- 历史报告（包括 M1-07 FAIL）保留原样，作为仪表盘的历史数据点。
- `npm run eval:live`（M0 / `ripple-001` 公开夹具）的 release gate 本次不改。

## Open-source preflight

检索日期：2026-10-17。本次只调整仓库内既有聚合逻辑与文档，不新增依赖、不复制代码。

- [microsoft/graphrag](https://github.com/microsoft/graphrag)（MIT）、[promptfoo/promptfoo](https://github.com/promptfoo/promptfoo)（MIT）：评测结果以报告/对比为主，阈值用于标注回归而不是阻止开发，印证"仪表盘 + 硬断言"的分层做法。promptfoo 的 Provider/缓存/分享体系会扩大私人正文暴露面，沿用 0004 的结论不引入。
- 复用 NovelRipple 已有 Zod Schema 与 `scripts/eval-m1.ts`，总复杂度最低。

新依赖：**none**。
