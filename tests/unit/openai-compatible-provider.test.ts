import { describe, expect, it } from "vitest";

import { OpenAICompatibleProvider } from "@/server/ai/openai-compatible-provider";
import type { AIProviderRequest } from "@/server/ai/types";

const jsonSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

function request(
  structuredOutputMode: "json_schema" | "prompt_json",
): AIProviderRequest {
  return {
    prompt: "Return one answer.",
    schemaName: "test_answer",
    jsonSchema,
    modelConfig: {
      model: "compatible-model",
      structuredOutputMode,
    },
  };
}

function createFakeClient(content: string | null = '{"answer":"ok"}') {
  const calls: unknown[] = [];
  const requestOptions: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: unknown, options?: unknown) => {
          calls.push(body);
          requestOptions.push(options);
          return {
            id: "chatcmpl_test",
            choices: [{ message: { content } }],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16,
            },
          };
        },
      },
    },
  };

  return { client, calls, requestOptions };
}

describe("OpenAI-compatible provider", () => {
  it("uses Chat Completions json_schema mode without provider fallback", async () => {
    const { client, calls } = createFakeClient();
    const provider = new OpenAICompatibleProvider({
      providerName: "local-compatible",
      apiKey: "test-key",
      baseURL: "http://127.0.0.1:11434/v1",
      client,
    });

    const response = await provider.generate(request("json_schema"));

    expect(provider.providerName).toBe("local-compatible");
    expect(response).toEqual({
      rawOutput: '{"answer":"ok"}',
      requestId: "chatcmpl_test",
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        model: "compatible-model",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "test_answer",
            strict: true,
            schema: jsonSchema,
          },
        },
      }),
    ]);
  });

  it("uses explicit prompt_json mode without sending response_format", async () => {
    const { client, calls } = createFakeClient();
    const provider = new OpenAICompatibleProvider({
      providerName: "prompt-only-compatible",
      apiKey: "test-key",
      client,
    });

    await provider.generate(request("prompt_json"));

    const body = calls[0] as {
      messages: Array<{ role: string; content: string }>;
      response_format?: unknown;
    };
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.messages[0]?.content).toContain("Return exactly one JSON value");
    expect(body.messages[0]?.content).toContain('"additionalProperties":false');
  });

  it("sets an explicit timeout for every upstream request", async () => {
    const { client, requestOptions } = createFakeClient();
    const provider = new OpenAICompatibleProvider({
      providerName: "timeout-compatible",
      apiKey: "test-key",
      client,
    });

    await provider.generate(request("json_schema"));

    expect(requestOptions).toEqual([{ timeout: 120_000 }]);
  });

  it("passes explicit repair context to the next provider request", async () => {
    const { client, calls } = createFakeClient('{"answer":"fixed"}');
    const provider = new OpenAICompatibleProvider({
      providerName: "repair-compatible",
      apiKey: "test-key",
      client,
    });
    const repairRequest = request("prompt_json");
    repairRequest.repair = {
      previousRawOutput: '{"answer":123}',
      validationIssues: ["answer: expected string"],
    };

    await provider.generate(repairRequest);

    const body = calls[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages.at(-1)?.content).toContain('{"answer":123}');
    expect(body.messages.at(-1)?.content).toContain("answer: expected string");
  });

  it("fails when Chat Completions returns no text content", async () => {
    const { client } = createFakeClient(null);
    const provider = new OpenAICompatibleProvider({
      providerName: "empty-compatible",
      apiKey: "test-key",
      client,
    });

    await expect(provider.generate(request("json_schema"))).rejects.toThrow(
      "OpenAI-compatible response contained no text content",
    );
  });

  it("rejects an unknown output mode instead of silently changing modes", async () => {
    const { client, calls } = createFakeClient();
    const provider = new OpenAICompatibleProvider({
      providerName: "strict-compatible",
      apiKey: "test-key",
      client,
    });
    const invalidRequest = request("prompt_json");
    invalidRequest.modelConfig.structuredOutputMode = "automatic" as never;

    await expect(provider.generate(invalidRequest)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
