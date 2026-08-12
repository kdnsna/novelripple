# M1-02A Provider & Evidence Grounding Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. NovelRipple explicitly forbids multi-Agent execution for this Issue.

**Goal:** Make the existing `deepseek-chat` production pipeline produce locally verifiable Story Map candidates through explicit `json_object` output and deterministic Source-scoped Evidence Unit references without weakening any final domain contract.

**Architecture:** Extend the existing single OpenAI-compatible Provider with an explicit third output mode; derive non-persistent Evidence Units from immutable Source sections; replace quote-based model candidate evidence with Source-scoped Unit IDs; resolve those IDs into the unchanged `SourceReference[]` before existing Story Map validation and persistence. Preserve the single Extractor → Reconciler path, one-repair budget, existing Artifact schemas, and fail-closed semantics.

**Tech Stack:** TypeScript 5.9, Zod 4, OpenAI Node SDK 7, Vitest 4, SQLite/Drizzle, Next.js 16, Playwright.

**Design:** [M1-02A design](../specs/2026-08-12-m1-02a-provider-evidence-compatibility-design.md)

---

## File map

**Create:**

- `src/domain/source/evidence-units.ts` — deterministic Evidence Unit derivation and Unit-to-SourceReference conversion.
- `tests/unit/evidence-units.test.ts` — paragraph, offset, ID and fail-closed tests.
- `tests/unit/configured-runtime.test.ts` — explicit output-mode configuration.
- `prompts/story-map.v2.md` and `prompts/story-map-reconcile.v2.md` — Unit-ID contracts and synthetic JSON examples.
- `docs/evals/runs/2026-08-12-m1-02a-provider-evidence-compatibility.md` — sanitized real-run result.

**Modify:**

- Provider: `src/server/ai/types.ts`, `configured-runtime.ts`, `generate-structured.ts`, `openai-compatible-provider.ts` and Provider tests.
- Candidate/Evidence: `src/domain/schemas/story-map.ts`, `src/domain/source/resolve-story-map-evidence.ts` and candidate tests.
- Pipeline: `src/server/story-map/generate-story-map.ts`, `generate-configured-story-map.ts` and generation tests.
- Eval: `src/evals/m1-baseline.ts`, `scripts/eval-m1-baseline.ts` and baseline tests.
- Docs: `.env.example`, `README.md`, `docs/decisions/0002-openai-compatible-boundary.md`, `docs/evals.md`.

**Must not change:** final `SourceReferenceSchema`, final Story Map schemas, database/migrations, v1 Prompt files, Ripple, Worldline, Impact Plan, Continuation, private Benchmark tracking, repair count, dependencies.

---

### Task 1: Add explicit `json_object` Provider mode

**Files:**

- Create: `tests/unit/configured-runtime.test.ts`
- Modify: `tests/unit/openai-compatible-provider.test.ts`
- Modify: `src/server/ai/types.ts`
- Modify: `src/server/ai/configured-runtime.ts`
- Modify: `src/server/ai/generate-structured.ts`
- Modify: `src/server/ai/openai-compatible-provider.ts`

- [ ] **Step 1: Write failing tests**

Extend the request helper union to `"json_schema" | "json_object" | "prompt_json"` and add:

```ts
it("uses explicit json_object mode without schema fallback", async () => {
  const { client, calls } = createFakeClient();
  const provider = new OpenAICompatibleProvider({
    providerName: "deepseek-compatible",
    apiKey: "test-key",
    client,
  });

  await provider.generate(request("json_object"));

  expect(calls).toEqual([
    expect.objectContaining({
      model: "compatible-model",
      response_format: { type: "json_object" },
    }),
  ]);
  expect(JSON.stringify(calls)).not.toContain('"json_schema"');
});
```

Create runtime tests that set and restore environment variables:

```ts
it("accepts json_object only when explicitly configured", () => {
  process.env.AI_PROVIDER_NAME = "openai-compatible";
  process.env.OPENAI_MODEL = "deepseek-chat";
  process.env.OPENAI_STRUCTURED_OUTPUT_MODE = "json_object";
  expect(readConfiguredAI().modelConfig.structuredOutputMode).toBe("json_object");
});

it("rejects automatic mode instead of detecting or falling back", () => {
  process.env.OPENAI_STRUCTURED_OUTPUT_MODE = "automatic";
  expect(() => readConfiguredAI()).toThrow();
});
```

