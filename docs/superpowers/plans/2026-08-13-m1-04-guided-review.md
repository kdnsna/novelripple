# M1-04 Guided Story Map Review Implementation Plan

**Goal:** Replace the default full-map manual review with a deterministic priority queue, readiness gate, and the minimum immutable Character/Event/Edge correction workflow required by the three M1 benchmarks.

**Architecture:** Keep Source and every Story Map Artifact immutable. Derive queue/readiness from the current Artifact and Source, store only confirmations plus one operation record in the existing `review_json`, and execute every mutation through the existing latest-revision transaction and domain validators. Reuse Evidence Units only as a local paragraph picker and React Flow only as a secondary view.

**Tech stack:** TypeScript 5.9, Zod 4, React 19, Next.js 16 Server Actions, SQLite/Drizzle, React Flow 12, Vitest 4, Playwright.

**Design:** [M1-04 design](../specs/2026-08-13-m1-04-guided-review-design.md)

---

## Task 1: Freeze review metadata and revision contracts

**Modify:**

- `tests/unit/story-map-artifact.test.ts`
- `tests/unit/story-map-schema.test.ts`
- `src/domain/schemas/artifact.ts`
- `src/domain/invariants/validate-story-map.ts`
- `src/server/repositories/story-map-artifact-repository.ts`

1. Add failing tests for backward-compatible review defaults, operation metadata, character confirmation, ending confirmation, and edge Evidence confirmation validation.
2. Run focused tests and verify RED.
3. Extend schemas with defaults and the complete discriminated change union; keep Artifact schema version and DB unchanged.
4. Extend review validation for unknown/duplicate Character, Ending and Edge confirmations.
5. Refactor revision creation to stamp `{type,timestamp,storyMapVersion}` only after the next version is known.
6. Run focused tests and verify GREEN.
7. Commit `领域：扩展故事地图核对修订合同`.

## Task 2: Derive Review Queue and Readiness

**Create:**

- `tests/unit/story-map-review.test.ts`
- `src/domain/review/derive-story-map-review.ts`

**Modify:**

- `src/domain/invariants/validate-story-map.ts` only if a reusable exported validator result is required.

1. Add failing pure-function tests for all eight priority classes, deterministic tie-breaks, exact alias collision, high-leverage reachability, important Evidence dedupe, core Character derivation and each readiness condition.
2. Run `npm test -- tests/unit/story-map-review.test.ts` and verify RED.
3. Implement one pure derivation owner with no total score and no persistence.
4. Add a revision-chain operation summary pure function that classifies material corrections and manual Event additions.
5. Verify focused tests GREEN.
6. Commit `功能：派生故事地图核对队列`.

## Task 3: Implement immutable Character and Event corrections

**Modify:**

- `tests/unit/story-map-artifact.test.ts`
- `src/server/repositories/story-map-artifact-repository.ts`

1. Add failing tests for rename/aliases/role, merge reference rewrites, confirmation invalidation, update Event fields, delete Event cascades, add Event with valid Source Evidence, invalid/foreign Evidence rollback, exact reorder, no-op rejection, stale base and old Artifact immutability.
2. Run focused tests and verify RED.
3. Implement minimal deterministic transformations and shared invalidation helpers.
4. Make add-event ID server-owned while keeping SourceReference client-selected and server-validated.
5. Verify all Story Map Artifact tests GREEN.
6. Commit `功能：支持人物与事件不可变修正`.

## Task 4: Implement immutable Edge corrections and final readiness gate

**Modify:**

- `tests/unit/story-map-artifact.test.ts`
- `src/server/repositories/story-map-artifact-repository.ts`

1. Add failing tests for add/change/delete Edge, fixed edge types, Edge Evidence confirmation/invalidation, dangling rollback, and refusal to confirm before readiness.
2. Add a happy path that completes required confirmations and creates one confirmed revision; repeat confirmation remains idempotent.
3. Run focused tests and verify RED.
4. Implement Edge transformations and call server-side readiness derivation in `confirmStoryMapArtifact`.
5. Verify focused unit/contract tests GREEN.
6. Commit `功能：完成因果边修正与可信门禁`.

