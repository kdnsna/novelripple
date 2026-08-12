# M1-05 Ripple Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. NovelRipple explicitly forbids multi-Agent execution for this Issue. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 confirmed Story Map 提供最多三个可解释分叉建议，并允许用户用一次明确反馈完整重生成具有不可变 lineage 的 Impact Plan candidate。

**Architecture:** 复用现有 `artifacts` 表、Generation Run、OpenAI-compatible provider、Zod 和 Ripple validator。新增 `ripple_suggestions` Artifact；反馈 candidate 仍是 `impact_plan`，但携带冻结 Story Map / Divergence / mode / Anchors 的 lineage。Preview 差异是纯领域派生视图，不新增事实源。

**Tech Stack:** TypeScript、Zod 4、SQLite/Drizzle、Next.js 16 Server Actions、React 19、Vitest、Playwright。

---

### Task 1: Suggestions 与 lineage Schema

**Files:**
- Create: `src/domain/schemas/ripple-suggestion.ts`
- Modify: `src/domain/schemas/artifact.ts`
- Modify: `src/domain/schemas/index.ts`
- Modify: `src/server/db/schema.ts`
- Test: `tests/unit/domain-schemas.test.ts`

- [ ] **Step 1: 写失败测试**

增加断言：`RippleSuggestionsSchema` 接受 1–3 个严格字段候选并拒绝第四个；`RippleSuggestionsArtifactSchema` 只接受 `kind=ripple_suggestions`；feedback `ImpactPlanArtifact` 的 lineage 必须满足 `newGenerationRunId===generationRunId`、`sameStoryMapArtifactId===storyMapArtifactId`、`sameDivergence===impactPlan.divergence`、`sameMode===impactPlan.mode`、`sameAnchors===impactPlan.anchors`。

- [ ] **Step 2: 验证 RED**

Run: `npm run test:unit -- tests/unit/domain-schemas.test.ts`  
Expected: FAIL，因为 schemas/exports 尚不存在。

- [ ] **Step 3: 最小实现**

定义：

```ts
export const RippleSuggestionSchema = z.object({
  eventId: z.string().min(1),
  divergenceType: z.enum(["prevent", "choice", "outcome"]),
  instruction: z.string().trim().min(1).max(500),
  whyInteresting: z.string().trim().min(1).max(1000),
  affectedCharacterIds: z.array(z.string().min(1)).min(1),
  anchorRisk: z.enum(["low", "medium", "high"]),
}).strict();
```

用 `{ suggestions: z.array(...).min(1).max(3) }` 包装模型输出。Artifact 绑定 confirmed Story Map 和成功 Run；Impact lineage 用可空默认字段兼容既有 v1 Artifact，feedback candidate 使用 schemaVersion 2。将 Drizzle TypeScript enum 扩为 `ripple_suggestions`；SQLite 列本身是 text，无需数据迁移。

- [ ] **Step 4: 验证 GREEN**

