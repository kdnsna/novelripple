# 0006：Story Map 分块召回，证据继续只认稳定 Unit ID

- 状态：Accepted
- 日期：2026-10-17
- 范围：Phase 1 Story Map 生成管线；不改变 Story Map Schema、最终 Evidence 合同或评测阈值

## 背景

旧管线把整部 Source 交给一次全书 Extractor，再由 Reconciler 做第二次全书调用。真实作品变长后，单次上下文和召回压力都落在同一次生成里；M1-02 的 baseline 已暴露出人物与 Ending 覆盖不足，M1-07 的 Story Map 指标也没有达到质量目标。

第一次系统性修复是 M1-03（`ca705d3`）：它按 Section 切分，并把模型侧证据改成 `sectionId` + `exactQuote`。真实回归中，模型给出的逐字摘录在声明 Section 内无法稳定唯一匹配，三篇都在一次 repair 后仍未通过本地 Evidence 校验，因而没有创建 Artifact。问题不在分块本身，而在把“逐字引用”交给模型。

## 决定

1. 只按不可变 Source 派生的自然段 Evidence Unit 切块，不按 Section，也不切开自然段；目标 6,000 字符，最小 3,000、最大 9,000，短尾回并。每块附带前 2 个只读上下文 Unit（第一块除外），上下文可引用为证据但不负责抽取。
2. 每块做一次抽取（`story-map-chunk.v1`），再做恰好一轮补抽（`story-map-glean.v1`）；抽取和补抽都最多 4 块并发。补抽只返回新增内容，并收到上一轮未覆盖的确定性人名候选。
3. 人名归并由程序先统计候选（姓氏 + 1–2 字、`老/小/阿` + 姓氏、姓氏 + 称谓、对白说话人；说话人命中提升排序），再由 `story-map-names.v1` 判断同一身份。每个候选必须恰好归入一个人物，不能凭空新增。
4. 结局轮次读取全书末尾约 20% 的 Unit（至少 3 个）及已汇总事件/人物，由 `story-map-endings.v1` 输出故事结局、补充收尾事件和人物结局；人物结局以 `【人物结局】<人物>：<命运>` 写入 `endingCandidates`。
5. 最终合并由 `story-map-merge.v1` 提出跨块重复事件组和跨块因果边，服务端确定性合并证据、参与者与状态变化，统一序列并去重边和结局。
6. 每个证据阶段都在本阶段做引用校验：块内只接受本块看到的 Unit，结局轮次只接受末尾与事件证据；最终合并对完整候选执行 Evidence Unit → `SourceReference[]` 解析和 Story Map 领域校验。Schema 或引用失败时只 repair 一次，仍失败即 fail closed，不写 Artifact；通过后才创建版本化 Artifact。

## 后果

- 模型每次只读一个块，全书召回不再依赖单次超长上下文；补抽、人名、结局和合并各自有明确输入，失败可以定位到阶段。
- 基础调用次数从两次全书调用变为 `2 × 块数 + 3` 次，token 成本随块数增加；4 路并发只缩短墙钟时间，不降低 token 成本。
- 分块边界仍可能切断跨块因果，2 个上下文 Unit 只能缓解相邻块的前情；跨块去重和跨块边依赖最终合并，模型漏报时不会被确定性补全。
- 人名候选是启发式统计，可能误报或漏报；模型仍必须基于事件和证据决定身份，不确定时保持独立。
- 结局轮次只看末尾约 20%（至少 3 个 Unit），如果结局信息主要在前文或通过回忆交代，可能漏掉；该轮次允许补充 `additionalEvents`，但不改变 Story Map Schema。
- 任一阶段一次 repair 后仍失败会让整次生成失败，不留下半成品 Artifact。真实模型 A/B/C 的 Phase 1 仪表盘数字尚未重测（私有基准正文不在仓库），不能把管线落地当作质量达标。

## 不变的部分

- Story Map Schema 不变：仍是 characters、events、edges、endingCandidates；人物结局复用 Ending Candidate，不新增字段。
- 模型侧证据仍只使用稳定 Unit ID，不返回 `exactQuote`、Section ID、偏移或 Hash；最终 Evidence 仍由服务端解析为现有 `SourceReference[]`，并执行 offset/hash 与领域校验。
- Source 只读；失败或重试不写 Artifact，成功后才创建绑定本次合并 Run 的版本化 Artifact。
- `docs/evals.md` 的硬不变量与质量目标阈值不变；本次没有真实模型数据，不调整任何门槛。
- M1-03 的撤销结论不变：sectionId + exactQuote 不作为生产证据路径。

## 后续加固

Phase 1 落地后的召回安全加固，不改变调用结构、Schema 或最终 Evidence 合同：

1. **错并防护**：`validateRoster` 要求每个 `mergedFrom` 候选的 `name` 等于合并后人物的 `name` 或出现在其 `aliases` 中（去空白比较）；不满足时要求一次 repair，仍失败即 fail closed。
2. **快速失败与调用预算**：分块并发在第一处失败后不再调度新任务，并通过可选 `AbortSignal` 中止在途 provider 请求。预计基础调用为 `2 × 块数 + 3`，最坏（每个调用 repair 一次）翻倍；新增 `STORY_MAP_MAX_MODEL_CALLS`（默认 120，正整数）与 `STORY_MAP_MAX_CHUNKS`（默认 50，正整数）。超限在任何模型调用前直接失败；运行中按真实尝试（含 repair）计数，超过预算立即失败。
3. **去重保留证据**：同一 `from|to|type` 的因果边、同一 `targetEventId|requirement` 的结局去重时，把重复项的 `evidenceUnitIds` 按顺序合并进保留项，包括经 `duplicateEventGroups` 归并的边。
4. **超长自然段**：分块时先丢弃最旧的上下文 Unit，避免 core+context 超过块上限；单个 Unit 超过导出的 `CHUNK_HARD_MAX_CHARS`（默认 `2 × CHUNK_MAX_CHARS`）时，在任何模型调用前失败，不切分自然段，保持 Unit ID 稳定。
5. **合并轮证据范围**：合并返回的边证据必须来自该轮看到的事件、已有边和结局的证据 Unit 并集，而不是“全书某处存在”；校验在 `applyMerge` 内以带路径的 issue 返回。

规模预警：分块数达到 20 时，在模型调用前用 `console.warn` 打印一次块数、预计基础/最坏调用次数和按 prompt 字符粗略估算的输入量，不打印原文。

## Open-source preflight

检索日期：2026-10-17。本次只记录已落地的仓库内管线，不新增依赖、不复制第三方代码。

- 复用 NovelRipple 已有 Evidence Unit、Zod Schema、`generateStructured` 的一次 repair 与 Story Map 领域校验；分块参数与并发上限分别由 `src/domain/source/evidence-unit-chunks.ts` 和 `src/server/story-map/generate-story-map.ts` 拥有。
- 新依赖：**none**。
