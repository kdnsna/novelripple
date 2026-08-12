import type { StoryMapReadiness } from "@/domain/review/derive-story-map-review";

type StoryMapReadinessProps = {
  readiness: StoryMapReadiness;
};

const checklist: Array<{
  key: Exclude<keyof StoryMapReadiness, "readyForRipple">;
  label: string;
}> = [
  { key: "eventsHaveEvidence", label: "关键 Event 均有 Evidence" },
  { key: "coreCharactersReviewed", label: "核心人物已核对" },
  { key: "endingCandidatesReviewed", label: "Ending Candidates 已核对" },
  { key: "noIllegalReferences", label: "无非法引用" },
  { key: "noDanglingEdges", label: "无悬空 Edge" },
  { key: "importantEvidenceReviewed", label: "重要 Evidence 已核对" },
];

export function StoryMapReadiness({ readiness }: StoryMapReadinessProps) {
  return (
    <section className="story-map-readiness" aria-labelledby="readiness-heading">
      <div>
        <span className="panel-kicker">Readiness Checklist</span>
        <h2 id="readiness-heading">进入 Ripple 前</h2>
      </div>
      <ul>
        {checklist.map((item) => (
          <li data-ready={readiness[item.key]} key={item.key}>
            <span aria-hidden="true">{readiness[item.key] ? "✓" : "○"}</span>
            {item.label}
          </li>
        ))}
      </ul>
      <p data-ready={readiness.readyForRipple}>
        {readiness.readyForRipple
          ? "当前 Story Map 可以进入 Ripple"
          : "完成上方核对后即可进入 Ripple"}
      </p>
    </section>
  );
}