## Task 5: Build the default Guided Review UI

**Create:**

- `src/components/story-workspace/story-map-review-queue.tsx`
- `src/components/story-workspace/story-map-readiness.tsx`
- `src/components/story-workspace/story-map-review-editor.tsx`
- `src/components/story-workspace/evidence-unit-picker.tsx`

**Modify:**

- `src/components/story-workspace/story-map-review-workspace.tsx`
- `src/components/story-workspace/story-map-details.tsx`
- `src/app/globals.css`
- `src/app/projects/actions.ts`

1. Extend the fixture E2E with initial assertions that Review Queue is default, readiness is visible, full graph is hidden, and final primary action is disabled.
2. Run the E2E file and verify RED.
3. Implement queue navigation, readiness, small Character/Event/Edge forms, two-step Evidence Unit selection, up/down reorder and explicit deletes.
4. Keep existing full graph behind a secondary toggle; preserve Source locate, Ripple and Continuation flows.
5. Ensure every mutation routes through the typed Server Action and opens the returned revision.
6. Run lint/typecheck and the focused E2E until GREEN.
7. Commit `界面：默认引导式核对故事地图`.

## Task 6: Complete E2E correction and recovery coverage

**Modify:**

- `tests/e2e/story-map-review.spec.ts`
- add another focused E2E file only if isolation materially reduces test complexity.

1. Cover Character merge, Event add after Evidence selection, Event delete, reorder, Edge add/change/delete, confirmation invalidation, stale revision using a second page, final confirmation, refresh recovery and Ripple gate.
2. Keep fixtures synthetic and public; do not screenshot private works or print Source text.
3. Run `CI=1 npm run test:e2e -- tests/e2e/story-map-review.spec.ts` and verify GREEN.
4. Commit `测试：覆盖引导式核对完整旅程`.

## Task 7: Run private A/B/C correction-cost regression

**Modify/create only after data exists:**

- `docs/evals/runs/m1-04-guided-review-2026-08-13-<sha>.md`
- `docs/evals.md`
- `README.md`
- `docs/domain.md`
- gitignored `.data/evals/m1-review/<run-id>/...`

1. Confirm three private manifests and source files exist without printing their content or metadata beyond Story A/B/C and allowed counts.
2. Create a new gitignored local eval directory; do not alter any M1-02 run or old Artifact.
3. Use the production app/revision flow to review each candidate. Record active review time manually, operation summary from revision chain, manual Event additions, capability gaps, and pass/fail. Do not infer active time from timestamps.
4. If the current candidate DB cannot be safely reused, run the existing `eval:m1:baseline` command to create new candidates; do not create a second Eval or Provider system.
5. Write a sanitized public report containing only Story A/B/C labels, allowed numerical metrics, evaluated commit, methodology and conclusion.
6. Update domain/readme/eval truth to match actual implementation and result; do not promise Character split.
7. Commit `评测：记录 M1 引导式核对回归`.

## Task 8: Full verification, privacy audit and delivery

1. Run:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm test
npm run build
CI=1 npm run test:e2e
```

2. Run `git diff --check`, inspect `git status`, and scan tracked diff/report for private paths, titles, Source text, secrets, raw model output and accidental dependency changes.
3. Verify no Prompt, production generation pipeline, Ripple, Worldline, Continuation, database migration or dependency changed outside necessary compatibility.
4. Commit any final documentation-only truth corrections with a Chinese single-intent message.
5. Push `agent/m1-04-guided-review` to origin as required by repository owner rules.
6. Report actual files, operation/readiness design, private benchmark numbers, every gate result, commit/remote state and exactly one conclusion: `M1-04 PASS` or `M1-04 FAIL`. Stop without entering M1-05.