- [ ] **Step 2: Verify RED**

```bash
npm test -- tests/unit/openai-compatible-provider.test.ts tests/unit/configured-runtime.test.ts
```

Expected: FAIL because `json_object` is absent from types/Zod and no matching request branch exists.

- [ ] **Step 3: Implement the minimum mode**

Use one union everywhere:

```ts
export type StructuredOutputMode =
  | "json_schema"
  | "json_object"
  | "prompt_json";
```

Update runtime Zod enums to the same three values. Extend the Chat request type with `{ type: "json_object" }` and construct:

```ts
const responseFormat =
  modelConfig.structuredOutputMode === "json_schema"
    ? {
        type: "json_schema" as const,
        json_schema: {
          name: request.schemaName,
          strict: true as const,
          schema: request.jsonSchema,
        },
      }
    : modelConfig.structuredOutputMode === "json_object"
      ? { type: "json_object" as const }
      : undefined;
```

Pass `response_format` only when defined. Do not branch on Provider name, catch unsupported-format errors, mutate the mode, or retry with another mode.

- [ ] **Step 4: Verify GREEN and one-repair regression**

```bash
npm test -- tests/unit/openai-compatible-provider.test.ts tests/unit/configured-runtime.test.ts tests/unit/structured-generation.test.ts tests/contract/structured-generation.contract.test.ts
```

Expected: PASS, including existing strict `json_schema` wire shape, no `response_format` for `prompt_json`, and exactly two attempts maximum.

- [ ] **Step 5: Commit**

```bash
git add src/server/ai/types.ts src/server/ai/configured-runtime.ts src/server/ai/generate-structured.ts src/server/ai/openai-compatible-provider.ts tests/unit/configured-runtime.test.ts tests/unit/openai-compatible-provider.test.ts
git commit -m "功能：增加显式 json_object 输出模式"
```

---

### Task 2: Derive Source-scoped Evidence Units

**Files:**

- Create: `src/domain/source/evidence-units.ts`
- Create: `tests/unit/evidence-units.test.ts`

- [ ] **Step 1: Write failing derivation tests**

Build synthetic Sources with blank-line paragraphs, two Sections and a surrogate pair. Assert:

```ts
const firstParagraph = "甲🌊段。";
const secondParagraph = "第二段。";
const normalizedText = firstParagraph + "\n\n" + secondParagraph;
const secondStart = firstParagraph.length + 2;
const source = SourceSchema.parse({
  id: "source_alpha",
  projectId: "project_test",
  title: "合成测试",
  originalText: normalizedText,
  normalizedText,
  contentHash: sha256(normalizedText),
  sections: [
    {
      id: "section_01",
      title: "正文",
      start: 0,
      end: normalizedText.length,
    },
  ],
  createdAt: "2026-08-12T00:00:00.000Z",
});

expect(deriveEvidenceUnits(source)).toEqual([
  {
    id: "evidence_unit:source_alpha:000001",
    sourceId: "source_alpha",
    sectionId: "section_01",
    start: 0,
    end: firstParagraph.length,
    text: firstParagraph,
  },
  {
    id: "evidence_unit:source_alpha:000002",
    sourceId: "source_alpha",
    sectionId: "section_01",
    start: secondStart,
    end: secondStart + secondParagraph.length,
    text: secondParagraph,
  },
]);
expect(deriveEvidenceUnits(source)).toEqual(deriveEvidenceUnits(source));
```

Calculate expected offsets using JavaScript string lengths so the test explicitly proves UTF-16 behavior. Add an assertion that global ordinal order continues across Section boundaries and only block-edge whitespace is removed.

- [ ] **Step 2: Verify RED**

```bash
npm test -- tests/unit/evidence-units.test.ts
```

Expected: FAIL because `EvidenceUnit` and `deriveEvidenceUnits` do not exist.

- [ ] **Step 3: Implement pure derivation**

