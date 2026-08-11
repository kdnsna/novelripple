import type { Metadata } from "next";

import { StoryWorkspace } from "@/components/story-workspace/story-workspace";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { listDemoWorldlines } from "@/server/repositories/demo-repository";

export const metadata: Metadata = {
  title: "潮汐钟停在凌晨四点",
};

export const dynamic = "force-dynamic";

export default async function DemoPage() {
  const [{ source, storyMap, impactPlans }, worldlines] = await Promise.all([
    loadRippleFixture(),
    listDemoWorldlines(),
  ]);

  return (
    <StoryWorkspace
      source={{
        title: source.title,
        normalizedText: source.normalizedText,
        sections: source.sections,
      }}
      storyMap={storyMap}
      impactPlans={impactPlans}
      initialWorldlines={worldlines}
    />
  );
}
