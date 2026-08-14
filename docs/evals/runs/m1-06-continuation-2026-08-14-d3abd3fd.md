# M1-06 单场景 Continuation 质量（awaiting_human_review，2026-08-14）

日期：2026-08-14
实现 commit：`868249c3c4bc61b32d139adc3875c13f775cef32`（Context Selector + continuation.v2 + 长度契约 + 空响应重试）
正式自动回归 run-id：`20260814054950374-868249c-d3abd3fd`
原始脱敏指标：`.data/evals/m1-continuation/20260814054950374-868249c-d3abd3fd/metrics.json`（Git ignored，不公开）

> 隐私边界：报告只使用 Story A/B/C、结构计数、token、时长与门禁状态；不包含私人作品标题、人物名、Event 内容、Suggestion/Scene 原文、Source 正文、私人路径、截图、完整 Prompt、raw model output 或密钥。评测数据库是 M1-04 本地数据库的新副本（`m1-06-baseline.db`），旧 Source、Artifact、Worldline 与历史运行均未修改。

## 结论

M1-06 的确定性产品合同已实现：三篇真实作品均完成

```text
confirmed Story Map
→ 3 个 Ripple Suggestions
→ 1 个开放模式 Impact Plan candidate（接受）
→ active Worldline
→ 3 个 Continuation directions
→ 1 个 Continuation scene（continuation.v2，含确定性风格上下文）
```

三篇所有自动化硬不变量均通过：scene prose 长度全部落在 1200–2000 汉字目标区间、statePatch 六项一致性检查全部通过（hardGate=true）、Source/Story Map/canonical 与兄弟 Worldline 隔离五项全部不变、每个阶段一次成功（无 repair、无空响应重试）。

**M1-06 PASS**（2026-08-14 人工量表完成，见文末"人工量表记录"）。

## 实际产品合同

- `selectContinuationContext` 纯函数：确定性代表片段（开头/中段/结尾/divergence 周边）+ selected characters Evidence，总预算 `min(6000, 原文 25%)` 硬上限，机制上杜绝整书 dump（单元测试断言）。
- scene 输出契约不变：`title / prose / statePatch`；`prose` 下限提升为 1200 字符（fail closed）。
- prompt `continuation.v2`：风格原则（人称/时态/对话密度/句式/不抄原文）+ 长度口径（1200–2000 汉字）；directions 阶段保持 `continuation.v1`。
- 工程修复（本次评测暴露）：DeepSeek 推理模型显式 `max_tokens` 会把思考+正文锁在同一预算内导致空响应——评测环境不传 `max_tokens`，并对空文本响应自动重试两次（不占 repair 名额）。

## 自动结果

| 阶段 | Story A | Story B | Story C |
| --- | --- | --- | --- |
| Story Map | reused_confirmed v31 | confirmed_by_harness v138 | confirmed_by_harness v102 |
| Suggestions | 3 / succeeded | 3 / succeeded | 3 / succeeded |
| Impact Plan | succeeded（open） | succeeded（open） | succeeded（open） |
| Worldline | active（anchors 0） | active（anchors 0） | active（anchors 0） |
| Directions | 3 / 3 distinct | 3 / 3 distinct | 3 / 3 distinct |
| Scene（continuation.v2） | succeeded | succeeded | succeeded |
| prose 总字符 / 汉字 | 1618 / **1335** | 1555 / **1274** | 1747 / **1396** |
| 长度在目标区间 | ✅ 是 | ✅ 是 | ✅ 是 |
| statePatch | +3 事实 / 0 删 / 4 人物 / 1 线索开 | +4 / 0 / 2 / 1 | +4 / 0 / 2 / 2 开 |
| 六项一致性 hard gate | ✅ 通过（0 违规） | ✅ 通过（0 违规） | ✅ 通过（0 违规） |
| 隔离（Source/StoryMap/Worldline） | ✅ 5/5 不变 | ✅ 5/5 不变 | ✅ 5/5 不变 |
| 阶段 token 合计 | 79,297 | 77,910 | 98,274 |

模型：`deepseek-v4-flash`；模式：`json_object`（DeepSeek 兼容，本地 Zod 校验）；无任何阶段触发 repair 或空响应重试。

## 人工量表记录（2026-08-14 完成）

评分人：大爷（真实读者）。每篇依据本地私有场景存档（`m1-06-scenes/m1-06-story-<class>.md`）全文阅读后评分。

| 维度 | Story A | Story B | Story C |
| --- | --- | --- | --- |
| Worldline consistency 1–5 | 5 | 5 | 5 |
| Character continuity 1–5 | 5 | 5 | 5 |
| Narrative continuity 1–5 | 5 | 5 | 5 |
| Scene interest 1–5 | 5 | 5 | 5 |
| Would continue reading | yes | yes | yes |

M1 gate 判定：
- worldline ≥ 4：三篇均 5 ✅
- narrative ≥ 3.5：三篇均 5 ✅
- ≥2/3 愿意继续阅读：3/3 ✅

**结论：M1-06 PASS。** 三篇真实作品均产出符合 Canon、Delta 与 Anchor 约束、风格一致且值得继续阅读的首个 Continuation 场景；场景长度全部落在 1200–2000 汉字目标区间。实现 commit `868249c`，评测 run `20260814054950374-868249c-d3abd3fd`。