```ts
export type EvidenceUnit = {
  id: string;
  sourceId: string;
  sectionId: string;
  start: number;
  end: number;
  text: string;
};

export function deriveEvidenceUnits(source: Source): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  const sections = [...source.sections].sort((a, b) => a.start - b.start);

  for (const section of sections) {
    const sectionText = source.normalizedText.slice(section.start, section.end);
    let blockStart = 0;
    const boundaries = [...sectionText.matchAll(/\n[ \t]*\n+/g)];

    for (const boundary of [...boundaries, undefined]) {
      const blockEnd = boundary?.index ?? sectionText.length;
      const block = sectionText.slice(blockStart, blockEnd);
      const first = block.search(/\S/u);
      if (first >= 0) {
        const trailing = block.match(/\s*$/u)?.[0].length ?? 0;
        const start = section.start + blockStart + first;
        const end = section.start + blockEnd - trailing;
        units.push({
          id: "evidence_unit:" + source.id + ":" +
            String(units.length + 1).padStart(6, "0"),
          sourceId: source.id,
          sectionId: section.id,
          start,
          end,
          text: source.normalizedText.slice(start, end),
        });
      }
      if (boundary) blockStart = boundary.index + boundary[0].length;
    }
  }
  return units;
}
```

Do not persist Units or add them to `SourceSchema`.

- [ ] **Step 4: Verify GREEN**

```bash
npm test -- tests/unit/evidence-units.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/domain/source/evidence-units.ts tests/unit/evidence-units.test.ts
git commit -m "功能：从 Source 确定性派生证据单元"
```

---

### Task 3: Replace quote candidates with Unit IDs end to end

**Files:**

- Create: `prompts/story-map.v2.md`
- Create: `prompts/story-map-reconcile.v2.md`
- Modify: `src/domain/schemas/story-map.ts`
- Modify: `src/domain/source/evidence-units.ts`
- Modify: `src/domain/source/resolve-story-map-evidence.ts`
- Modify: `src/server/story-map/generate-story-map.ts`
- Modify: `src/server/story-map/generate-configured-story-map.ts`
- Modify: `tests/unit/story-map-candidate.test.ts`
- Modify: `tests/unit/story-map-generation.test.ts`

- [ ] **Step 1: Rewrite candidate and pipeline tests before implementation**

Create candidates with `evidenceUnitIds` using explicit test helpers:

```ts
function unitIdsForReference(
  reference: SourceReference,
  units: EvidenceUnit[],
): string[] {
  return units
    .filter((unit) => unit.start <= reference.start && unit.end >= reference.end)
    .map((unit) => unit.id);
}

function candidateFromStoryMap(storyMap: StoryMap, units: EvidenceUnit[]) {
  const withUnits = <T extends { evidence: SourceReference[] }>(value: T) => {
    const { evidence, ...rest } = value;
    return {
      ...rest,
      evidenceUnitIds: evidence.flatMap((reference) =>
        unitIdsForReference(reference, units),
      ),
    };
  };
  return StoryMapContentCandidateSchema.parse({
    title: storyMap.title,
    logline: storyMap.logline,
    characters: storyMap.characters,
    events: storyMap.events.map(withUnits),
    edges: storyMap.edges.map(withUnits),
    endingCandidates: storyMap.endingCandidates.map(withUnits),
  });
}

function collectReferences(content: StoryMapContent): SourceReference[] {
  return [
    ...content.events.flatMap((event) => event.evidence),
    ...content.edges.flatMap((edge) => edge.evidence),
    ...content.endingCandidates.flatMap((ending) => ending.evidence),
  ];
}

it("resolves unit IDs into server-owned SourceReferences", async () => {
  const { source, storyMap } = await loadRippleFixture();
  const units = deriveEvidenceUnits(source);
  const candidate = candidateFromStoryMap(storyMap, units);
  const resolved = resolveStoryMapContentCandidate(candidate, source, units);
  expect(resolved.success).toBe(true);
  if (!resolved.success) return;
  for (const reference of collectReferences(resolved.content)) {
    expect(reference.sourceId).toBe(source.id);
    expect(reference.excerptHash).toBe(
      sha256(source.normalizedText.slice(reference.start, reference.end)),
    );
  }
});

it("rejects unknown, duplicate and other-Source unit IDs", async () => {
  const { source } = await loadRippleFixture();
  const sourceUnits = deriveEvidenceUnits(source);
  const otherUnits = deriveEvidenceUnits({
    ...source,
    id: "source_other",
  });
  expect(resolveEvidenceUnitIds(["unknown"], sourceUnits, "events.0")).toMatchObject({ success: false });
  expect(resolveEvidenceUnitIds([sourceUnits[0]!.id, sourceUnits[0]!.id], sourceUnits, "events.0")).toMatchObject({ success: false });
  expect(resolveEvidenceUnitIds([otherUnits[0]!.id], sourceUnits, "events.0")).toMatchObject({ success: false });
});

it("rejects stateChanges string without coercion", async () => {
  const { source, storyMap } = await loadRippleFixture();
  const units = deriveEvidenceUnits(source);
  const content = candidateFromStoryMap(storyMap, units);
  const { endingCandidates: _endingCandidates, ...validExtraction } = content;
  const invalidScalar = {
    ...validExtraction,
    events: [
      { ...validExtraction.events[0], stateChanges: "changed" },
      ...validExtraction.events.slice(1),
    ],
  };
  expect(() => StoryMapExtractionCandidateSchema.parse(invalidScalar)).toThrow();
});
```