Run: `npm run test:unit -- tests/unit/domain-schemas.test.ts`  
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/domain/schemas src/server/db/schema.ts tests/unit/domain-schemas.test.ts
git commit -m "领域：定义涟漪推荐与反馈谱系"
```

### Task 2: Suggestions 生成与持久化

**Files:**
- Create: `prompts/ripple-suggestions.v1.md`
- Create: `src/server/ripple/generate-ripple-suggestions.ts`
- Create: `src/server/ripple/generate-configured-ripple-suggestions.ts`
- Create: `src/server/repositories/ripple-suggestions-repository.ts`
- Test: `tests/unit/ripple-suggestions.test.ts`

- [ ] **Step 1: 写失败测试**

用公开 fixture + `MockAIProvider` 覆盖：confirmed 才能生成；三条合法建议可保存；第四条、未知 Event、最后 Event、无 downstream Event、未知/重复 Character、重复 Event 全组 fail closed；失败最多一次 repair；Artifact 数与 Worldline 数分别为 1 和 0；模型 Prompt 不含 Source 正文且只含最小 Story Map 投影。

- [ ] **Step 2: 验证 RED**

Run: `npm run test:unit -- tests/unit/ripple-suggestions.test.ts`  
Expected: FAIL，因为生成与仓储模块不存在。

- [ ] **Step 3: 最小实现**

`generateRippleSuggestions` 加载 confirmed Artifact，构造仅含 Event/Character role/Edge/Ending 的 JSON context，使用 `generateStructured` 与 `RippleSuggestionsModelOutputSchema`。自定义 validator 检查引用、去重、Event 非末尾且通过 `causes|enables` 图至少可达一个后续 Event。验证成功后 `createRippleSuggestionsArtifact` 绑定成功的 `kind=ripple_suggestions` Generation Run 并写入现有 artifacts 表。

- [ ] **Step 4: 配置 Mock 与真实 provider**

`generateConfiguredRippleSuggestions` 复用 `readConfiguredAI/createConfiguredAIProvider`。公开 fixture 的 Mock 固定返回三个符合合同的建议；私人/非 fixture Source 在 Mock 下 fail closed。

- [ ] **Step 5: 验证 GREEN 并提交**

Run: `npm run test:unit -- tests/unit/ripple-suggestions.test.ts`  
Expected: PASS。

```bash
git add prompts/ripple-suggestions.v1.md src/server/ripple src/server/repositories/ripple-suggestions-repository.ts tests/unit/ripple-suggestions.test.ts
git commit -m "功能：生成可追踪涟漪建议"
```

### Task 3: Feedback 完整重生成

**Files:**
- Create: `prompts/impact-plan-feedback.v1.md`
- Modify: `src/server/ripple/generate-impact-plan.ts`
- Modify: `src/server/ripple/generate-configured-impact-plan.ts`
- Modify: `src/server/repositories/ripple-repository.ts`
- Test: `tests/unit/ripple-generation.test.ts`
- Test: `tests/unit/ripple-acceptance.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖：父 candidate 保持不变；非空 feedback 产生新 ID/Run/Artifact；新 Artifact lineage 精确记录父候选、feedback、新 Run 与冻结合同；客户端不能提供替代 Divergence/mode/Anchors；非法完整输出一次 repair 后仍非法则只有 failed Run，没有新 Artifact；连续反馈形成链；接受链中选中的一个 candidate 只产生一个 child Worldline。

- [ ] **Step 2: 验证 RED**

Run: `npm run test:unit -- tests/unit/ripple-generation.test.ts tests/unit/ripple-acceptance.test.ts`  
Expected: FAIL，因为 feedback API 与 lineage 持久化不存在。

- [ ] **Step 3: 最小实现**

抽取内部完整生成函数。初次生成使用 `impact-plan.v2`；反馈生成只接收 `priorCandidateArtifactId` 与 `feedback`，从数据库读取并冻结其 Story Map、Divergence、mode、Anchors，使用 `impact-plan-feedback.v1` 请求完整 `ImpactPlanModelOutput`，随后复用同一 `validateModelOutput`。`createImpactPlanArtifact` 可选接收父 candidate，并写入 schemaVersion 2 lineage；parser 兼容没有 lineage 的既有 JSON。

- [ ] **Step 4: Mock feedback**

公开 fixture Mock 返回一个完整合法计划，并只对其 direct impact 的说明加入“已根据明确反馈重新判断”的测试文本；不 patch 已保存 Artifact。

- [ ] **Step 5: 验证 GREEN 并提交**

Run: `npm run test:unit -- tests/unit/ripple-generation.test.ts tests/unit/ripple-acceptance.test.ts`  
Expected: PASS。

```bash
git add prompts/impact-plan-feedback.v1.md src/server/ripple src/server/repositories/ripple-repository.ts tests/unit/ripple-generation.test.ts tests/unit/ripple-acceptance.test.ts
git commit -m "功能：支持影响计划反馈重生成"
```

### Task 4: Preview 领域差异

**Files:**
- Create: `src/domain/ripple/derive-impact-plan-comparison.ts`
- Test: `tests/unit/impact-plan-comparison.test.ts`

- [ ] **Step 1: 写失败测试并验证 RED**

测试 `originalPath` 按 Story Map sequence 去重排序；`newPath` 来自 Impact summary；`removed/modified/added/preserved` 各自只包含对应 `changeType`，且未知引用由已有 Impact validator 拒绝。

Run: `npm run test:unit -- tests/unit/impact-plan-comparison.test.ts`  
Expected: FAIL，因为派生函数不存在。

- [ ] **Step 2: 最小实现并验证 GREEN**

实现纯函数：收集所有 reasonPath Event ID，以 Story Map 的 sequence 映射成 `{eventId,title}`；按 `changeType` 分组 `{impactId,summary,affectedEventId}`。函数不写 Artifact。

