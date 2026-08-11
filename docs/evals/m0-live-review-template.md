# M0 Live Eval 人工复核报告

> 此报告必须脱敏：不得粘贴 Source 正文、完整 Prompt、密钥或 raw model output。只记录稳定 ID、比例、判断和足以复核的简短理由。建议将完成后的报告保存到未跟踪的 `.data/evals/`。

## 运行身份

- Provider / model：
- Commit SHA：
- Prompt versions：
- 自动报告路径：`.data/evals/m0-live-eval.json`

## 主要因果边认可率

- 人工认可边数：
- 复核边总数：
- 主要因果边认可率：
- 未认可边的稳定 ID 与简短理由：

M0 PASS 要求主要因果边认可率至少为 70%。不要在理由中复制原文。

## Unmatched Event 处置

自动报告中的每个 source-backed unmatched Event 都必须逐项填写 disposition。允许的处置建议使用：`valid-additional`、`duplicate`、`unsupported` 或 `hallucination`；不得只写“已复核”。若自动列表为空，明确记录 `none`。

| Candidate Event ID | Disposition | 简短理由（不含原文） |
| --- | --- | --- |
| none | none | 自动报告没有 source-backed unmatched Event |

## Continuation 正文矛盾检查

- 结构化 `statePatch` 自动检查：PASS / FAIL
- Continuation 正文是否恢复已删除事实、破坏 Anchor 或倒改分歧前 Canon：PASS / FAIL
- 矛盾对应的稳定 ID 与简短理由：

## 最终结论：PASS / FAIL

- 结论：
- 复核人：
- 复核时间：
- FAIL 原因或相对上次的退化项：