Update generation expectations to Prompt v2, `<evidence_units>`, Source-scoped Unit IDs, valid Artifact, and no candidate `exactQuote` key.

- [ ] **Step 2: Verify RED**

```bash
npm test -- tests/unit/story-map-candidate.test.ts tests/unit/story-map-generation.test.ts
```

Expected: FAIL because candidates still require quote claims and the pipeline still uses v1/raw text.

- [ ] **Step 3: Change only candidate schemas**

```ts
const candidateEvidenceShape = {
  evidenceUnitIds: z.array(z.string().min(1)).min(1),
};

export const StoryMapCandidateEventSchema = z
  .object({ ...eventShape, ...candidateEvidenceShape })
  .strict()
  .superRefine(requireInferenceConfidence);

export const StoryMapCandidateEdgeSchema = z
  .object({ ...storyEdgeShape, ...candidateEvidenceShape })
  .strict();

export const StoryMapCandidateEndingSchema = z
  .object({ ...endingCandidateShape, ...candidateEvidenceShape })
  .strict();
```

Remove candidate-only `EvidenceClaim` after `rg` confirms no caller remains. Leave final Event/Edge/Ending/Story Map schemas unchanged.

- [ ] **Step 4: Implement deterministic Unit resolution**

Add:

```ts
export function sourceReferenceForUnit(unit: EvidenceUnit): SourceReference {
  return SourceReferenceSchema.parse({
    sourceId: unit.sourceId,
    sectionId: unit.sectionId,
    start: unit.start,
    end: unit.end,
    excerptHash: sha256(unit.text),
  });
}
```

`resolveEvidenceUnitIds` builds a map from the current Source Units, rejects duplicate IDs and missing IDs, and returns references only for exact matches. `resolveStoryMapContentCandidate(candidate, source, units)` uses it for Event, Edge and Ending Candidate. No fuzzy match, string search, merging, coercion or fallback.

- [ ] **Step 5: Integrate the same Units into both model stages**

Set:

```ts
const extractorPromptVersion = "story-map.v2";
const reconcilerPromptVersion = "story-map-reconcile.v2";
const evidenceUnits = deriveEvidenceUnits(source);
```

Build one Source Packet:

```ts
return [
  '<immutable_source id="' + source.id + '">',
  "<sections>" + JSON.stringify(source.sections) + "</sections>",
  "<evidence_units>" + JSON.stringify(
    units.map(({ id, sectionId, text }) => ({ id, sectionId, text })),
  ) + "</evidence_units>",
  "</immutable_source>",
].join("\n");
```

Do not include a second untagged `normalized_text` copy. Pass the same Unit array to Reconciler validation and final resolution. Update fixture Mock candidates by choosing the Unit that contains each fixture reference; throw when none exists.

- [ ] **Step 6: Add versioned Prompt files**

Both v2 files must say that `participants` and `stateChanges` are always arrays, Evidence is one or more current `evidenceUnitIds`, and the model must not output quotes/offsets/hash/SourceReference. Include a complete synthetic format-only JSON example and explicitly say not to copy its IDs or values. Reconciler v2 also includes a synthetic Ending Candidate. Do not edit v1 or include Benchmark Gold.

- [ ] **Step 7: Verify GREEN and the one-repair limit**

