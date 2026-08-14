# M1-06 实现计划：真实作品单场景 Continuation 质量

目标：不增加无限续写/章节系统，只提高"一条新世界线的第一个场景"在真实作品上的一致性、连续性和阅读价值。仍保持 3 directions → user selects 1 → 1 scene。

## 需求源

- `docs/plan/m1-real-story-codex-execution-plan.md` 的 M1-06 章节（唯一事实源）
- 仓库纪律：`AGENTS.md`、`docs/mvp.md`、`docs/evals.md`、`docs/domain.md`、`docs/decisions/0003/0004`

## 现有代码（侦察结论，2026-08-14）

- 生成管线：`src/server/continuation/generate-continuation.ts`
  - `loadContinuationContext()` → `buildPrompt(stage, context, selectedDirection)` → `generateStructured` → validate → artifact
  - 现有 packet：readonlyCanonical（characters + relevantEvents + edges + anchors 相关 endingCandidates）+ relevantEvidence（相关事件 evidence 直接 slice normalizedText）+ currentWorldline/divergence/acceptedImpactPlan/currentState/selectedDirection
- 契约：`src/domain/schemas/continuation.ts`（prose `min(100)`；title/prose/statePatch）
- 一致性校验：`src/domain/invariants/validate-continuation.ts`（deriveWorldlineDelta / validateContinuationDirections / validateContinuationStatePatch）
- Prompt：`prompts/continuation.v1.md`（stage: directions|scene）
- 测试：`tests/unit/continuation-generation.test.ts`、`tests/unit/continuation-domain.test.ts`
- 评测基建：`scripts/eval-m1-ripple-guidance.ts` + `src/evals/m1-ripple-guidance.ts`（M1-06 仿此新建）；`.env.local`（gitignored）= deepseek-v4-flash 评测环境

## 任务

### T1. Context Selector 纯函数（核心新增）

新建 `src/domain/continuation/select-continuation-context.ts`（纯函数，无 IO、无随机）：

```
selectContinuationContext(input: {
  storyMap: StoryMap; source: Source; worldline: Worldline;
  acceptedImpactPlan: ImpactPlanArtifact; selectedDirection: ContinuationDirection;
}): ContinuationContextPacket
```

packet 必须包含：
- **deterministic representative excerpts**（确定性选择，全部从 `source.normalizedText` 直接切片，带 sectionId/start/end/excerptHash 元数据）：
  1. 开头代表片段（正文前部固定窗口）
  2. 中段代表片段（正文中段固定比例位置窗口）
  3. 结尾代表片段（正文末尾窗口）
  4. divergence 周边片段（divergence event 的 evidence 定位处窗口）
- **selected characters 相关 Evidence**：selectedDirection.affectedCharacterIds → 相关 event evidence 切片（复用 `src/domain/source/evidence-units.ts` 的派生 Unit 语义，先读它）
- **总字符预算**：硬上限（建议 6000 字符，在实现中定为常量并测试断言）；绝不输出整本书
- 现有 relevantEvidence/readonlyCanonical 保留在 packet 或与新结构整合（实现者决定，保持向后兼容）

测试 `tests/unit/continuation-context-selector.test.ts`：
- deterministic：同输入两次输出逐字节相等
- source grounded：每个片段 start/end 在 normalizedText 边界内且 slice 与 excerptHash 一致
- no whole source：packet 内嵌文本总字符 < source 的某个比例（如 25%）且 ≤ 预算
- max context budget：任意输入 packet ≤ 预算常量

### T2. 接入生成管线 + Prompt v2

- `generate-continuation.ts`：scene 阶段调用 selectContinuationContext，把 excerpts + character evidence 并入 packet；promptVersion bump 为 `continuation.v2`
- 新建 `prompts/continuation.v2.md`（基于 v1 增补，不动 v1 文件）：
  - 风格上下文规则：叙事人称一致、时态/视角一致、对话密度相近、句式不突兀、不突然变成说明文、**不复制长段 Source 原文**（可以写相似句式，不抄原文句子）
  - 长度要求：1200–2000 中文字符（目标范围，不截断制造假合规，过短=质量问题）
  - 保留 v1 全部硬约束（readonlyCanonical 只读、generated: 命名空间、不恢复已删事实等）
- directions 阶段不注入风格片段（计划只要求 scene）

### T3. Scene 长度契约

- `src/domain/schemas/continuation.ts`：`ContinuationSceneModelOutputSchema.prose` 下限 100 → **1200**（fail closed：过短拒绝；上限不硬切，由 eval 度量）
- 同步：`ContinuationSchema.prose` 下限（若 artifact schema 也校验）；mock provider（`src/server/ai/mock-provider.ts`）的 scene 输出若不足 1200 字必须同步加长，否则 e2e/单测会挂；受影响的既有测试同步更新
- 注意上限 2000 只作评测指标记录，不做 schema 硬约束、不截断

### T4. 一致性检查确认/补强

- 对照 M1-06 第七节六项，确认 `validateContinuationStatePatch` 覆盖：resurrected removed facts / deleted accepted facts / pre-divergence mutation / Anchor deletion / invalid character / invalid thread；缺哪项补哪项 + 补测试

### T5. 测试与全量门禁

- 新增/更新单测 + 契约测试（prose 长度、T4 六项、T1 四项）
- 全量：`npm run lint`、`npm run typecheck`、`npm run test:unit`、`npm run test:contract`、`npm test`、`npm run build`、`CI=1 npm run test:e2e`
- 全部通过才进入 T6

### T6. 三篇真实 benchmark Continuation（评测子代理）

- 新建 `src/evals/m1-continuation.ts` + `scripts/eval-m1-continuation.ts`（仿 `eval-m1-ripple-guidance`：基线 db 复制、run-id、metrics.json 到 .data/evals/、脱敏报告到 docs/evals/runs/）
- 三篇 A/B/C（`benchmarks/private/m1-a-zhuanzhengqi`、`m1-b-chunsheng`、`m1-c-wudu`）各自：3 directions → 选 1 → 1 scene
- 自动指标：prose 字符数（1200-2000 达标与否）、statePatch 硬门、六项一致性、token 消耗
- 输出脱敏评测报告（按 M1-05 报告格式：结论/合同/自动结果/人工量表占位），报告不含私人正文/标题/人名
- 模型用现有 `.env.local`（deepseek-v4-flash），报告如实记录

### T7. 人工量表（不在子代理范围）

worldline/character/narrative/scene interest 1–5 + would continue reading，由小锤子预审 + 大爷终评。gate：worldline≥4、narrative≥3.5、≥2/3 愿意继续读。

## 不做（计划第十节）

Scene 2 / Chapter 2 / auto continue / long-term memory / summary compaction / vector retrieval / agent writer / style fine-tuning / embedding / Style Artifact / 复杂文学评分字段进生产 Schema

## 提交纪律

未经小锤子（协调者）确认不 commit；实现完成后停在工作区，由协调者复核后再提交（中文 message）。
