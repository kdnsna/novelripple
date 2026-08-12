# M1-03 Unified Section-First Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. NovelRipple explicitly forbids subagents and multi-Agent execution for M1-03.

**Goal:** Replace the full-book Story Map Extractor/Reconciler flow with one deterministic section-first pipeline that locally extracts every Source segment, globally reconciles only validated candidates and evidence references, and persists exactly one fully validated Story Map Artifact.

**Architecture:** Derive non-persistent `AnalysisSegment` values only at existing SourceSection boundaries; run the same local Extractor with at most two concurrent calls; resolve local exact-quote claims into temporary server-owned evidence references; dedupe by source positions; reconcile aliases, chronology, cross-segment edges, and endings without resending the whole Source; then map temporary references to the unchanged `SourceReference[]` and execute existing Story Map validation/persistence. Remove the production Evidence Unit candidate path so short and long works share one pipeline.

**Tech Stack:** TypeScript 5.9, Zod 4, OpenAI-compatible Provider, SQLite/Drizzle, Vitest 4, Next.js 16, Playwright.

**Design:** [M1-03 design](../specs/2026-08-12-m1-03-section-first-extraction-design.md)

---

## File map

**Create:**

- `src/domain/source/analysis-segments.ts` — pure SourceSection-boundary segment derivation and constants.
- `tests/unit/analysis-segments.test.ts` — one/many segment, boundary, tail, oversize Section, stability, and offset tests.
- `src/server/story-map/story-map-packets.ts` — local Segment Packet and body-free Global Reconcile Packet construction.
- `prompts/story-map.v3.md` — local character/event/edge candidate contract with exact quotes and core ownership.
- `prompts/story-map-reconcile.v3.md` — global alias/dedupe/chronology/edge/ending contract using temporary evidence reference IDs.
- `docs/decisions/0005-m1-section-first-extraction.md` — accepted architecture and official LangExtract preflight without duplicating product/eval definitions.
- `docs/evals/runs/m1-03-section-first-2026-08-13.md` — sanitized real A/B/C comparison report, created only after the run; the report body records the exact evaluated SHA.

**Replace or modify:**

- `src/domain/schemas/story-map.ts` — replace Evidence Unit candidates with local exact-quote and reconciled temporary-reference schemas; final schemas remain unchanged.
- `src/domain/source/resolve-story-map-evidence.ts` — replace Unit resolution with exact local claim resolution, core ownership, temporary reference registry, positional dedupe, and final resolution.
- `src/server/story-map/generate-story-map.ts` — unified segment orchestration, concurrency two, global reconcile, validation, and atomic Artifact boundary.
- `src/server/story-map/generate-configured-story-map.ts` — construct deterministic fixture responses for the unified production path.
- `tests/unit/story-map-candidate.test.ts` — exact resolution, unknown/duplicate/context claims, dedupe, arrays, and final temporary-reference resolution.
- `tests/unit/story-map-generation.test.ts` — one/multi segment, alias, cross-segment Edge, concurrency, failure rollback, repair, prompts, and unchanged offsets.
- `src/evals/m1-baseline.ts`, `scripts/eval-m1-baseline.ts`, `tests/unit/m1-baseline.test.ts` — report Segment count/status/repair plus existing quality/token/duration metrics without private content.
- `README.md`, `docs/domain.md`, `docs/evals.md` — describe the actual v3 unified pipeline and current Eval report contract.

**Delete after callers migrate:**

- `src/domain/source/evidence-units.ts`
- `tests/unit/evidence-units.test.ts`

**Must not change:**

- `SourceSchema`, `SourceReferenceSchema`, final `StoryMapContentSchema`/`StoryMapSchema`, Artifact schemas, database schema/migrations, repair budget, Provider modes, Impact Plan, Worldline, Continuation, Benchmark Gold, dependencies, v1/v2 historical Prompt files.

---

### Task 1: Derive deterministic Analysis Segments

**Files:**

- Create: `tests/unit/analysis-segments.test.ts`
- Create: `src/domain/source/analysis-segments.ts`

- [ ] **Step 1: Write failing one-segment and multi-segment tests**

Use synthetic Sources whose Section text lengths are explicit and assert the wished-for API:

