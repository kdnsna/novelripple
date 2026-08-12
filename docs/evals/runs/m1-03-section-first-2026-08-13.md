# M1-03 Section-first 真实作品回归（FAIL）

## Run identity

- 本地日期：2026-08-13（Asia/Shanghai）
- 被评测 Commit SHA：`7c4ba4c6f2ad4811bab0861b437d5695fb614226`
- Run ID：`20260812163438672-7c4ba4c-c15c5990`
- Provider / model：`openai-compatible / deepseek-chat`
- Structured Output mode：`json_object`
- Prompt versions：`story-map.v3`；Global Reconciler 未运行，因此无 `story-map-reconcile.v3` 运行记录
- 原始脱敏指标：`.data/evals/m1-baseline/20260812163438672-7c4ba4c-c15c5990/metrics.json`（Git ignored）
- 新 runtime dependency：`none`

本报告不包含私人作品标题、人物名、事件摘要、Section 标题、原文、`exactQuote`、Prompt、raw model output、密钥、截图或录屏。

## Frozen comparison baseline

对照仍是 [`M1-02 Real Story baseline`](m1-baseline-2026-08-12-37aeb6b.md)与其[`架构决策补充`](m1-02-architecture-decision-2026-08-12-1882e37.md)。旧运行使用同一 `deepseek-chat / json_object`，三篇均创建 Artifact、Evidence validity 为 140 / 140；已知真实失败包括 Story B 核心人物漏检、三篇人物 identity micro-F1 为 87.3%、Ending coverage 不足，以及双全书 token 较高。

## Section-first result

| Story | Segment | Local validation | Global reconcile | Artifact | Evidence validity | Total tokens | Wall clock |
| --- | ---: | --- | --- | --- | --- | ---: | ---: |
| A | 2 | 1 succeeded；1 failed after repair | not run | false | not available | 44,887 | 63,756 ms |
| B | 4 | 1 succeeded；1 failed after repair；2 not run | not run | false | not available | 43,114 | 37,919 ms |
| C | 2 | 1 repair succeeded；1 failed after repair | not run | false | not available | 53,405 | 24,378 ms |

三篇的失败位置一致：局部模型返回了在声明 Section 中不存在的 Evidence 摘录；唯一一次 repair 后仍未满足逐字、唯一匹配合同。Provider 调用本身成功，失败发生在本地确定性 Evidence validation。系统按设计保留失败 Generation Run、停止 Global Reconcile，且没有保存半成品 Story Map Artifact。

## Quality and cost interpretation

- Artifact created：0 / 3，未达到 retention gate 的 3 / 3；
- Evidence validity：不可计算，不能替代旧运行的 100%；
- Character / Event / Edge / Ending 指标：不可计算，不能证明 Story B 核心人物召回或聚合 identity F1 有改善；
- correction cost：未测量，因为没有 Candidate Artifact 可供 Review；
- token / latency：本次只完成部分 local extraction，没有执行 Global Reconcile，因而较低 token 不能与旧完整管线成本作成功运行对比，也不能作为改善证据；
- repair budget：保持每个 Segment 最多一次，没有增加 retry、fallback 或本地 coercion。

## Failure classification

- C. evidence grounding：FAIL；局部逐字 Evidence claim 在三个作品中均未能稳定通过；
- A / B / D / E / F：not measured；没有最终 Story Map；
- G / H / I：not run；没有 confirmed Story Map、Ripple 或 Continuation；
- J. performance/context window：未出现 context-window error 或 timeout，但运行不完整，不能判 PASS；
- K. provider/schema compatibility：JSON 与 Provider 调用成功；失败是 Evidence 领域合同，不允许通过放宽本地契约掩盖。

## Deterministic verification of evaluated implementation

在被评测 SHA 合入 main 后、真实运行前完成：

- `npm run lint`：PASS
- `npm run typecheck`：PASS
- `npm run test:unit`：24 files / 175 tests PASS
- `npm run test:contract`：1 file / 4 tests PASS
- `npm test`：25 files / 179 tests PASS
- `npm run build`：PASS
- `CI=1 npm run test:e2e`：7 tests PASS

确定性测试证明了分段、并发、回滚与引用解析实现符合代码合同，但不能抵消真实 Provider 在冻结作品上的 0 / 3 Artifact 结果。

## Retention decision

本次未解决 M1-02 的真实失败，并且使三篇从“可生成且 Evidence 100% 有效”退化为“无法形成 Artifact”。依据预先冻结的 retention gate，不能因为 section-first 已实现就保留该生产架构。相关 M1-03 生产、Candidate、Prompt v3、Segment baseline 与当前行为文档变更将通过可追踪 `git revert` 撤销；M0/M1-02 数据、旧 Source、Artifact 与报告保持不可变。

## Final conclusion

**M1-03 FAIL**