```bash
npm test -- tests/unit/evidence-units.test.ts tests/unit/story-map-candidate.test.ts tests/unit/story-map-generation.test.ts
npm run test:unit
```

Expected: PASS. The Reconciler failure test still sends only initial plus one repair and creates no Artifact on second failure.

- [ ] **Step 8: Commit**

```bash
git add prompts/story-map.v2.md prompts/story-map-reconcile.v2.md src/domain/schemas/story-map.ts src/domain/source/evidence-units.ts src/domain/source/resolve-story-map-evidence.ts src/server/story-map/generate-story-map.ts src/server/story-map/generate-configured-story-map.ts tests/unit/story-map-candidate.test.ts tests/unit/story-map-generation.test.ts
git commit -m "功能：以证据单元定位 Story Map Candidate"
```

---

### Task 4: Add sanitized compatibility metrics

**Files:**

- Modify: `src/evals/m1-baseline.ts`
- Modify: `scripts/eval-m1-baseline.ts`
- Modify: `tests/unit/m1-baseline.test.ts`

- [ ] **Step 1: Write failing pure-summary tests**

Test a successful repair with a complete sanitized observation helper:

```ts
function succeededCall(
  schemaName: string,
  attempt: "initial" | "repair",
): ProviderObservation {
  return {
    schemaName,
    attempt,
    status: "succeeded",
    durationMs: 1,
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    failureCode: null,
  };
}

expect(summarizeStoryMapValidation({
  calls: [
    succeededCall("story_map_extraction", "initial"),
    succeededCall("story_map_content", "initial"),
    succeededCall("story_map_content", "repair"),
  ],
  runs: [
    { kind: "story_map_extract", status: "succeeded" },
    { kind: "story_map_reconcile", status: "succeeded" },
  ],
  evidenceValidity: { matched: 9, total: 9, rate: 1 },
  storyMapArtifactCreated: true,
})).toEqual({
  extractor: { firstPassValidation: "passed", repair: "not_needed" },
  reconciler: { firstPassValidation: "failed", repair: "succeeded" },
  evidenceValidity: { matched: 9, total: 9, rate: 1 },
  storyMapArtifactCreated: true,
});
```

Add Provider-before-candidate (`not_observed`), failed repair and Reconciler `not_run` cases. Parse a full story report using `json_object` and prove serialized metrics omit prompt, raw output, titles, names and Source text.

- [ ] **Step 2: Verify RED**

```bash
npm test -- tests/unit/m1-baseline.test.ts
```

- [ ] **Step 3: Add exact report types**

```ts
const StageValidationSchema = z.object({
  firstPassValidation: z.enum([
    "passed", "failed", "not_run", "not_observed",
  ]),
  repair: z.enum(["not_needed", "succeeded", "failed", "not_run"]),
}).strict();

const CompatibilitySchema = z.object({
  extractor: StageValidationSchema,
  reconciler: StageValidationSchema,
  evidenceValidity: RateScoreSchema.nullable(),
  storyMapArtifactCreated: z.boolean(),
}).strict();
```

Add `compatibility` to every story report and permit all three explicit output modes. Derive stage status only from sanitized calls plus Generation Run kind/status; never inspect raw output or detailed error text.

- [ ] **Step 4: Populate success and failure reports**

On success pass `score.evidenceValidity` and `true`; on failure pass `null` and `false`. Keep failure `reviewTarget`/`storyMap` null. Print only mode, stage states, Evidence rate, Artifact boolean, tokens and duration.

- [ ] **Step 5: Verify GREEN**

```bash
npm test -- tests/unit/m1-baseline.test.ts tests/unit/structured-generation.test.ts tests/contract/structured-generation.contract.test.ts
npm run test:unit
npm run test:contract
```

- [ ] **Step 6: Commit**

```bash
git add src/evals/m1-baseline.ts scripts/eval-m1-baseline.ts tests/unit/m1-baseline.test.ts
git commit -m "评测：记录 M1-02A Schema 与证据兼容指标"
```

---

