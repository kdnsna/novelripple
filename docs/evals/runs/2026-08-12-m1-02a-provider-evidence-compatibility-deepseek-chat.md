# M1-02A Provider & Evidence Grounding Compatibility（PASS）

> 本报告只包含脱敏指标和 Story A / B / C 类别，不包含私人作品标题、人物名、事件摘要、原文摘录、Source 正文、完整 Prompt、raw model output、密钥或详细校验错误。

## Run identity

- 运行日期：2026-08-12
- 运行 Commit SHA：`37aeb6b52192a27b66537682eba14313d6ecfd70`
- M1-02A 实现 Commit SHA：`14be7468d7131ce9b9610db395578a73612e1b5c`
- Run ID：`20260812085148247-37aeb6b-5e79e596`
- Provider / model：`openai-compatible / deepseek-chat`
- Structured Output mode：`json_object`
- Prompt versions：`story-map.v2`、`story-map-reconcile.v2`
- 新 runtime dependency：`none`
- 本地脱敏指标：`/Users/kdnsna/Projects/06-项目代码/novelripple/.data/evals/m1-baseline/20260812085148247-37aeb6b-5e79e596/metrics.json`
- 本地人工复核数据库：同目录 `eval.db`；它被 Git 忽略，不进入公开报告或 CI

本报告是 M1-02A 的正式验收记录。较早的 `20260812083345231-14be746-0db11d1e` run 使用了 `deepseek-v4-flash`，未满足“与 M1-02 历史 baseline 使用同一个 `deepseek-chat` model”的前提，因此只保留为 Historical / INVALID 数据，不参与本门结论，也没有被删除或覆盖。

## Compatibility decision

M1-02A 只在现有 OpenAI-compatible Provider 中增加显式 `json_object` wire mode。DeepSeek 调用固定发送 `{ "type": "json_object" }`；没有 capability detection、自动 fallback、供应商切换或额外 repair。`json_schema` 与 `prompt_json` 仍是显式、互不降级的既有选项。

Story Map Source Packet 由不可变 Source 的 Section / 自然段确定性派生 Evidence Unit。模型 Candidate 只返回 `evidenceUnitIds: string[]`；服务端拒绝未知、重复、跨 Source 或被篡改的 Unit，并确定性生成现有 `SourceReference[]` 的 Source、Section、UTF-16 offset 与 excerpt Hash。最终 Story Map、Artifact、revision、Impact Plan、Worldline 与 Continuation Schema 均未改变。

Open-source preflight 只使用 [DeepSeek JSON Output 官方文档](https://api-docs.deepseek.com/guides/json_mode)、[DeepSeek Chat Completion 官方文档](https://api-docs.deepseek.com/api/create-chat-completion)、[OpenAI Chat Completions 官方文档](https://platform.openai.com/docs/api-reference/chat/create)、[OpenAI Node 官方仓库](https://github.com/openai/openai-node)和 [Google LangExtract 官方仓库](https://github.com/google/langextract)。采用 DeepSeek / OpenAI 的官方 wire protocol，LangExtract 只借鉴“模型引用、服务端定位、未定位即拒绝”的 grounding 方法；没有复制代码或引入 Python / LangExtract runtime。

## Frozen Story A / B / C result

| Story | Extractor first pass | Extractor repair | Reconciler first pass | Reconciler repair | Evidence validity | Artifact | input tokens | output tokens | total tokens | wall-clock |
| --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| A | failed | succeeded | passed | not needed | 45 / 45（100%） | created | 82,312 | 12,044 | 94,356 | 58,283 ms |
| B | passed | not needed | failed | succeeded | 52 / 52（100%） | created | 182,476 | 13,754 | 196,230 | 68,359 ms |
| C | failed | succeeded | failed | succeeded | 43 / 43（100%） | created | 158,220 | 17,183 | 175,403 | 78,803 ms |

三篇均使用与 M1-02 历史失败 run 相同的 `deepseek-chat` model，以及同一 Provider、Prompt 版本与 `json_object` 模式。所有首轮失败都由该阶段唯一一次完整 repair 修复；没有 Provider call failure、第二次 repair、fallback 或半成品 Artifact。

Suite 状态为 `awaiting_human_review`。人工复核队列位于上述 `metrics.json` 的 `stories[*].storyMap.events.manualReviewQueue`、`edges.manualReviewQueue` 与 `endingCandidates.manualReviewQueue`；对应 review target 在 `stories[*].reviewTarget`。队列规模如下：

| Story | Event candidates | Edge candidates | Ending candidates |
| --- | ---: | ---: | ---: |
| A | 13 | 10 | 1 |
| B | 14 | 12 | 2 |
| C | 15 | 11 | 2 |

这些队列尚未产生人工 Event recall、人物 identity、主要因果 Edge 或 Ending Candidate 结论，不能提前用自动 Evidence PASS 冒充完整 M1-02 baseline PASS。

## Deterministic regression gates

- `npm run lint`：PASS
- `npm run typecheck`：PASS
- `npm run test:unit`：24 files / 156 tests PASS
- `npm run test:contract`：1 file / 4 tests PASS
- `npm test`：25 files / 160 tests PASS
- `npm run build`：PASS
- `CI=1 npm run test:e2e`：7 tests PASS

依赖、Drizzle Schema、`story-map.v1` 与 `story-map-reconcile.v1` 均无漂移；M0 fixture、Story Map、Ripple、Worldline 与 Continuation 回归通过。脱敏 JSON 的隐私标记均为 `false`（不含 Source body、raw model output、私人标题或人物名），`.env.local`、`benchmarks/private/` 与 `.data/` 均保持 Git ignored。

## Next gate

M1-02 已具备继续 baseline 的 Provider 与 Evidence Grounding 条件。下一步只能继续 M1-02 的人工 Story Map 复核、不可变 revision / confirmed Story Map、strict / open Ripple 与 Continuation 记录；本报告不提供 section-first 证据，也不授权进入 M1-03。

## Final result

**M1-02A PASS**
