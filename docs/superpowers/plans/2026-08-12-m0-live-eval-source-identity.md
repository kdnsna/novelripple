# M0 Live Eval Source Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `ripple-001` Live Eval 在 Golden 与运行时 Source 内容相同但实例 ID 不同时仍可安全映射 Event，并在内容身份不同或任一侧 Evidence 非法时 fail closed。

**Architecture:** `scoreFixtureStoryMap` 显式接收 `goldenSource` 与 `candidateSource`。评分先比较两者 `contentHash`，再分别用既有 Story Map Validator 和 Evidence Hash 校验对应 Source；只有各自合法的 Evidence 才进入基于 section、offset 和双向覆盖率的一对一映射，跨运行实例不比较 Source ID 字符串。生产导入、Story Map 和 Evidence 绑定逻辑保持不变。

**Tech Stack:** TypeScript、Vitest、Zod、Node.js、Playwright、GitHub Actions。

---

## File map

- `src/evals/m0-live-eval.ts`: 拥有跨实例 Source 内容身份门和 Story Map 自动评分逻辑。
- `scripts/eval-live.ts`: 把 Fixture Source 与运行时导入 Source 分别传给评分器。
- `tests/unit/m0-live-eval.test.ts`: 覆盖同文异 ID、异文 fail-closed 及已有匹配防线。
- `docs/evals.md`: 记录跨运行评分只在内容身份一致且两侧 Evidence 分别有效时忽略实例 ID。
- `docs/evals/runs/*.md`: 保存绑定代码 Commit SHA 的脱敏真实人工复核结果。

### Task 1: Reproduce the cross-run identity bug

**Files:**
- Modify: `tests/unit/m0-live-eval.test.ts`

- [ ] **Step 1: Add a same-content/different-ID regression test**

构造 `candidateSource.id = "source_runtime_candidate"`，把 Candidate Story Map 本身及 Event、Edge、Ending Evidence 全部重绑到该 ID，保持正文与 `contentHash` 和 Golden 相同；期望 `eventIdMap` 为 12/12。

- [ ] **Step 2: Add a mismatched-content fail-closed test**

构造内容和 `contentHash` 都不同的 Candidate Source，期望评分器抛出包含 `contentHash` 的诊断错误。

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npx vitest run tests/unit/m0-live-eval.test.ts`

Expected: 同文异 ID 映射得到 0/12，异文没有抛错；失败原因直接对应缺失的跨实例身份门。

### Task 2: Implement the minimal scoring boundary

**Files:**
- Modify: `src/evals/m0-live-eval.ts`
- Modify: `scripts/eval-live.ts`
- Modify: `tests/unit/m0-live-eval.test.ts`
- Modify: `docs/evals.md`

- [ ] **Step 1: Replace the single Source input**

将评分输入改为：

```ts
{
  goldenSource: Source;
  candidateSource: Source;
  golden: StoryMap;
  candidate: StoryMap;
}
```

- [ ] **Step 2: Add the content identity gate before scoring**

若两个 Source 的 `contentHash` 不同，立即抛错；分别以 Golden/ Candidate Source 调用 `validateStoryMap`，Golden 非法时立即拒绝，Candidate 问题继续进入现有可诊断评分结果。

- [ ] **Step 3: Match only independently valid Evidence**

`matchEvents` 接收两侧 Source；每个 Event 的 Evidence 先用现有 `isValidEvidence(reference, correspondingSource)` 过滤，再计算 section、offset、最小 12 字符和双向 50% 覆盖率。`evidenceSimilarity` 不再比较 `sourceId`，也不要求不同范围的 `excerptHash` 字符串相等，因为两侧 Hash 已分别对各自 Source 切片验证。

- [ ] **Step 4: Update all callers and eval documentation**

单元测试同源调用显式传同一个 Source 两次；`scripts/eval-live.ts` 传 `fixture.source` 与 `imported.source`。文档说明该规则仅用于 Eval 跨实例对照，不改变生产绑定。

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/m0-live-eval.test.ts`

Expected: 所有 Live Eval 单元测试通过，包括 12/12 跨 ID、异文 fail-closed、短子串、宽/窄重叠与一对一映射。

### Task 3: Verify, evaluate, report, and publish

**Files:**
- Create: `docs/evals/runs/<date>-<short-sha>-m0-live-eval.md`

- [ ] **Step 1: Run the complete local gate**

依次运行用户指定的 lint、typecheck、unit、contract、full Vitest、build 和 `CI=1` E2E；任何失败先按系统化调试修复。

- [ ] **Step 2: Review and commit the code change**

审计只包含本计划、评分器、调用方、测试和评测文档，提交后记录代码 Commit SHA。

- [ ] **Step 3: Run real Live Eval from the committed code**

使用仓库现有真实配置执行 `npm run eval:live`，读取脱敏 JSON 自动报告与人工 rubric；不得把 Source、完整 Prompt、密钥或 raw model output 写入报告。

- [ ] **Step 4: Complete the manual report**

以模板记录 provider/model、代码 Commit SHA、Prompt versions、主要因果边认可率、每个 unmatched Event disposition、Continuation 正文与结构化矛盾检查及最终 PASS/FAIL，再单独提交报告。

- [ ] **Step 5: Push and verify GitHub Actions**

推送 `agent/m0-live-eval-source-identity`，创建面向 `main` 的 PR 以触发 M0 workflow，并等待该 PR 的 M0 gate 全绿。最终只按用户要求输出 `M0 PASS` 或 `M0 FAIL`。

## Open-source preflight

检索日期：2026-08-12。此修复只调整仓库内部 Eval 对照逻辑，不改变产品行为、架构、数据模型、依赖或用户流程；复用现有 `Source.contentHash`、`validateStoryMap`、`sha256` 与 Evidence overlap 实现即可形成最小完整修复，因此无需引入或比较外部依赖。新增依赖、第二套 Source 标识、兼容 shim 和生产数据迁移均不采用。
