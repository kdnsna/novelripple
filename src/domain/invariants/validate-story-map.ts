import type {
  EvidenceReference,
  Source,
  StoryMap,
} from "@/domain/schemas";
import { sha256 } from "@/domain/source/normalize-source";

export type StoryMapValidationIssue = {
  path: string;
  message: string;
};

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  return [...duplicates];
}

function validateEvidence(
  source: Source,
  reference: EvidenceReference,
  path: string,
): StoryMapValidationIssue[] {
  const issues: StoryMapValidationIssue[] = [];

  if (reference.sourceId !== source.id) {
    issues.push({ path, message: `证据引用了未知 Source：${reference.sourceId}` });
    return issues;
  }

  const section = source.sections.find((item) => item.id === reference.sectionId);
  if (!section) {
    issues.push({ path, message: `证据引用了未知 Section：${reference.sectionId}` });
  }

  if (
    reference.start < 0 ||
    reference.end > source.normalizedText.length ||
    reference.start >= reference.end
  ) {
    issues.push({ path, message: "证据字符偏移超出 Source 边界" });
    return issues;
  }

  if (
    section &&
    (reference.start < section.start || reference.end > section.end)
  ) {
    issues.push({ path, message: "证据字符偏移不在声明的 Section 内" });
  }

  const excerpt = source.normalizedText.slice(reference.start, reference.end);
  if (sha256(excerpt) !== reference.excerptHash) {
    issues.push({ path, message: "证据片段 Hash 与 Source 不匹配" });
  }

  return issues;
}

export function validateStoryMap(
  storyMap: StoryMap,
  source: Source,
): StoryMapValidationIssue[] {
  const issues: StoryMapValidationIssue[] = [];
  const characterIds = new Set(storyMap.characters.map((item) => item.id));
  const eventIds = new Set(storyMap.events.map((item) => item.id));

  for (const duplicate of duplicateValues(
    storyMap.characters.map((item) => item.id),
  )) {
    issues.push({ path: "characters", message: `重复人物 ID：${duplicate}` });
  }

  for (const duplicate of duplicateValues(storyMap.events.map((item) => item.id))) {
    issues.push({ path: "events", message: `重复事件 ID：${duplicate}` });
  }

  for (const duplicate of duplicateValues(storyMap.edges.map((item) => item.id))) {
    issues.push({ path: "edges", message: `重复边 ID：${duplicate}` });
  }

  for (const duplicate of duplicateValues(
    storyMap.events.map((item) => String(item.sequence)),
  )) {
    issues.push({ path: "events", message: `重复事件顺序：${duplicate}` });
  }

  for (const [eventIndex, event] of storyMap.events.entries()) {
    for (const participant of event.participants) {
      if (!characterIds.has(participant)) {
        issues.push({
          path: `events.${eventIndex}.participants`,
          message: `事件引用了未知人物：${participant}`,
        });
      }
    }

    event.evidence.forEach((reference, evidenceIndex) => {
      issues.push(
        ...validateEvidence(
          source,
          reference,
          `events.${eventIndex}.evidence.${evidenceIndex}`,
        ),
      );
    });
  }

  for (const [edgeIndex, edge] of storyMap.edges.entries()) {
    if (!eventIds.has(edge.sourceEventId) || !eventIds.has(edge.targetEventId)) {
      issues.push({
        path: `edges.${edgeIndex}`,
        message: `因果边包含悬空引用：${edge.sourceEventId} → ${edge.targetEventId}`,
      });
    }

    edge.evidence.forEach((reference, evidenceIndex) => {
      issues.push(
        ...validateEvidence(
          source,
          reference,
          `edges.${edgeIndex}.evidence.${evidenceIndex}`,
        ),
      );
    });
  }

  for (const [endingIndex, ending] of storyMap.endingCandidates.entries()) {
    if (!eventIds.has(ending.targetEventId)) {
      issues.push({
        path: `endingCandidates.${endingIndex}`,
        message: `结局候选引用了未知事件：${ending.targetEventId}`,
      });
    }

    ending.evidence.forEach((reference, evidenceIndex) => {
      issues.push(
        ...validateEvidence(
          source,
          reference,
          `endingCandidates.${endingIndex}.evidence.${evidenceIndex}`,
        ),
      );
    });
  }

  return issues;
}

export function assertValidStoryMap(storyMap: StoryMap, source: Source): void {
  const issues = validateStoryMap(storyMap, source);
  if (issues.length > 0) {
    throw new Error(
      `Story Map 校验失败：\n${issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }
}
