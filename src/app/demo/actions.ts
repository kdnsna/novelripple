"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { Worldline } from "@/domain/schemas";
import { acceptDemoImpactPlan } from "@/server/repositories/demo-repository";

const CreateDemoWorldlineInputSchema = z
  .object({
    impactPlanId: z.string().min(1),
    mode: z.enum(["strict", "open"]),
  })
  .strict();

export type CreateDemoWorldlineResult =
  | { ok: true; worldline: Worldline }
  | { ok: false; error: string };

export async function createDemoWorldlineAction(
  input: unknown,
): Promise<CreateDemoWorldlineResult> {
  const parsed = CreateDemoWorldlineInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "世界线参数无效，请重新选择分歧。" };
  }

  try {
    const worldline = await acceptDemoImpactPlan(
      parsed.data.impactPlanId,
      parsed.data.mode,
    );
    revalidatePath("/demo");
    return { ok: true, worldline };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "世界线创建失败。",
    };
  }
}
