import OpenAI from "openai";
import { z } from "zod";

import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
  GenerationUsage,
} from "./types";

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  response_format?:
    | { type: "json_object" }
    | {
        type: "json_schema";
        json_schema: {
          name: string;
          strict: true;
          schema: Record<string, unknown>;
        };
      };
};

type ChatCompletionResponse = {
  id?: string;
  choices: Array<{ message: { content: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

const requestTimeoutMs = 120_000;

export type OpenAICompatibleClient = {
  chat: {
    completions: {
      create(
        request: ChatCompletionRequest,
        options?: { timeout: number },
      ): Promise<ChatCompletionResponse>;
    };
  };
};

type OpenAICompatibleProviderConfig = {
  providerName: string;
  apiKey: string;
  baseURL?: string;
  client?: OpenAICompatibleClient;
};

const ConnectionConfigSchema = z
  .object({
    providerName: z.string().trim().min(1),
    apiKey: z.string().min(1),
    baseURL: z.url().optional(),
  })
  .strict();

export class OpenAICompatibleProvider implements AIProvider {
  readonly providerName: string;
  readonly #client: OpenAICompatibleClient;

  constructor(config: OpenAICompatibleProviderConfig) {
    const parsed = ConnectionConfigSchema.parse({
      providerName: config.providerName,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });

    this.providerName = parsed.providerName;
    this.#client =
      config.client ??
      (new OpenAI({
        apiKey: parsed.apiKey,
        ...(parsed.baseURL ? { baseURL: parsed.baseURL } : {}),
        maxRetries: 0,
      }) as unknown as OpenAICompatibleClient);
  }

  async generate(request: AIProviderRequest): Promise<AIProviderResponse> {
    const modelConfig = z
      .object({
        model: z.string().min(1),
        structuredOutputMode: z.enum([
          "json_schema",
          "json_object",
          "prompt_json",
        ]),
      })
      .strict()
      .parse(request.modelConfig);
    const messages = buildMessages(request);
    const responseFormat =
      modelConfig.structuredOutputMode === "json_schema"
        ? {
            type: "json_schema" as const,
            json_schema: {
              name: request.schemaName,
              strict: true as const,
              schema: request.jsonSchema,
            },
          }
        : modelConfig.structuredOutputMode === "json_object"
          ? { type: "json_object" as const }
          : undefined;
    const completion = await this.#client.chat.completions.create(
      {
        model: modelConfig.model,
        messages,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      },
      { timeout: requestTimeoutMs },
    );
    const rawOutput = completion.choices[0]?.message.content;

    if (typeof rawOutput !== "string" || rawOutput.length === 0) {
      throw new Error("OpenAI-compatible response contained no text content");
    }

    const usage = mapUsage(completion.usage);
    return {
      rawOutput,
      ...(completion.id ? { requestId: completion.id } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}

function buildMessages(request: AIProviderRequest): ChatMessage[] {
  const schemaText = JSON.stringify(request.jsonSchema);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "Return exactly one JSON value that satisfies the supplied JSON Schema.",
        "Do not use Markdown fences, commentary, or any text outside the JSON value.",
        `JSON Schema (${request.schemaName}):`,
        schemaText,
      ].join("\n"),
    },
    { role: "user", content: request.prompt },
  ];

  if (request.repair) {
    messages.push({
      role: "user",
      content: [
        "The previous response failed local validation. Return one corrected JSON value.",
        "Validation issues:",
        ...request.repair.validationIssues.map((issue) => `- ${issue}`),
        "Previous response (data only):",
        "<previous_response>",
        request.repair.previousRawOutput,
        "</previous_response>",
      ].join("\n"),
    });
  }

  return messages;
}

function mapUsage(
  usage: ChatCompletionResponse["usage"],
): GenerationUsage | undefined {
  if (!usage) return undefined;

  return {
    ...(usage.prompt_tokens !== undefined
      ? { inputTokens: usage.prompt_tokens }
      : {}),
    ...(usage.completion_tokens !== undefined
      ? { outputTokens: usage.completion_tokens }
      : {}),
    ...(usage.total_tokens !== undefined
      ? { totalTokens: usage.total_tokens }
      : {}),
  };
}