### Task 5: Align documentation and pass deterministic gates

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/decisions/0002-openai-compatible-boundary.md`

- [ ] **Step 1: Document three explicit modes**

Document `json_schema` as strict native Structured Outputs, `json_object` as native JSON-object syntax plus authoritative local validation, and `prompt_json` as no `response_format`. State there is no discovery/fallback. Keep `.env.example` generic; never copy private endpoint credentials.

- [ ] **Step 2: Prove no dependency/schema/history drift**

```bash
git diff -- package.json package-lock.json drizzle prompts/story-map.v1.md prompts/story-map-reconcile.v1.md
```

Expected: empty. Also verify the docs name all three modes.

- [ ] **Step 3: Run every deterministic gate**

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm test
npm run build
CI=1 npm run test:e2e
```

Expected: every command exits 0. If `next-env.d.ts` changes only generated `.next`/`.next/dev` imports, inspect and restore its pre-command tracked content with a minimal patch.

- [ ] **Step 4: Commit and verify a clean implementation SHA**

```bash
git add .env.example README.md docs/decisions/0002-openai-compatible-boundary.md
git commit -m "文档：说明显式 JSON 输出模式"
git status --short
git diff HEAD~4..HEAD --check
git rev-parse HEAD
```

Expected: clean tracked worktree and a recorded implementation SHA.

---

### Task 6: Run the same DeepSeek model, publish sanitized evidence, and stop

**Files:**

- Local-only modify: `.env.local`
- Local-only output: the runner-created immutable directory under `.data/evals/m1-baseline/`, containing `metrics.json` and `eval.db`
- Create: `docs/evals/runs/2026-08-12-m1-02a-provider-evidence-compatibility.md`
- Modify: `docs/evals.md`

- [ ] **Step 1: Set only `OPENAI_STRUCTURED_OUTPUT_MODE=json_object` in ignored `.env.local`**

Verify only safe fields: Provider, model, mode, base URL host and key-present boolean. Never print the key.

- [ ] **Step 2: Reconfirm Git ignore boundaries**

```bash
for path in .env.local benchmarks/private/m1-a-zhuanzhengqi/source.txt benchmarks/private/m1-a-zhuanzhengqi/manifest.json benchmarks/private/m1-b-chunsheng/source.txt benchmarks/private/m1-b-chunsheng/manifest.json benchmarks/private/m1-c-wudu/source.txt benchmarks/private/m1-c-wudu/manifest.json .data/evals/m1-baseline/probe; do git check-ignore -q "$path" || exit 1; done
```

- [ ] **Step 3: Run one explicit, no-fallback baseline**

```bash
npm run eval:m1:baseline -- \
  --manifest benchmarks/private/m1-a-zhuanzhengqi/manifest.json \
  --manifest benchmarks/private/m1-b-chunsheng/manifest.json \
  --manifest benchmarks/private/m1-c-wudu/manifest.json
```

PASS requires: suite `awaiting_human_review`; all stories `generated` in `json_object`; all Artifacts true; Evidence validity exactly 100%; all review targets non-null. FAIL preserves the immutable run and stops without another mode or M1-03.

- [ ] **Step 4: Validate only sanitized metrics**

Read `metrics.json`, not Source or `eval.db` raw output. Assert mode, Artifact, Evidence rate, review target and all privacy flags. Confirm every private/local artifact remains ignored.

- [ ] **Step 5: Write the public sanitized run report**

The exact report file records the implementation SHA, actual run-id, Provider/model/mode, Prompt v2 versions, per-Story first-pass/repair state, Evidence percentage, Artifact boolean, tokens, duration, deterministic test counts, privacy statement, local metrics path, and exactly one `M1-02A PASS`/`FAIL` conclusion. It must not contain private titles, names, event summaries, quotes, raw output, Source text, credentials or detailed validation errors. Add it to `docs/evals.md` without altering historical reports.

- [ ] **Step 6: Run final gates and inspect tracking**

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:contract
npm test
npm run build
CI=1 npm run test:e2e
git diff --check
git status --short
```

Expected: all gates exit 0; only the new public report/index are pending; no ignored material appears.

- [ ] **Step 7: Commit, push, report, stop**

```bash
git add docs/evals.md docs/evals/runs/2026-08-12-m1-02a-provider-evidence-compatibility.md
git commit -m "评测：记录 M1-02A DeepSeek 兼容结果"
git push origin main
```

Final response reports actual run-id, sanitized metrics path, review queue when present, tests, new dependencies (`none`), exact PASS/FAIL and whether M1-02 may resume. Do not enter M1-03.