```ts
import {
  ANALYSIS_CORE_MAX,
  ANALYSIS_CORE_MIN,
  deriveAnalysisSegments,
} from "@/domain/source/analysis-segments";

it("uses the unified derivation path for a one-segment Source", () => {
  const source = sourceWithSectionLengths("source_short", [2_500, 2_500]);
  expect(deriveAnalysisSegments(source)).toEqual([
    {
      id: "analysis_segment:source_short:0001",
      sourceId: "source_short",
      sectionIds: ["section_01", "section_02"],
      coreStart: 0,
      coreEnd: source.sections[1]!.end,
      contextStart: 0,
      contextEnd: source.sections[1]!.end,
    },
  ]);
});

it("cuts only at SourceSection boundaries and carries one preceding Section", () => {
  const source = sourceWithSectionLengths("source_long", [4_000, 4_000, 4_000, 4_000]);
  const segments = deriveAnalysisSegments(source);
  expect(segments.map((segment) => segment.sectionIds)).toEqual([
    ["section_01", "section_02"],
    ["section_03", "section_04"],
  ]);
  expect(segments[1]!.contextStart).toBe(source.sections[1]!.start);
  expect(segments[1]!.coreStart).toBe(source.sections[2]!.start);
  expect(segments[1]!.contextEnd).toBe(segments[1]!.coreEnd);
  expect(segments[0]!.coreEnd - segments[0]!.coreStart).toBeGreaterThanOrEqual(ANALYSIS_CORE_MIN);
  expect(segments[0]!.coreEnd - segments[0]!.coreStart).toBeLessThanOrEqual(ANALYSIS_CORE_MAX);
});
```

Add separate tests for a short tail that merges only when the combined core stays at or below 10k, a tail that remains short when merging would exceed 10k, a single oversize Section that is never split, invalid overlapping Sections that fail closed, stable IDs, and a surrogate pair proving unchanged UTF-16 offsets.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npm test -- tests/unit/analysis-segments.test.ts
```

Expected: FAIL because `analysis-segments.ts` and `deriveAnalysisSegments` do not exist.

- [ ] **Step 3: Implement the minimum pure derivation**

Create the public contract and one deterministic grouping function:

```ts
export const ANALYSIS_CORE_MIN = 6_000;
export const ANALYSIS_CORE_TARGET = 8_000;
export const ANALYSIS_CORE_MAX = 10_000;

export type AnalysisSegment = {
  id: string;
  sourceId: string;
  sectionIds: string[];
  coreStart: number;
  coreEnd: number;
  contextStart: number;
  contextEnd: number;
};

export function deriveAnalysisSegments(source: Source): AnalysisSegment[] {
  const sections = validateAndSortSections(source);
  const groups = groupCoreSections(sections);
  mergeShortTailWithinMaximum(groups);
  return groups.map((core, index) => {
    const first = core[0]!;
    const last = core.at(-1)!;
    const firstSectionIndex = sections.findIndex((section) => section.id === first.id);
    const context = index === 0 ? undefined : sections[firstSectionIndex - 1];
    return {
      id: `analysis_segment:${source.id}:${String(index + 1).padStart(4, "0")}`,
      sourceId: source.id,
      sectionIds: core.map((section) => section.id),
      coreStart: first.start,
      coreEnd: last.end,
      contextStart: context?.start ?? first.start,
      contextEnd: last.end,
    };
  });
}
```

`validateAndSortSections` must reject non-empty-range, outside-Source, duplicate-ID, overlapping, or non-increasing sections. `groupCoreSections` must keep adding complete Sections while the current range is below 6k; once at least 6k, it must stop before a next Section would take the range over 10k. A Section or forced group may exceed 10k only because the Section-boundary rule prevents a legal smaller group.

- [ ] **Step 4: Run the focused tests and verify GREEN**

```bash
npm test -- tests/unit/analysis-segments.test.ts tests/unit/source-import.test.ts
```

Expected: both files PASS; Source offsets and existing import behavior remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/domain/source/analysis-segments.ts tests/unit/analysis-segments.test.ts
git commit -m "功能：确定性派生故事分析分段"
```

---

### Task 2: Replace model candidate Evidence with local exact claims

