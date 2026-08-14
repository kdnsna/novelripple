import { z } from "zod";

import { CharacterChangeSchema } from "./impact-plan";

const FactKeySchema = z
  .string()
  .regex(/^(event|impact|divergence|generated):[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

export const StateFactSchema = z
  .object({
    key: FactKeySchema,
    statement: z.string().trim().min(1),
  })
  .strict();

export const StatePatchSchema = z
  .object({
    factsAdded: z.array(StateFactSchema),
    factsRemoved: z.array(FactKeySchema),
    characterChanges: z.array(CharacterChangeSchema),
    threadsOpened: z.array(z.string().trim().min(1)),
    threadsClosed: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((patch, context) => {
    addDuplicateIssues(
      patch.factsAdded.map((fact) => fact.key),
      ["factsAdded"],
      "新增事实 key 重复",
      context,
    );
    addDuplicateIssues(
      patch.factsRemoved,
      ["factsRemoved"],
      "删除事实 key 重复",
      context,
    );
    addDuplicateIssues(
      patch.characterChanges.map((change) => change.characterId),
      ["characterChanges"],
      "同一人物存在重复状态补丁",
      context,
    );
    addDuplicateIssues(
      patch.threadsOpened,
      ["threadsOpened"],
      "开启线索重复",
      context,
    );
    addDuplicateIssues(
      patch.threadsClosed,
      ["threadsClosed"],
      "关闭线索重复",
      context,
    );

    const removedFacts = new Set(patch.factsRemoved);
    for (const [index, fact] of patch.factsAdded.entries()) {
      if (removedFacts.has(fact.key)) {
        context.addIssue({
          code: "custom",
          path: ["factsAdded", index, "key"],
          message: "同一状态补丁不能同时新增和删除同一事实",
        });
      }
    }

    const closedThreads = new Set(patch.threadsClosed);
    for (const [index, thread] of patch.threadsOpened.entries()) {
      if (closedThreads.has(thread)) {
        context.addIssue({
          code: "custom",
          path: ["threadsOpened", index],
          message: "同一状态补丁不能同时开启和关闭同一线索",
        });
      }
    }
  });

export const WorldlineDeltaSchema = StatePatchSchema;

export const ContinuationDirectionModelSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    premise: z.string().trim().min(1).max(1_000),
    affectedCharacterIds: z.array(z.string().min(1)).min(1),
    expectedConsequence: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const ContinuationDirectionsModelOutputSchema = z
  .object({
    directions: z.array(ContinuationDirectionModelSchema).length(3),
  })
  .strict();

export const ContinuationDirectionSchema = ContinuationDirectionModelSchema.extend({
  id: z.string().min(1),
}).strict();

export const ContinuationDirectionsSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    worldlineId: z.string().min(1),
    acceptedImpactPlanId: z.string().min(1),
    directions: z.array(ContinuationDirectionSchema).length(3),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const ContinuationSceneModelOutputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    prose: z.string().trim().min(1_200),
    statePatch: StatePatchSchema,
  })
  .strict();

export const ContinuationSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    worldlineId: z.string().min(1),
    acceptedImpactPlanId: z.string().min(1),
    directionsArtifactId: z.string().min(1),
    selectedDirectionId: z.string().min(1),
    sequence: z.literal(1),
    title: z.string().trim().min(1).max(200),
    prose: z.string().trim().min(1_200),
    statePatch: StatePatchSchema,
    contentKind: z.literal("generated"),
    createdAt: z.iso.datetime(),
  })
  .strict();

function addDuplicateIssues(
  values: string[],
  path: PropertyKey[],
  message: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", path, message: `${message}：${value}` });
    }
    seen.add(value);
  }
}

export type StateFact = z.infer<typeof StateFactSchema>;
export type StatePatch = z.infer<typeof StatePatchSchema>;
export type WorldlineDelta = z.infer<typeof WorldlineDeltaSchema>;
export type ContinuationDirectionModel = z.infer<
  typeof ContinuationDirectionModelSchema
>;
export type ContinuationDirectionsModelOutput = z.infer<
  typeof ContinuationDirectionsModelOutputSchema
>;
export type ContinuationDirection = z.infer<typeof ContinuationDirectionSchema>;
export type ContinuationDirections = z.infer<typeof ContinuationDirectionsSchema>;
export type ContinuationSceneModelOutput = z.infer<
  typeof ContinuationSceneModelOutputSchema
>;
export type Continuation = z.infer<typeof ContinuationSchema>;