Run: `npm run test:unit -- tests/unit/impact-plan-comparison.test.ts`  
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add src/domain/ripple/derive-impact-plan-comparison.ts tests/unit/impact-plan-comparison.test.ts
git commit -m "领域：派生涟漪新旧路径差异"
```

### Task 5: Server Actions 与界面旅程

**Files:**
- Modify: `src/app/projects/actions.ts`
- Modify: `src/components/story-workspace/ripple-simulator-panel.tsx`
- Modify: `src/components/story-workspace/story-map-review-workspace.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/e2e/ripple-simulator.spec.ts`

- [ ] **Step 1: 写失败 E2E**

增加一条公开 fixture 旅程：confirmed 后生成恰好三张推荐卡；点选建议只预填表单且页面仍显示“尚未创建子 Worldline”；切换完整图手选 Event 仍可打开 Ripple；生成 Preview 后能看到原路径、新路径、删除/修改/新增/保持；输入一次反馈得到“基于上一候选重新推演”与新 candidate；接受当前 candidate 后只显示一条子 Worldline。

- [ ] **Step 2: 验证 RED**

Run: `CI=1 npm run test:e2e -- tests/e2e/ripple-simulator.spec.ts`  
Expected: FAIL，因为推荐、反馈与差异 UI 不存在。

- [ ] **Step 3: Actions**

新增 `generateRippleSuggestionsAction({projectId,storyMapArtifactId})` 与 `regenerateRipplePreviewAction({projectId,priorCandidateArtifactId,feedback})`；使用严格 Zod 输入，返回安全错误，不接受可漂移的 Divergence/mode/Anchor 字段。

- [ ] **Step 4: UI**

Ripple panel 顶部提供一个“生成 3 个推荐分叉点”次级操作；卡片选择只设置 Event/type/instruction。Preview 用派生函数展示五类差异并提供单行明确反馈表单。每次成功反馈将 `candidateArtifact` 替换为新 Artifact，保留 lineage 标签；接受始终使用当前 Artifact ID。手动选择流程不删除。

- [ ] **Step 5: 验证 GREEN 并提交**

Run: `CI=1 npm run test:e2e -- tests/e2e/ripple-simulator.spec.ts`  
Expected: PASS。

```bash
git add src/app/projects/actions.ts src/components/story-workspace src/app/globals.css tests/e2e/ripple-simulator.spec.ts
git commit -m "界面：引导选择分叉并反馈重推"
```

### Task 6: 私人 Benchmark、文档与全量门禁

**Files:**
- Create: `scripts/eval-m1-ripple-guidance.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/domain.md`
- Modify: `docs/evals.md`
- Create: `docs/evals/runs/m1-05-ripple-guidance-2026-08-13-<sha>.md`
- Local ignored: `.data/evals/m1-ripple-guidance/<run-id>/metrics.json`

- [ ] **Step 1: 建立显式非 CI runner**

Runner 接受三个 private manifest，复制 M1-02 本地评测数据库到新 ignored run 目录，对各自最新 confirmed Story Map 生成建议，并在给定脱敏人工选择/反馈时完整重生成 candidate。JSON 只记录 Story A/B/C、provider/model/prompt、ID/计数、token/duration、硬校验和人工字段；不记录标题、正文、suggestion 文案、feedback、Evidence、Prompt 或 raw output。

- [ ] **Step 2: 运行三篇并如实记录**

Run: `npm run eval:m1:ripple-guidance -- --manifest benchmarks/private/...`  
Expected: 每篇最多三个建议、至少一条 feedback Generation Run；人工“值得改变”和反馈语义结果若无人独立判断则为 `awaiting_human_review`，不得自动标 PASS。

- [ ] **Step 3: 更新事实文档**

记录 Artifact/lineage/差异派生、Open-source preflight、Prompt 版本、真实 Benchmark 指标与任何未完成人工门。Prompt 改动对应本次新真实 Eval 报告；不覆盖旧报告。

- [ ] **Step 4: 运行完整门禁**

依次运行：

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm test
npm run build
CI=1 npm run test:e2e
```

全部必须 exit 0；私人内容扫描与 `git diff --check` 也必须通过。

- [ ] **Step 5: 提交与推送**

```bash
git add package.json README.md docs scripts src tests prompts
git commit -m "评测：记录 M1 涟漪引导回归"
git push -u origin agent/m1-05-ripple-guidance
```