**Files:**

- Modify: `tests/unit/story-map-candidate.test.ts`
- Modify: `src/domain/schemas/story-map.ts`
- Modify: `src/domain/source/resolve-story-map-evidence.ts`
- Delete: `src/domain/source/evidence-units.ts`
- Delete: `tests/unit/evidence-units.test.ts`

- [ ] **Step 1: Write failing local and global candidate tests**

Define synthetic candidates that express the intended two internal schemas:

```ts
const local = StoryMapLocalExtractionCandidateSchema.parse({
  characters: [{
    localId: "character_local_1",
    name: "甲",
    aliases: [],
    role: "protagonist",
    initialState: "等待出发",
  }],
  events: [{
    localId: "event_local_1",
    title: "甲作出选择",
    summary: "甲决定离开。",
    sequence: 1,
    participants: ["character_local_1"],
    stateChanges: ["甲开始行动"],
    evidenceKind: "fact",
    evidence: [{ sectionId: "section_02", exactQuote: "甲决定离开。" }],
  }],
  edges: [],
});

const resolved = resolveLocalStoryMapCandidate({ local, source, segment });
expect(resolved.success).toBe(true);
if (!resolved.success) return;
expect(resolved.candidate.events[0]!.evidenceReferenceIds).toHaveLength(1);
expect(resolved.references[0]!.reference).toMatchObject({
  sourceId: source.id,
  sectionId: "section_02",
  start: source.sections[1]!.start,
});
```

Add independent tests proving:

- an unknown Section fails;
- a quote absent from the Section fails;
- a quote occurring twice in one Section fails;
- duplicate Evidence references fail rather than dedupe;
- the first Event Evidence outside core fails even if it is in context;
- a boundary Event with first Evidence in core and supplemental Evidence in the preceding context succeeds;
- scalar `stateChanges` and scalar `participants` remain rejected without coercion;
- duplicate local Character/Event/Edge IDs and local dangling references fail;
- final `StoryMapReconciliationCandidateSchema` resolves known `evidenceReferenceIds` into unchanged `SourceReference[]` and rejects unknown/duplicate/cross-Source IDs.

- [ ] **Step 2: Run and verify RED**

```bash
npm test -- tests/unit/story-map-candidate.test.ts
```

Expected: FAIL because local exact-quote schemas and resolver functions are absent and the old candidate only accepts `evidenceUnitIds`.

- [ ] **Step 3: Introduce explicit local and reconciled schemas**

In `story-map.ts`, keep final schemas byte-for-byte compatible and replace only candidate exports:

```ts
export const EvidenceClaimSchema = z.object({
  sectionId: z.string().min(1),
  exactQuote: z.string().min(1),
}).strict();

export const StoryMapLocalExtractionCandidateSchema = z.object({
  characters: z.array(LocalCharacterCandidateSchema),
  events: z.array(LocalEventCandidateSchema),
  edges: z.array(LocalStoryEdgeCandidateSchema),
}).strict();

export const StoryMapReconciliationCandidateSchema = z.object({
  title: z.string().min(1),
  logline: z.string().min(1),
  characters: z.array(CharacterSchema).min(1),
  events: z.array(ReconciledEventCandidateSchema).min(1),
  edges: z.array(ReconciledStoryEdgeCandidateSchema),
  endingCandidates: z.array(ReconciledEndingCandidateSchema).min(1),
}).strict();
```

Local candidates use `localId`; reconciled candidates use the existing final `id` fields plus `evidenceReferenceIds: string[]`. Inference confidence and strict object validation remain identical to final Event behavior.

- [ ] **Step 4: Implement exact resolution and temporary reference ownership**

Replace Unit resolution with:

