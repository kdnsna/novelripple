import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  ContinuationDirectionsModelOutputSchema,
  ContinuationSceneModelOutputSchema,
  DivergenceSchema,
  ImpactPlanSchema,
  SourceSchema,
  StoryMapSchema,
} from "@/domain/schemas";
import {
  assertValidImpactPlan,
  assertValidStoryMap,
} from "@/domain/invariants/validate-story-map";
import {
  extractMarkdownSections,
  normalizeSourceText,
  sha256,
} from "@/domain/source/normalize-source";

let fixturePromise: ReturnType<typeof readFixture> | undefined;

const ContinuationFixtureSchema = z
  .object({
    impactPlanFixtureId: z.string().min(1),
    directions: ContinuationDirectionsModelOutputSchema,
    selectedDirectionIndex: z.number().int().min(0).max(2),
    scene: ContinuationSceneModelOutputSchema,
  })
  .strict();

export function loadRippleFixture(): ReturnType<typeof readFixture> {
  fixturePromise ??= readFixture();
  return fixturePromise;
}

async function readFixture() {
  const fixtureDirectory = path.join(process.cwd(), "fixtures", "ripple-001");
  const [
    originalText,
    storyMapText,
    divergencesText,
    impactPlansText,
    continuationText,
  ] =
    await Promise.all([
      readFile(path.join(fixtureDirectory, "source.md"), "utf8"),
      readFile(
        path.join(fixtureDirectory, "expected-story-map.json"),
        "utf8",
      ),
      readFile(path.join(fixtureDirectory, "divergences.json"), "utf8"),
      readFile(
        path.join(fixtureDirectory, "expected-impacts.json"),
        "utf8",
      ),
      readFile(
        path.join(fixtureDirectory, "expected-continuation.json"),
        "utf8",
      ),
    ]);
  const normalizedText = normalizeSourceText(originalText);
  const source = SourceSchema.parse({
    id: "source_ripple_001",
    projectId: "project_ripple_001",
    title: "潮汐钟停在凌晨四点",
    originalText,
    normalizedText,
    contentHash: sha256(normalizedText),
    sections: extractMarkdownSections(normalizedText),
    createdAt: "2026-08-11T00:00:00.000Z",
  });
  const storyMap = StoryMapSchema.parse(JSON.parse(storyMapText));
  const divergences = z
    .array(DivergenceSchema)
    .parse(JSON.parse(divergencesText));
  const impactPlans = z.array(ImpactPlanSchema).parse(JSON.parse(impactPlansText));
  const continuation = ContinuationFixtureSchema.parse(
    JSON.parse(continuationText),
  );

  assertValidStoryMap(storyMap, source);
  for (const impactPlan of impactPlans) {
    assertValidImpactPlan(impactPlan, storyMap);
  }
  if (
    !impactPlans.some((plan) => plan.id === continuation.impactPlanFixtureId)
  ) {
    throw new Error("Continuation Fixture 未绑定已存在的 Impact Plan");
  }
  return { source, storyMap, divergences, impactPlans, continuation };
}
