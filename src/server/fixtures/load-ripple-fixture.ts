import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  ImpactPlanSchema,
  SourceSchema,
  StoryMapSchema,
} from "@/domain/schemas";
import { assertValidStoryMap } from "@/domain/invariants/validate-story-map";
import {
  extractMarkdownSections,
  normalizeSourceText,
  sha256,
} from "@/domain/source/normalize-source";

let fixturePromise: ReturnType<typeof readFixture> | undefined;

export function loadRippleFixture(): ReturnType<typeof readFixture> {
  fixturePromise ??= readFixture();
  return fixturePromise;
}

async function readFixture() {
  const fixtureDirectory = path.join(process.cwd(), "fixtures", "ripple-001");
  const [originalText, storyMapText, impactPlansText] = await Promise.all([
    readFile(path.join(fixtureDirectory, "source.md"), "utf8"),
    readFile(path.join(fixtureDirectory, "expected-story-map.json"), "utf8"),
    readFile(path.join(fixtureDirectory, "expected-impacts.json"), "utf8"),
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
  const impactPlans = z.array(ImpactPlanSchema).parse(JSON.parse(impactPlansText));

  assertValidStoryMap(storyMap, source);
  return { source, storyMap, impactPlans };
}