```ts
export type TemporaryEvidenceReference = {
  id: string;
  reference: SourceReference;
};

export function temporaryEvidenceReferenceId(reference: SourceReference): string {
  return [
    "evidence_ref",
    reference.sourceId,
    reference.sectionId,
    reference.start,
    reference.end,
  ].join(":");
}

export function resolveEvidenceClaim(
  claim: EvidenceClaim,
  source: Source,
  allowedSectionIds: Set<string>,
  path: string,
): EvidenceClaimResolution {
  const section = source.sections.find((item) => item.id === claim.sectionId);
  if (!section || !allowedSectionIds.has(section.id)) {
    return {
      success: false,
      issue: { path: `${path}.sectionId`, message: "Evidence 引用了当前 Segment 之外的 Section" },
    };
  }
  const sectionText = source.normalizedText.slice(section.start, section.end);
  const firstIndex = sectionText.indexOf(claim.exactQuote);
  if (firstIndex < 0) {
    return {
      success: false,
      issue: { path: `${path}.exactQuote`, message: "Evidence 摘录未在声明的 Section 中找到" },
    };
  }
  if (sectionText.indexOf(claim.exactQuote, firstIndex + 1) >= 0) {
    return {
      success: false,
      issue: { path: `${path}.exactQuote`, message: "Evidence 摘录在声明的 Section 中不唯一" },
    };
  }
  const start = section.start + firstIndex;
  const end = start + claim.exactQuote.length;
  return {
    success: true,
    reference: SourceReferenceSchema.parse({
      sourceId: source.id,
      sectionId: section.id,
      start,
      end,
      excerptHash: sha256(source.normalizedText.slice(start, end)),
    }),
  };
}
```

`resolveLocalStoryMapCandidate` must validate local references, namespace every local ID with the Segment ID before global use, remove every `exactQuote` from the returned candidate, enforce first-Evidence core ownership, and return a deduplicated registry of temporary reference objects. `resolveReconciledStoryMapCandidate` must map only registry IDs belonging to the current Source into `StoryMapContentSchema`; it must not search Source text again.

Implement `dedupeResolvedSegmentCandidates` with these exact keys:

```ts
const eventKey = [
  event.evidenceReferenceIds[0],
  event.title.normalize("NFC").replace(/\s+/gu, "").toLocaleLowerCase(),
].join("|");
const edgeKey = [
  remappedFrom,
  remappedTo,
  edge.type,
  [...edge.evidenceReferenceIds].sort().join(","),
].join("|");
```

When an Event is removed, remap Edge endpoints to the retained Event before Edge dedupe. Never merge Characters by fuzzy name similarity.

- [ ] **Step 5: Delete the obsolete Evidence Unit path and verify GREEN**

After all imports use the new schemas/resolvers, delete `evidence-units.ts` and its test. Run:

```bash
npm test -- tests/unit/story-map-candidate.test.ts tests/unit/domain-schemas.test.ts tests/unit/story-map-invariants.test.ts
```

Expected: PASS with no `evidenceUnitIds` production export or caller.

- [ ] **Step 6: Commit**

```bash
git add src/domain/schemas/story-map.ts src/domain/source/resolve-story-map-evidence.ts tests/unit/story-map-candidate.test.ts
git add -u src/domain/source/evidence-units.ts tests/unit/evidence-units.test.ts
git commit -m "功能：解析分段候选的精确证据"
```

---

### Task 3: Build Segment and body-free Reconcile packets

**Files:**

- Create: `src/server/story-map/story-map-packets.ts`
- Create: `prompts/story-map.v3.md`
- Create: `prompts/story-map-reconcile.v3.md`
- Modify: `tests/unit/story-map-generation.test.ts`

- [ ] **Step 1: Write failing packet/privacy tests**

Add assertions using a synthetic source sentinel that is outside the selected Segment and another sentinel that appears only inside a local exact quote:

```ts
const localPacket = buildAnalysisSegmentPacket(source, segment);
expect(localPacket).toContain(`<analysis_segment id="${segment.id}"`);
expect(localPacket).toContain('ownership="core"');
expect(localPacket).toContain('ownership="context"');
expect(localPacket).not.toContain("OUTSIDE_SEGMENT_SENTINEL");

const globalPacket = buildGlobalReconcilePacket({
  source,
  segments: resolvedSegments,
  references,
});
expect(globalPacket).toContain("evidenceReferenceIds");
expect(globalPacket).not.toContain("LOCAL_EXACT_QUOTE_SENTINEL");
expect(globalPacket).not.toContain("<normalized_text>");
```

