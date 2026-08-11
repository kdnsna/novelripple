import { z } from "zod";

import { AnchorSchema } from "./impact-plan";
import { DivergenceSchema } from "./divergence";

export const WorldlineSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    parentWorldlineId: z.string().min(1).nullable(),
    baseStoryMapArtifactId: z.string().min(1),
    divergence: DivergenceSchema.nullable(),
    mode: z.enum(["strict", "open"]),
    anchors: z.array(AnchorSchema),
    acceptedImpactPlanId: z.string().min(1).nullable(),
    idempotencyKey: z.string().min(1),
    status: z.enum(["canonical", "active", "archived"]),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((worldline, context) => {
    if (worldline.status === "canonical") {
      if (worldline.parentWorldlineId !== null || worldline.divergence !== null) {
        context.addIssue({
          code: "custom",
          message: "原著世界线不能包含父世界线或分歧点",
        });
      }
      return;
    }

    if (
      worldline.parentWorldlineId === null ||
      worldline.divergence === null ||
      worldline.acceptedImpactPlanId === null
    ) {
      context.addIssue({
        code: "custom",
        message: "子世界线必须引用父世界线、分歧点和已接受影响计划",
      });
    }

    if (worldline.mode === "open" && worldline.anchors.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["anchors"],
        message: "开放模式不能包含结局锚点",
      });
    }
  });

export type Worldline = z.infer<typeof WorldlineSchema>;
