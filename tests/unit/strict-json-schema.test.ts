import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OpenAICompatibleProvider } from "@/server/ai/openai-compatible-provider";
import {
  normalizeStrictResponse,
  toOpenAIStrictSchema,
} from "@/server/ai/strict-json-schema";
import type { AIProviderRequest } from "@/server/ai/types";
import {
  ImpactPlanModelOutputSchema,
  StoryMapExtractionCandidateSchema,
} from "@/domain/schemas";

function walkJson(value: unknown, visit: (node: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
  } else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      walkJson(child, visit);
    }
  }
}

describe("strict JSON Schema 适配", () => {
  it("把 optional 字段并入 required", () => {
    const schema = z.toJSONSchema(
      z.object({ a: z.string(), b: z.number().optional() }).strict(),
      { target: "draft-7" },
    ) as Record<string, unknown>;

    const { schema: strict } = toOpenAIStrictSchema(schema);

    expect(strict).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["a", "b"],
    });
  });

  it("把 nullable 字段降为单类型并记录归一化路径", () => {
    const schema = z.toJSONSchema(
      z.object({ c: z.string().nullable() }).strict(),
      { target: "draft-7" },
    ) as Record<string, unknown>;

    const { schema: strict, nullablePaths } = toOpenAIStrictSchema(schema);
    const properties = (strict as { properties: Record<string, unknown> })
      .properties;
    const field = properties.c as Record<string, unknown>;

    expect(field).toMatchObject({ type: "string" });
    expect(String(field.description)).toContain("空字符串");
    expect(nullablePaths).toEqual(["$.c"]);
  });

  it("把空串哨兵还原为 null，并递归处理数组元素", () => {
    const parsed = {
      items: [{ affectedEventId: "" }, { affectedEventId: "event_01" }],
    };

    const normalized = normalizeStrictResponse(parsed, [
      "$.items[].affectedEventId",
    ]);

    expect(normalized).toEqual({
      items: [{ affectedEventId: null }, { affectedEventId: "event_01" }],
    });
  });

  it("领域 Schema 转换后不含 anyOf，且所有对象 required 完整", () => {
    for (const domainSchema of [
      StoryMapExtractionCandidateSchema,
      ImpactPlanModelOutputSchema,
    ]) {
      const schema = z.toJSONSchema(domainSchema, {
        target: "draft-7",
      }) as Record<string, unknown>;
      const { schema: strict, nullablePaths } = toOpenAIStrictSchema(schema);

      walkJson(strict, (node) => {
        if (node === null || typeof node !== "object") return;
        const value = node as Record<string, unknown>;
        if (value.type === "object") {
          const properties = Object.keys(
            (value.properties ?? {}) as Record<string, unknown>,
          );
          expect(value.required).toEqual(properties);
          expect(value.additionalProperties).toBe(false);
        }
        expect(value.anyOf).toBeUndefined();
      });

      // Impact Plan 的 affectedEventId 是 nullable，必须被记录为归一化路径。
      if (domainSchema === ImpactPlanModelOutputSchema) {
        expect(
          nullablePaths.some((path) => path.endsWith("affectedEventId")),
        ).toBe(true);
      }
    }
  });

  it("json_schema 模式发送 strict 线缆 Schema，并把空串哨兵还原为 null", async () => {
    const wireSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        title: { type: "string" },
        note: {
          type: "string",
          description: "没有适用值时使用空字符串，服务端会将其还原为 null。",
        },
      },
      required: ["title", "note"],
      additionalProperties: false,
    };
    const fullSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        title: { type: "string" },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["title", "note"],
      additionalProperties: false,
    };
    const calls: unknown[] = [];
    const client = {
      chat: {
        completions: {
          create: async (body: unknown) => {
            calls.push(body);
            return {
              choices: [{ message: { content: '{"title":"ok","note":""}' } }],
            };
          },
        },
      },
    };
    const provider = new OpenAICompatibleProvider({
      providerName: "strict-adapter",
      apiKey: "test-key",
      client,
    });
    const request: AIProviderRequest = {
      prompt: "produce one record",
      schemaName: "strict_adapter",
      jsonSchema: fullSchema,
      modelConfig: {
        model: "strict-model",
        structuredOutputMode: "json_schema",
      },
    };

    const response = await provider.generate(request);
    const body = calls[0] as {
      response_format: {
        json_schema: { strict: boolean; schema: Record<string, unknown> };
      };
      messages: Array<{ content: string }>;
    };

    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toEqual(wireSchema);
    expect(body.messages[0]?.content).toContain("空字符串");
    expect(response.rawOutput).toBe('{"title":"ok","note":null}');
  });

  it("json_object 与 prompt_json 模式不做转换", async () => {
    const fullSchema: Record<string, unknown> = {
      type: "object",
      properties: { note: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: ["note"],
      additionalProperties: false,
    };
    const calls: unknown[] = [];
    const client = {
      chat: {
        completions: {
          create: async (body: unknown) => {
            calls.push(body);
            return { choices: [{ message: { content: '{"note":"keep"}' } }] };
          },
        },
      },
    };
    const provider = new OpenAICompatibleProvider({
      providerName: "plain-adapter",
      apiKey: "test-key",
      client,
    });

    for (const mode of ["json_object", "prompt_json"] as const) {
      const request: AIProviderRequest = {
        prompt: "produce one record",
        schemaName: "plain_adapter",
        jsonSchema: fullSchema,
        modelConfig: { model: "plain-model", structuredOutputMode: mode },
      };
      const response = await provider.generate(request);
      expect(response.rawOutput).toBe('{"note":"keep"}');
    }
    const bodies = calls as Array<{ messages: Array<{ content: string }> }>;
    expect(bodies[0]?.messages[0]?.content).toContain('"anyOf"');
    expect(JSON.stringify(calls)).not.toContain("空字符串");
  });
});
