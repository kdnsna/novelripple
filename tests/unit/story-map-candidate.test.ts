import { describe, expect, it } from "vitest";

import {
  StoryMapContentCandidateSchema,
  type SourceReference,
} from "@/domain/schemas";
import {
  resolveEvidenceClaim,
  resolveStoryMapContentCandidate,
} from "@/domain/source/resolve-story-map-evidence";
import { sha256 } from "@/domain/source/normalize-source";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

function toClaim(reference: SourceReference, sourceText: string) {
  return {
    sectionId: reference.sectionId,
    exactQuote: sourceText.slice(reference.start, reference.end),
  };
}

describe("Story Map model candidates", () => {
  it("accepts quote-based content and deterministically restores Golden evidence", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const candidate = StoryMapContentCandidateSchema.parse({
      title: storyMap.title,
      logline: storyMap.logline,
      characters: storyMap.characters,
      events: storyMap.events.map((event) => ({
        ...event,
        evidence: event.evidence.map((reference) =>
          toClaim(reference, source.normalizedText),
        ),
      })),
      edges: storyMap.edges.map((edge) => ({
        ...edge,
        evidence: edge.evidence.map((reference) =>
          toClaim(reference, source.normalizedText),
        ),
      })),
      endingCandidates: storyMap.endingCandidates.map((ending) => ({
        ...ending,
        evidence: ending.evidence.map((reference) =>
          toClaim(reference, source.normalizedText),
        ),
      })),
    });

    const resolved = resolveStoryMapContentCandidate(candidate, source);

    expect(resolved).toEqual({
      success: true,
      content: {
        title: storyMap.title,
        logline: storyMap.logline,
        characters: storyMap.characters,
        events: storyMap.events,
        edges: storyMap.edges,
        endingCandidates: storyMap.endingCandidates,
      },
    });
  });

  it("rejects an exact quote that is absent from its declared section", async () => {
    const { source } = await loadRippleFixture();

    expect(
      resolveEvidenceClaim(
        { sectionId: "section_01", exactQuote: "这句话没有出现在原文中" },
        source,
        "events.0.evidence.0",
      ),
    ).toEqual({
      success: false,
      issue: {
        path: "events.0.evidence.0.exactQuote",
        message: "Evidence 摘录未在声明的 Section 中找到",
      },
    });
  });

  it("rejects an ambiguous quote instead of guessing one occurrence", () => {
    const normalizedText = "重复证据，然后再次出现重复证据。";
    const source = {
      id: "source_repeat",
      projectId: "project_repeat",
      title: "重复测试",
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
      createdAt: "2026-08-11T00:00:00.000Z",
    };

    expect(
      resolveEvidenceClaim(
        { sectionId: "section_01", exactQuote: "重复证据" },
        source,
        "edges.0.evidence.0",
      ),
    ).toEqual({
      success: false,
      issue: {
        path: "edges.0.evidence.0.exactQuote",
        message: "Evidence 摘录在声明的 Section 中不唯一",
      },
    });
  });

  it("computes UTF-16 offsets and the excerpt hash on the server", () => {
    const normalizedText = "甲🌊乙证据片段丙";
    const source = {
      id: "source_utf16",
      projectId: "project_utf16",
      title: "UTF-16 测试",
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
      createdAt: "2026-08-11T00:00:00.000Z",
    };

    expect(
      resolveEvidenceClaim(
        { sectionId: "section_01", exactQuote: "证据片段" },
        source,
        "events.0.evidence.0",
      ),
    ).toEqual({
      success: true,
      reference: {
        sourceId: "source_utf16",
        sectionId: "section_01",
        start: 4,
        end: 8,
        excerptHash: sha256("证据片段"),
      },
    });
  });
});