Read both v3 Prompt files in the test and assert the local Prompt requires `exactQuote`, core ownership, `participants:string[]`, `stateChanges:string[]`, and no formal IDs; assert the global Prompt requires alias merge, event dedupe, global chronology, cross-segment edges, Ending Candidates, and temporary evidence reference IDs without Source text.

- [ ] **Step 2: Run and verify RED**

```bash
npm test -- tests/unit/story-map-generation.test.ts
```

Expected: FAIL because the packet module and v3 Prompt files do not exist.

- [ ] **Step 3: Implement focused packet builders**

```ts
export function buildAnalysisSegmentPacket(
  source: Source,
  segment: AnalysisSegment,
): string {
  const sections = source.sections
    .filter((section) => section.start >= segment.contextStart && section.end <= segment.contextEnd)
    .map((section) => ({
      id: section.id,
      title: section.title,
      ownership: segment.sectionIds.includes(section.id) ? "core" : "context",
      text: source.normalizedText.slice(section.start, section.end),
    }));
  return [
    `<analysis_segment id="${segment.id}" sourceId="${source.id}" coreStart="${segment.coreStart}" coreEnd="${segment.coreEnd}">`,
    JSON.stringify(sections),
    "</analysis_segment>",
  ].join("\n");
}
```

`buildGlobalReconcilePacket` must serialize only Segment IDs/core ranges, names/summaries/state changes/local relationships, Section index metadata, and temporary reference `id/sourceId/sectionId/start/end/excerptHash`. It must never accept `normalizedText` or `exactQuote` as an argument.

- [ ] **Step 4: Write the v3 Prompt contracts**

The local Prompt must include one synthetic minimal JSON example with `localId`, array fields, and `{sectionId, exactQuote}` Evidence. The Reconciler Prompt must include one synthetic minimal JSON example with final IDs and `evidenceReferenceIds`. Neither Prompt may include real Benchmark data, Golden labels, Provider-specific fallback, or a second path for short Sources.

- [ ] **Step 5: Verify GREEN**

```bash
npm test -- tests/unit/story-map-generation.test.ts
```

