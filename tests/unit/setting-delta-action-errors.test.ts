import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AddSettingDeltaInputSchema,
  SETTING_DELTA_INPUT_GENERIC_ERROR,
  SETTING_DELTA_LIFECYCLE_INPUT_GENERIC_ERROR,
  SettingDeltaLifecycleInputSchema,
  settingDeltaInputErrorMessage,
} from "@/app/projects/setting-delta-action-input";

/** 自建短句与稳定 id，不含任何作品原文。 */
const validInput = {
  projectId: "project_probe",
  worldlineId: "wl_probe",
  anchorSceneId: null,
  subject: { kind: "term", name: "旧灯塔" },
  statement: "旧灯塔已被封锁。",
  idempotencyKey: "probe-key",
} as const;

function requireZodError(
  result: z.ZodSafeParseResult<unknown>,
): z.ZodError {
  if (result.success) throw new Error("预期输入解析失败，但实际成功");
  return result.error;
}

describe("setting delta action input errors", () => {
  it("returns the specific code-point message for a forbidden term name", () => {
    const error = requireZodError(
      AddSettingDeltaInputSchema.safeParse({
        ...validInput,
        subject: { kind: "term", name: "旧灯塔\u200B" },
      }),
    );
    expect(settingDeltaInputErrorMessage(error)).toBe(
      "词条名包含不允许的字符 U+200B（零宽空格）",
    );
  });

  it("returns the specific code-point message for a forbidden statement", () => {
    const error = requireZodError(
      AddSettingDeltaInputSchema.safeParse({
        ...validInput,
        statement: "旧灯塔\u200D已被封锁。",
      }),
    );
    expect(settingDeltaInputErrorMessage(error)).toBe(
      "设定说明包含不允许的字符 U+200D（零宽连接符）",
    );
  });

  it("falls back to the generic message for unrelated invalid fields", () => {
    const error = requireZodError(
      AddSettingDeltaInputSchema.safeParse({
        ...validInput,
        subject: { kind: "character", characterId: "" },
      }),
    );
    expect(settingDeltaInputErrorMessage(error)).toBe(
      SETTING_DELTA_INPUT_GENERIC_ERROR,
    );
  });

  it("uses the same mapping for lifecycle actions with their own fallback", () => {
    const error = requireZodError(
      SettingDeltaLifecycleInputSchema.safeParse({
        projectId: "project_probe",
        worldlineId: "wl_probe",
        targetDeltaId: "delta_probe",
        idempotencyKey: "",
      }),
    );
    expect(
      settingDeltaInputErrorMessage(
        error,
        SETTING_DELTA_LIFECYCLE_INPUT_GENERIC_ERROR,
      ),
    ).toBe(SETTING_DELTA_LIFECYCLE_INPUT_GENERIC_ERROR);
  });
});
