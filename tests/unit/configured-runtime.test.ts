import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readConfiguredAI } from "@/server/ai/configured-runtime";

const environmentNames = [
  "AI_PROVIDER_NAME",
  "OPENAI_MODEL",
  "OPENAI_STRUCTURED_OUTPUT_MODE",
] as const;

let originalEnvironment: Record<(typeof environmentNames)[number], string | undefined>;

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  ) as typeof originalEnvironment;
  process.env.AI_PROVIDER_NAME = "openai-compatible";
  process.env.OPENAI_MODEL = "deepseek-chat";
});

afterEach(() => {
  for (const name of environmentNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("configured AI runtime", () => {
  it("accepts json_object only when explicitly configured", () => {
    process.env.OPENAI_STRUCTURED_OUTPUT_MODE = "json_object";

    expect(readConfiguredAI()).toEqual({
      providerName: "openai-compatible",
      modelConfig: {
        model: "deepseek-chat",
        structuredOutputMode: "json_object",
      },
    });
  });

  it("rejects automatic mode instead of detecting or falling back", () => {
    process.env.OPENAI_STRUCTURED_OUTPUT_MODE = "automatic";

    expect(() => readConfiguredAI()).toThrow();
  });
});