Expected: packet/privacy and Prompt contract tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/story-map/story-map-packets.ts prompts/story-map.v3.md prompts/story-map-reconcile.v3.md tests/unit/story-map-generation.test.ts
git commit -m "功能：建立分段与全局对账数据包"
```

---

### Task 4: Replace production generation with one section-first pipeline

**Files:**

- Modify: `tests/unit/story-map-generation.test.ts`
- Modify: `src/server/story-map/generate-story-map.ts`
- Modify: `src/server/story-map/generate-configured-story-map.ts`

- [ ] **Step 1: Write failing one/multi Segment orchestration tests**

For one Segment, queue one local candidate and one reconciled candidate and assert two calls, v3 Prompt versions, final validity, Source immutability, and one Artifact. For multiple Segments, queue one response per Segment plus one reconciliation and assert:

```ts
expect(result.generation.extractorRunIds).toHaveLength(segments.length);
expect(result.generation.analysisSegmentCount).toBe(segments.length);
expect(provider.requests).toHaveLength(segments.length + 1);
expect(provider.requests.at(-1)!.prompt).not.toContain(source.normalizedText);
expect(result.artifact.storyMap.characters).toHaveLength(expectedCharacterCount);
expect(result.artifact.storyMap.edges).toContainEqual(
  expect.objectContaining({ from: "event_first", to: "event_later", type: "causes" }),
);
```

The two local candidates must use different aliases/local IDs for one person; the global fixture response must merge them into one final Character. The global response must also add a cross-segment causal Edge.

- [ ] **Step 2: Write failing concurrency and rollback tests**

Create an `AIProvider` whose local calls increment `active` before awaiting a test-controlled Promise and decrement afterward. Assert `maxActive === 2`, never 3. Add a failure test where one Segment initial and repair both fail Schema/Evidence validation:

```ts
await expect(generateStoryMap(input)).rejects.toThrow(
  "Structured generation failed schema validation",
);
expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([]);
expect(provider.requests.filter((request) => request.schemaName === "story_map_reconcile")).toHaveLength(0);
expect(listProjectGenerationRuns(project.id)).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ kind: expect.stringMatching(/^story_map_extract:/), status: "failed" }),
  ]),
);
```

Also assert a local or global stage makes at most two requests, and final Evidence offsets/hash still equal the immutable Source slice.

- [ ] **Step 3: Run and verify RED**

```bash
npm test -- tests/unit/story-map-generation.test.ts tests/contract/structured-generation.contract.test.ts
```

Expected: FAIL because production still performs one full-book Extractor call, one full-book Reconciler call, and emits v2 Unit-ID packets.

- [ ] **Step 4: Implement pairwise local extraction and global reconcile**

Use one orchestration path:

```ts
const segments = deriveAnalysisSegments(source);
const localResults = await mapInPairs(segments, async (segment) => {
  const generation = await generateStructured({
    projectId: input.projectId,
    worldlineId: null,
    kind: `story_map_extract:${segment.id}`,
    promptVersion: "story-map.v3",
    prompt: `${extractorTemplate}\n\n${buildAnalysisSegmentPacket(source, segment)}`,
    schemaName: "story_map_segment",
    schema: StoryMapLocalExtractionCandidateSchema,
    modelConfig: input.modelConfig,
    validate: (candidate) => validateLocalStoryMapCandidate(candidate, source, segment),
  }, input.provider);
  const resolved = resolveLocalStoryMapCandidate({
    local: generation.value,
    source,
    segment,
  });
  if (!resolved.success) throw new Error("Validated local candidate could not be resolved");
  return { segment, generation: generation.generation, ...resolved };
});
```

`mapInPairs` must iterate `index += 2` and await `Promise.all(values.slice(index, index + 2).map(worker))`; do not create a queue abstraction. Merge registries, positionally dedupe candidates, build the global packet, call `generateStructured` once with `kind: "story_map_reconcile"`, `promptVersion: "story-map-reconcile.v3"`, and the reconciled candidate schema/validator, then create the Artifact only after final resolution.

- [ ] **Step 5: Migrate deterministic Mock fixture generation**

`createFixtureMockProvider` must derive the same Segments, convert each fixture SourceReference into a Section-local exact quote, emit only Events whose first Evidence lies in that Segment core, include referenced Characters and in-Segment Edges, then emit one final reconciliation response using `temporaryEvidenceReferenceId`. It must not branch on Source length or call the old Unit helper.

- [ ] **Step 6: Verify GREEN and regressions**

```bash
npm test -- tests/unit/story-map-generation.test.ts tests/unit/story-map-artifact.test.ts tests/contract/structured-generation.contract.test.ts
```

Expected: all PASS, including one/multi Segment, boundary ownership, alias merge fixture, cross-segment Edge, concurrency two, one repair, failure rollback, immutable Source, and revision creation.

- [ ] **Step 7: Commit**

```bash
git add src/server/story-map/generate-story-map.ts src/server/story-map/generate-configured-story-map.ts tests/unit/story-map-generation.test.ts
git commit -m "功能：统一 Story Map 分段提取管线"
```

---

### Task 5: Extend the existing M1 baseline with Segment observability

**Files:**

- Modify: `tests/unit/m1-baseline.test.ts`
- Modify: `src/evals/m1-baseline.ts`
- Modify: `scripts/eval-m1-baseline.ts`

- [ ] **Step 1: Write failing metrics and privacy tests**

Add a sanitized Segment summary contract:

```ts
expect(
  summarizeAnalysisSegments({ segments, runs }),
).toEqual({
  count: 2,
  items: [
    {
      segmentId: "analysis_segment:source_test:0001",
      coreCharacters: 8_000,
      contextCharacters: 8_000,
      status: "succeeded",
      firstPassValidation: "passed",
      repair: "not_needed",
    },
    {
      segmentId: "analysis_segment:source_test:0002",
      coreCharacters: 8_000,
      contextCharacters: 12_000,
      status: "succeeded",
      firstPassValidation: "failed",
      repair: "succeeded",
    },
  ],
});
```

Test aggregate Extractor validation across multiple runs, a failed Segment, and a Reconciler that does not run. Update the report fixture to `kind: "m1_story_map_baseline"` and assert serialized output excludes a private title, exact quote, Source body, Prompt, and raw model output while retaining provider/model/mode/tokens/duration/Artifact/Segment counts.

- [ ] **Step 2: Run and verify RED**

```bash
npm test -- tests/unit/m1-baseline.test.ts
```

Expected: FAIL because report schema has no Segment summary and validation only considers the first Extractor run.

- [ ] **Step 3: Implement sanitized aggregation**

Extend `ValidationRunObservation` with a derived `attemptCount: 0 | 1 | 2`, computed from the existing Generation Run attempt envelope without returning raw content. Treat run kinds beginning with `story_map_extract:` as Extractor runs. The aggregate Extractor stage rules are:

- no local run/call: `not_run/not_run`;
- every local run succeeded with one attempt: `passed/not_needed`;
- every local run succeeded and at least one used two attempts: `failed/succeeded`;
- any local run failed after two attempts: `failed/failed`;
- Provider failed before validation: `not_observed/not_run` or `failed/failed` according to observed repair.

Add `analysisSegments` to each story report and derive it from the pure segmenter plus Generation Runs. Normalize prompt-version reporting so all `story_map_extract:<segmentId>` runs produce one `{kind:"story_map_extract", version:"story-map.v3"}` entry.

- [ ] **Step 4: Verify GREEN**

```bash
npm test -- tests/unit/m1-baseline.test.ts tests/unit/story-map-generation.test.ts
```

Expected: both files PASS, with no private body or raw output in JSON/terminal summaries.

- [ ] **Step 5: Commit**

```bash
git add src/evals/m1-baseline.ts scripts/eval-m1-baseline.ts tests/unit/m1-baseline.test.ts
git commit -m "评测：记录 M1 分段提取指标"
```

---

### Task 6: Record the decision and align authoritative docs

**Files:**

- Create: `docs/decisions/0005-m1-section-first-extraction.md`
- Modify: `README.md`
- Modify: `docs/domain.md`
- Modify: `docs/evals.md`

- [ ] **Step 1: Write the accepted decision**

The decision file must contain only:

- M1-02 evidence and the unified data flow;
- AnalysisSegment ownership and no-table choice;
- exact local claim → temporary reference → unchanged final SourceReference;
- failure/repair/concurrency boundaries;
- LangExtract official repository/license/release/maintenance/dependency/privacy preflight;
- decision not to add Python, LangExtract, dependencies, RAG, vectors, agents, queue, fuzzy grounding, or a dual path.

It must link to `docs/mvp.md`, `docs/evals.md`, the M1-02 decision report, and the detailed design instead of copying M1 quality thresholds.

- [ ] **Step 2: Update current behavior statements**

Replace README/domain/evals statements that claim the production model returns Evidence Unit IDs. State that v3 local candidates return exact quotes inside one AnalysisSegment; the service resolves exact unique Section matches and core ownership; the global stage only uses temporary references and Section metadata; final `SourceReference[]` and existing Artifacts remain unchanged. Preserve M0/v0.1.0 historical text and all older reports.

- [ ] **Step 3: Check documentation consistency**

```bash
rg -n "当前|生产|M1-03|Evidence Unit|evidenceUnitIds|story-map\.v2|story-map\.v3|SECTION-FIRST" README.md docs AGENTS.md
git diff --check
```

Expected: v2/Evidence Unit references remain only in explicitly historical M1-02A records and historical Prompt files; current sections point to v3 section-first behavior; no whitespace errors.

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/0005-m1-section-first-extraction.md README.md docs/domain.md docs/evals.md
git commit -m "决策：记录 M1 统一分段提取"
```

