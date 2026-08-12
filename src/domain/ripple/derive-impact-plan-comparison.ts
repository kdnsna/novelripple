import type { ImpactPlan, StoryMap } from "@/domain/schemas";

type ChangeType = ImpactPlan["impacts"][number]["changeType"];

export type ImpactPlanComparison = {
  originalPath: Array<{ eventId: string; title: string }>;
  newPath: Array<{ impactId: string; summary: string }>;
  changes: Record<
    ChangeType,
    Array<{
      impactId: string;
      summary: string;
      affectedEventId: string | null;
    }>
  >;
};

export function deriveImpactPlanComparison(
  storyMap: StoryMap,
  impactPlan: ImpactPlan,
): ImpactPlanComparison {
  const pathIds = new Set(
    impactPlan.impacts.flatMap((impact) => impact.reasonPath),
  );
  const originalPath = storyMap.events
    .filter((event) => pathIds.has(event.id))
    .toSorted((left, right) => left.sequence - right.sequence)
    .map((event) => ({ eventId: event.id, title: event.title }));
  const newPath = impactPlan.impacts.map((impact) => ({
    impactId: impact.id,
    summary: impact.summary,
  }));
  const changes: ImpactPlanComparison["changes"] = {
    removed: [],
    modified: [],
    added: [],
    preserved: [],
  };
  for (const impact of impactPlan.impacts) {
    changes[impact.changeType].push({
      impactId: impact.id,
      summary: impact.summary,
      affectedEventId: impact.affectedEventId,
    });
  }
  return { originalPath, newPath, changes };
}