---

### Task 7: Run all deterministic gates and inspect the complete diff

**Files:**

- Modify only files required to fix observed failures; every production fix requires a failing regression test first.

- [ ] **Step 1: Run focused candidate and pipeline tests**

```bash
npm test -- tests/unit/analysis-segments.test.ts tests/unit/story-map-candidate.test.ts tests/unit/story-map-generation.test.ts tests/unit/m1-baseline.test.ts tests/contract/structured-generation.contract.test.ts
```

Expected: all focused files PASS.

- [ ] **Step 2: Run every required deterministic gate in order**

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm test
npm run build
CI=1 npm run test:e2e
```

Expected: every command exits 0. Record exact file/test counts for the final report.

- [ ] **Step 3: Inspect scope and privacy**

```bash
git status --short
git diff --stat main...HEAD
git diff --check main...HEAD
git diff main...HEAD -- package.json package-lock.json drizzle src/server/db/schema.ts
rg -n "benchmarks/private|OPENAI_API_KEY|exactQuote.*(private|Story [ABC])" --glob '!docs/evals/runs/*' .
```

Expected: no dependency, lockfile, migration, DB schema, private Benchmark, key, or real-text change; no generated `.data` tracked; only M1-03 files are modified.

- [ ] **Step 4: Commit any test-only cleanup**

If the previous verification required a scoped fix, commit only its files with a Chinese single-intent message. If no changes remain, do not create an empty commit.

---

### Task 8: Integrate, run the frozen A/B/C regression, and retain only proven architecture

**Files:**

- Create after data exists: `docs/evals/runs/m1-03-section-first-2026-08-13.md`
- Modify if the real run proves failure: use a traceable `git revert` commit for M1-03 production commits; do not reset or overwrite history.

- [ ] **Step 1: Push the verified feature branch**

```bash
git push -u origin agent/m1-03-section-first
```

Expected: remote branch points to the fully verified deterministic implementation.

- [ ] **Step 2: Fast-forward main and re-run deterministic gates on the integrated tree**

From the clean main worktree:

```bash
git merge --ff-only agent/m1-03-section-first
git push origin main
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm test
npm run build
CI=1 npm run test:e2e
```

Expected: main remains linear and every required gate exits 0 before private evaluation.

- [ ] **Step 3: Run the unchanged private Benchmark command on main**

Use the already configured `.env.local` without reading or printing it:

```bash
npm run eval:m1:baseline -- \
  --manifest benchmarks/private/m1-a-zhuanzhengqi/manifest.json \
  --manifest benchmarks/private/m1-b-chunsheng/manifest.json \
  --manifest benchmarks/private/m1-c-wudu/manifest.json
```

Expected: a new Git-ignored `.data/evals/m1-baseline/<run-id>/metrics.json` and `eval.db`; terminal output contains only story IDs/classes, structured-output mode, validation status, Evidence rate, Artifact flag, tokens, duration, and paths—not titles or text.

- [ ] **Step 4: Compare against the frozen M1-02 facts without exposing private content**

Read only the sanitized new `metrics.json`, existing sanitized M1-02 metrics/report, and ID-only human queues. Record per Story:

- Segment count and local/global first-pass/repair;
- Artifact creation and Evidence validity;
- core Character recall and identity precision/recall/F1;
- Event/Edge/Ending candidate counts and stable-ID manual queue status;
- input/output/total tokens and wall-clock;
- correction-cost fields, using `not measured` when no reliable active review time exists.

Do not print or copy Source, exact quotes, titles, character names, event summaries, raw model output, Prompt, `.env.local`, or keys.

- [ ] **Step 5: Apply the retention gate**

Retain the implementation only when all three Artifacts exist, Evidence remains 100%, no valid-Evidence Event count remains zero, and the frozen real failure is materially improved—preferably Story B core Character recall reaches 100%, with identity micro-F1 reaching or approaching 90% and no known erroneous core merge. Event/Ending improvements require stable-ID manual one-to-one review; candidate count alone is not recall.

If the run has no material quality improvement, Evidence regresses, any story fails, or measured correction cost clearly rises, create the sanitized FAIL report, then revert the M1-03 production commits on main with `git revert` and rerun every deterministic gate. Do not keep the architecture merely because it was implemented.

- [ ] **Step 6: Create and commit the sanitized M1-03 report**

The report must record commit SHA, run-id, provider/model/mode, v3 Prompt versions, Segment counts, validation/repair, Evidence, automatic character metrics, manual queue status, token/latency comparison, correction-cost evidence, deterministic gates, new dependency `none`, privacy statement, and exactly one final conclusion: `M1-03 PASS` or `M1-03 FAIL`.

```bash
git add docs/evals/runs/m1-03-section-first-2026-08-13.md
git commit -m "评测：记录 M1-03 真实作品回归"
git push origin main
```

- [ ] **Step 7: Stop**

Report the actual result and stop. Do not begin the next M1 Issue.
